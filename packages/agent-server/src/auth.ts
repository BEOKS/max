import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
	AuthEvent,
	AuthOperationOptions,
	AuthPrompt,
	Credential,
	CredentialInfo,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
} from "@earendil-works/pi-ai";
import { AgentServerError } from "./errors.ts";

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1_000;
const CODEX_PROVIDER_ID = "openai-codex";
const DEVICE_LOGIN_COOKIE = "pi_agent_device_login";
const MAX_ACCOUNT_ID_LENGTH = 512;

export const AGENT_SESSION_COOKIE = "pi_agent_session";
export { CODEX_PROVIDER_ID, DEVICE_LOGIN_COOKIE };

export interface AgentPrincipal {
	readonly id: string;
	readonly source: "codex" | "server_token" | "anonymous";
	readonly accountId?: string;
	readonly email?: string;
	readonly displayName?: string;
	readonly admin: boolean;
}

export interface AgentAuthService {
	authenticate(cookieHeader?: string): Promise<AgentPrincipal | undefined>;
	logout(cookieHeader?: string): Promise<readonly string[]>;
}

export interface AgentDeviceAuthService extends AgentAuthService {
	startDeviceLogin(): Promise<DeviceLoginStart>;
	getDeviceLoginStatus(loginId: string, cookieHeader?: string): Promise<DeviceLoginStatus>;
	cancelDeviceLogin(loginId: string, cookieHeader?: string): Promise<readonly string[]>;
	credentialStoreFor(ownerId: string, fallback?: CredentialStore): CredentialStore;
}

export interface DeviceLoginStart {
	readonly loginId: string;
	readonly userCode: string;
	readonly verificationUri: string;
	readonly intervalSeconds?: number;
	readonly expiresAt: number;
	readonly setCookie: string;
}

export type DeviceLoginStatus =
	| {
			readonly status: "pending";
			readonly loginId: string;
			readonly userCode: string;
			readonly verificationUri: string;
			readonly intervalSeconds?: number;
			readonly expiresAt: number;
	  }
	| {
			readonly status: "complete";
			readonly loginId: string;
			readonly user: AgentPrincipal;
			readonly setCookies: readonly string[];
	  }
	| {
			readonly status: "failed";
			readonly loginId: string;
			readonly error: string;
	  };

export interface CodexDeviceAuthServiceOptions {
	authFile: string;
	oauth: OAuthAuth;
	sessionTtlMs?: number;
	pendingTtlMs?: number;
	secureCookies?: boolean;
	now?: () => number;
}

interface StoredCodexUser {
	readonly id: string;
	readonly accountId: string;
	readonly email?: string;
	readonly displayName?: string;
	readonly credential?: OAuthCredential;
	readonly createdAt: string;
	readonly updatedAt: string;
}

interface StoredSession {
	readonly id: string;
	readonly userId: string;
	readonly expiresAt: number;
}

interface StoredAuthState {
	readonly version: 1;
	readonly users: readonly StoredCodexUser[];
	readonly sessions: readonly StoredSession[];
}

interface PendingDeviceLogin {
	readonly id: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly controller: AbortController;
	readonly deviceReady: Promise<DeviceCodeInfo>;
	resolveDevice: ((value: DeviceCodeInfo) => void) | undefined;
	rejectDevice: ((error: Error) => void) | undefined;
	device?: DeviceCodeInfo;
	status: "pending" | "complete" | "failed";
	error?: string;
	principal?: AgentPrincipal;
	sessionCookie?: string;
}

interface DeviceCodeInfo {
	readonly userCode: string;
	readonly verificationUri: string;
	readonly intervalSeconds?: number;
	readonly expiresInSeconds?: number;
}

export class CodexAuthError extends AgentServerError {
	constructor(code: string, statusCode: number, message: string) {
		super(code, statusCode, message);
		this.name = "CodexAuthError";
	}
}

/** Codex device-code authentication with persistent users and opaque sessions. */
export class CodexDeviceAuthService implements AgentDeviceAuthService {
	readonly #authFile: string;
	readonly #oauth: OAuthAuth;
	readonly #sessionTtlMs: number;
	readonly #pendingTtlMs: number;
	readonly #secureCookies: boolean;
	readonly #now: () => number;
	readonly #users = new Map<string, StoredCodexUser>();
	readonly #sessions = new Map<string, StoredSession>();
	readonly #pending = new Map<string, PendingDeviceLogin>();
	#loaded: Promise<void> | undefined;
	#saveQueue: Promise<void> = Promise.resolve();

	constructor(options: CodexDeviceAuthServiceOptions) {
		this.#authFile = resolveAuthPath(options.authFile);
		this.#oauth = options.oauth;
		this.#sessionTtlMs = positiveInteger(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, "sessionTtlMs");
		this.#pendingTtlMs = positiveInteger(options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS, "pendingTtlMs");
		this.#secureCookies = options.secureCookies ?? false;
		this.#now = options.now ?? Date.now;
	}

	async initialize(): Promise<void> {
		await this.#ensureLoaded();
	}

	async startDeviceLogin(): Promise<DeviceLoginStart> {
		await this.#ensureLoaded();
		this.#prunePending();
		const id = randomBytes(32).toString("base64url");
		const controller = new AbortController();
		let resolveDevice: ((value: DeviceCodeInfo) => void) | undefined;
		let rejectDevice: ((error: Error) => void) | undefined;
		const deviceReady = new Promise<DeviceCodeInfo>((resolvePromise, rejectPromise) => {
			resolveDevice = resolvePromise;
			rejectDevice = rejectPromise;
		});
		const pending: PendingDeviceLogin = {
			id,
			createdAt: this.#now(),
			expiresAt: this.#now() + this.#pendingTtlMs,
			controller,
			deviceReady,
			resolveDevice,
			rejectDevice,
			status: "pending",
		};
		this.#pending.set(id, pending);
		void this.#runDeviceLogin(pending);

		try {
			const device = await deviceReady;
			return {
				loginId: id,
				userCode: device.userCode,
				verificationUri: device.verificationUri,
				...(device.intervalSeconds === undefined ? {} : { intervalSeconds: device.intervalSeconds }),
				expiresAt: pending.expiresAt,
				setCookie: serializeCookie(DEVICE_LOGIN_COOKIE, id, this.#pendingTtlMs, this.#secureCookies),
			};
		} catch (error) {
			this.#pending.delete(id);
			controller.abort();
			throw new CodexAuthError("codex_login_failed", 502, loginErrorMessage(error));
		}
	}

	async getDeviceLoginStatus(loginId: string, cookieHeader?: string): Promise<DeviceLoginStatus> {
		await this.#ensureLoaded();
		const pending = this.#requirePending(loginId, cookieHeader);
		if (pending.status === "pending" && this.#now() >= pending.expiresAt) {
			this.#failPending(pending, "Device-code login expired");
		}
		if (pending.status === "pending") {
			if (!pending.device) throw new CodexAuthError("login_not_ready", 409, "Device-code login is not ready");
			return {
				status: "pending",
				loginId: pending.id,
				userCode: pending.device.userCode,
				verificationUri: pending.device.verificationUri,
				...(pending.device.intervalSeconds === undefined
					? {}
					: { intervalSeconds: pending.device.intervalSeconds }),
				expiresAt: pending.expiresAt,
			};
		}
		if (pending.status === "failed") {
			return { status: "failed", loginId: pending.id, error: pending.error ?? "Codex login failed" };
		}
		if (!pending.principal || !pending.sessionCookie) {
			throw new CodexAuthError("login_incomplete", 500, "Codex login completed without a session");
		}
		return {
			status: "complete",
			loginId: pending.id,
			user: pending.principal,
			setCookies: [pending.sessionCookie, clearCookie(DEVICE_LOGIN_COOKIE, this.#secureCookies)],
		};
	}

	async cancelDeviceLogin(loginId: string, cookieHeader?: string): Promise<readonly string[]> {
		await this.#ensureLoaded();
		const pending = this.#requirePending(loginId, cookieHeader);
		pending.controller.abort();
		this.#pending.delete(loginId);
		return [clearCookie(DEVICE_LOGIN_COOKIE, this.#secureCookies)];
	}

	async authenticate(cookieHeader?: string): Promise<AgentPrincipal | undefined> {
		await this.#ensureLoaded();
		const sessionId = readCookie(cookieHeader, AGENT_SESSION_COOKIE);
		if (!sessionId) return undefined;
		const session = this.#sessions.get(sessionId);
		if (!session) return undefined;
		if (this.#now() >= session.expiresAt) {
			this.#sessions.delete(sessionId);
			await this.#saveState();
			return undefined;
		}
		const user = this.#users.get(session.userId);
		return user ? toPrincipal(user) : undefined;
	}

	async logout(cookieHeader?: string): Promise<readonly string[]> {
		await this.#ensureLoaded();
		let changed = false;
		const sessionId = readCookie(cookieHeader, AGENT_SESSION_COOKIE);
		if (sessionId && this.#sessions.delete(sessionId)) changed = true;
		const loginId = readCookie(cookieHeader, DEVICE_LOGIN_COOKIE);
		if (loginId) {
			const pending = this.#pending.get(loginId);
			if (pending) {
				pending.controller.abort();
				this.#pending.delete(loginId);
			}
		}
		if (changed) await this.#saveState();
		return [
			clearCookie(AGENT_SESSION_COOKIE, this.#secureCookies),
			clearCookie(DEVICE_LOGIN_COOKIE, this.#secureCookies),
		];
	}

	credentialStoreFor(ownerId: string, fallback?: CredentialStore): CredentialStore {
		return new UserCredentialStore(this, ownerId, fallback);
	}

	async #runDeviceLogin(pending: PendingDeviceLogin): Promise<void> {
		try {
			const credential = await this.#oauth.login({
				signal: pending.controller.signal,
				prompt: deviceCodePrompt,
				notify: (event) => this.#handleAuthEvent(pending, event),
			});
			await this.#completePending(pending, credential);
		} catch (error) {
			if (pending.status === "pending") {
				this.#failPending(pending, loginErrorMessage(error));
			}
		}
	}

	#handleAuthEvent(pending: PendingDeviceLogin, event: AuthEvent): void {
		if (event.type !== "device_code" || pending.status !== "pending") return;
		const device: DeviceCodeInfo = {
			userCode: event.userCode,
			verificationUri: event.verificationUri,
			...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
			...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
		};
		pending.device = device;
		pending.resolveDevice?.(device);
	}

	async #completePending(pending: PendingDeviceLogin, credential: OAuthCredential): Promise<void> {
		if (pending.status !== "pending") return;
		const accountId = credentialString(credential, "accountId");
		if (!accountId || accountId.length > MAX_ACCOUNT_ID_LENGTH) {
			throw new Error("Codex login did not return a valid account ID");
		}
		const userId = `codex:${accountId}`;
		const now = new Date(this.#now()).toISOString();
		const previous = this.#users.get(userId);
		const user: StoredCodexUser = {
			id: userId,
			accountId,
			...(credentialString(credential, "email") ? { email: credentialString(credential, "email") } : {}),
			...(credentialString(credential, "displayName")
				? { displayName: credentialString(credential, "displayName") }
				: {}),
			credential,
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
		};
		this.#users.set(userId, user);
		const sessionId = randomBytes(32).toString("base64url");
		this.#sessions.set(sessionId, {
			id: sessionId,
			userId,
			expiresAt: this.#now() + this.#sessionTtlMs,
		});
		await this.#saveState();
		pending.principal = toPrincipal(user);
		pending.sessionCookie = serializeCookie(AGENT_SESSION_COOKIE, sessionId, this.#sessionTtlMs, this.#secureCookies);
		pending.status = "complete";
	}

	async readUserCredential(
		ownerId: string,
		providerId: string,
		options?: AuthOperationOptions,
	): Promise<OAuthCredential | undefined> {
		if (providerId !== CODEX_PROVIDER_ID) return undefined;
		options?.signal?.throwIfAborted();
		await this.#ensureLoaded();
		options?.signal?.throwIfAborted();
		return this.#users.get(ownerId)?.credential;
	}

	async modifyUserCredential(
		ownerId: string,
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		signal?: AbortSignal,
	): Promise<Credential | undefined> {
		if (providerId !== CODEX_PROVIDER_ID) return undefined;
		signal?.throwIfAborted();
		await this.#ensureLoaded();
		const user = this.#users.get(ownerId);
		if (!user) return undefined;
		const next = await fn(user.credential);
		signal?.throwIfAborted();
		if (next === undefined) return user.credential;
		if (!isOAuthCredential(next)) throw new Error("Codex credential store accepts OAuth credentials only");
		this.#users.set(ownerId, { ...user, credential: next, updatedAt: new Date(this.#now()).toISOString() });
		await this.#saveState();
		return next;
	}

	async deleteUserCredential(ownerId: string, providerId: string, signal?: AbortSignal): Promise<void> {
		if (providerId !== CODEX_PROVIDER_ID) return;
		signal?.throwIfAborted();
		await this.#ensureLoaded();
		const user = this.#users.get(ownerId);
		if (!user?.credential) return;
		this.#users.set(ownerId, { ...user, credential: undefined, updatedAt: new Date(this.#now()).toISOString() });
		await this.#saveState();
	}

	async listUserCredentials(ownerId: string, options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credential = await this.readUserCredential(ownerId, CODEX_PROVIDER_ID, options);
		return credential ? [{ providerId: CODEX_PROVIDER_ID, type: credential.type }] : [];
	}

	#requirePending(loginId: string, cookieHeader?: string): PendingDeviceLogin {
		if (!loginId || readCookie(cookieHeader, DEVICE_LOGIN_COOKIE) !== loginId) {
			throw new CodexAuthError("invalid_device_login", 404, "Device-code login was not found");
		}
		const pending = this.#pending.get(loginId);
		if (!pending) throw new CodexAuthError("expired_device_login", 410, "Device-code login has expired");
		return pending;
	}

	#failPending(pending: PendingDeviceLogin, message: string): void {
		if (pending.status !== "pending") return;
		pending.status = "failed";
		pending.error = message;
		pending.controller.abort();
		pending.rejectDevice?.(new Error(message));
	}

	#prunePending(): void {
		const now = this.#now();
		for (const [id, pending] of this.#pending) {
			if (now < pending.expiresAt) continue;
			if (pending.status === "pending") this.#failPending(pending, "Device-code login expired");
			if (now >= pending.expiresAt + this.#pendingTtlMs) this.#pending.delete(id);
		}
	}

	async #ensureLoaded(): Promise<void> {
		if (!this.#loaded) this.#loaded = this.#loadState();
		await this.#loaded;
	}

	async #loadState(): Promise<void> {
		let content: string;
		try {
			content = await readFile(this.#authFile, "utf8");
		} catch (error) {
			if (isFileNotFoundError(error)) return;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(content) as unknown;
		} catch {
			throw new Error(`Invalid JSON in ${this.#authFile}`);
		}
		const state = parseAuthState(parsed);
		for (const user of state.users) {
			if (this.#users.has(user.id)) throw new Error(`Duplicate Codex user in ${this.#authFile}`);
			this.#users.set(user.id, user);
		}
		for (const session of state.sessions) {
			if (this.#sessions.has(session.id)) throw new Error(`Duplicate auth session in ${this.#authFile}`);
			this.#sessions.set(session.id, session);
		}
	}

	#serializeState(): StoredAuthState {
		return {
			version: 1,
			users: [...this.#users.values()],
			sessions: [...this.#sessions.values()],
		};
	}

	#saveState(): Promise<void> {
		const write = this.#saveQueue.then(async () => {
			await mkdir(dirname(this.#authFile), { recursive: true, mode: 0o700 });
			const temporaryPath = `${this.#authFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
			try {
				await writeFile(temporaryPath, `${JSON.stringify(this.#serializeState(), null, 2)}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});
				await rename(temporaryPath, this.#authFile);
			} finally {
				await unlink(temporaryPath).catch(() => {});
			}
		});
		this.#saveQueue = write.catch(() => {});
		return write;
	}
}

class UserCredentialStore implements CredentialStore {
	readonly #auth: CodexDeviceAuthService;
	readonly #ownerId: string;
	readonly #fallback: CredentialStore | undefined;

	constructor(auth: CodexDeviceAuthService, ownerId: string, fallback?: CredentialStore) {
		this.#auth = auth;
		this.#ownerId = ownerId;
		this.#fallback = fallback;
	}

	read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		if (providerId === CODEX_PROVIDER_ID) return this.#auth.readUserCredential(this.#ownerId, providerId, options);
		return this.#fallback?.read(providerId, options) ?? Promise.resolve(undefined);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const fallback = (await this.#fallback?.list(options)) ?? [];
		const entries = new Map(fallback.map((entry) => [entry.providerId, entry]));
		entries.delete(CODEX_PROVIDER_ID);
		for (const entry of await this.#auth.listUserCredentials(this.#ownerId, options))
			entries.set(entry.providerId, entry);
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		if (providerId === CODEX_PROVIDER_ID) {
			return this.#auth.modifyUserCredential(this.#ownerId, providerId, fn, options?.signal);
		}
		return this.#fallback?.modify(providerId, fn, options) ?? Promise.resolve(undefined);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		if (providerId === CODEX_PROVIDER_ID)
			return this.#auth.deleteUserCredential(this.#ownerId, providerId, options?.signal);
		return this.#fallback?.delete(providerId, options) ?? Promise.resolve();
	}
}

const deviceCodePrompt = async (prompt: AuthPrompt): Promise<string> => {
	if (prompt.type === "select") return "device_code";
	throw new Error("Codex device-code login does not accept interactive input");
};

function toPrincipal(user: StoredCodexUser): AgentPrincipal {
	return {
		id: user.id,
		source: "codex",
		accountId: user.accountId,
		...(user.email ? { email: user.email } : {}),
		...(user.displayName ? { displayName: user.displayName } : {}),
		admin: false,
	};
}

function parseAuthState(value: unknown): StoredAuthState {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.users) || !Array.isArray(value.sessions)) {
		throw new Error("Codex auth file must contain version 1, users, and sessions");
	}
	return {
		version: 1,
		users: value.users.map(parseStoredUser),
		sessions: value.sessions.map(parseStoredSession),
	};
}

function parseStoredUser(value: unknown): StoredCodexUser {
	if (!isRecord(value)) throw new Error("Codex auth user must be an object");
	const id = storedString(value.id, "id");
	const accountId = storedString(value.accountId, "accountId");
	const createdAt = storedString(value.createdAt, "createdAt");
	const updatedAt = storedString(value.updatedAt, "updatedAt");
	if (value.email !== undefined && typeof value.email !== "string")
		throw new Error("Codex auth email must be a string");
	if (value.displayName !== undefined && typeof value.displayName !== "string") {
		throw new Error("Codex auth displayName must be a string");
	}
	if (value.credential !== undefined && !isOAuthCredential(value.credential)) {
		throw new Error("Codex auth credential must be an OAuth credential");
	}
	return {
		id,
		accountId,
		...(value.email ? { email: value.email } : {}),
		...(value.displayName ? { displayName: value.displayName } : {}),
		...(value.credential ? { credential: value.credential } : {}),
		createdAt,
		updatedAt,
	};
}

function parseStoredSession(value: unknown): StoredSession {
	if (!isRecord(value)) throw new Error("Auth session must be an object");
	const id = storedString(value.id, "id");
	const userId = storedString(value.userId, "userId");
	if (typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) {
		throw new Error("Auth session expiresAt must be a positive integer");
	}
	return { id, userId, expiresAt: value.expiresAt };
}

function isOAuthCredential(value: unknown): value is OAuthCredential {
	return (
		isRecord(value) &&
		value.type === "oauth" &&
		typeof value.access === "string" &&
		value.access.length > 0 &&
		typeof value.refresh === "string" &&
		value.refresh.length > 0 &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

function credentialString(credential: OAuthCredential, field: string): string | undefined {
	const value = credential[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function storedString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`Codex auth ${field} must be a non-empty string`);
	return value;
}

function positiveInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Codex auth ${field} must be a positive integer`);
	return value;
}

function loginErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

function resolveAuthPath(path: string): string {
	const expanded = path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path;
	return resolve(expanded);
}

function readCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		const rawValue = part.slice(separator + 1).trim();
		try {
			return decodeURIComponent(rawValue);
		} catch {
			return rawValue;
		}
	}
	return undefined;
}

function serializeCookie(name: string, value: string, maxAgeMs: number, secure: boolean): string {
	const attributes = [
		`${name}=${encodeURIComponent(value)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${Math.max(1, Math.ceil(maxAgeMs / 1000))}`,
	];
	if (secure) attributes.push("Secure");
	return attributes.join("; ");
}

function clearCookie(name: string, secure: boolean): string {
	const attributes = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
	if (secure) attributes.push("Secure");
	return attributes.join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
