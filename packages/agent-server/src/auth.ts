import { randomBytes } from "node:crypto";
import {
	buildAuthorizeUrl,
	exchangeCodeForToken,
	generatePkcePair,
	generateState,
	PROFILES,
	type ProfileName,
	refreshAccessToken,
	type TokenResponse,
} from "hiworks-browser-auth";
import { AgentServerError } from "./errors.ts";

export const HIWORKS_SESSION_COOKIE = "pi_agent_session";
export const HIWORKS_STATE_COOKIE = "pi_agent_oauth_state";

export interface AgentPrincipal {
	readonly id: string;
	readonly source: "hiworks" | "server_token" | "anonymous";
	readonly profile?: ProfileName;
	readonly email?: string;
	readonly displayName?: string;
	readonly admin: boolean;
}

export interface HiworksLoginStart {
	readonly location: string;
	readonly setCookie: string;
}

export interface HiworksLoginCompletion {
	readonly principal: AgentPrincipal;
	readonly setCookies: readonly string[];
}

export interface AgentAuthService {
	readonly callbackPath: string;
	authenticate(cookieHeader?: string): Promise<AgentPrincipal | undefined>;
	startLogin(): HiworksLoginStart;
	completeLogin(callbackUrl: URL, cookieHeader?: string): Promise<HiworksLoginCompletion>;
	logout(cookieHeader?: string): string;
}

export interface HiworksAuthServiceOptions {
	profile: ProfileName;
	publicBaseUrl: string;
	redirectUri?: string;
	callbackPath: string;
	scope: string;
	clientId?: string;
	clientSecret?: string;
	sessionTtlMs: number;
	pendingTtlMs: number;
	refreshSkewMs?: number;
	exchangeCodeForToken?: typeof exchangeCodeForToken;
	refreshAccessToken?: typeof refreshAccessToken;
	fetchMe?: (accessToken: string, meUrl: string) => Promise<unknown>;
	now?: () => number;
}

interface PendingLogin {
	readonly codeVerifier: string;
	readonly createdAt: number;
}

interface AuthSession {
	readonly principal: AgentPrincipal;
	tokens: TokenResponse;
	obtainedAt: number;
	readonly expiresAt: number;
	refreshing?: Promise<void>;
}

export class HiworksAuthFlowError extends AgentServerError {
	constructor(code: string, statusCode: number, message: string) {
		super(code, statusCode, message);
		this.name = "HiworksAuthFlowError";
	}
}

/** Remote-safe Hiworks OAuth flow with opaque, in-memory server sessions. */
export class HiworksAuthService implements AgentAuthService {
	readonly #profile: ProfileName;
	readonly #authorizeUrl: string;
	readonly #tokenUrl: string;
	readonly #meUrl: string;
	readonly #clientId: string;
	readonly #clientSecret: string | undefined;
	readonly #scope: string;
	readonly #callbackUrl: URL;
	readonly redirectUri: string;
	readonly callbackPath: string;
	readonly #sessionTtlMs: number;
	readonly #pendingTtlMs: number;
	readonly #refreshSkewMs: number;
	readonly #exchange: typeof exchangeCodeForToken;
	readonly #refresh: typeof refreshAccessToken;
	readonly #fetchMe: (accessToken: string, meUrl: string) => Promise<unknown>;
	readonly #now: () => number;
	readonly #secureCookies: boolean;
	readonly #pending = new Map<string, PendingLogin>();
	readonly #sessions = new Map<string, AuthSession>();

	constructor(options: HiworksAuthServiceOptions) {
		const profile = PROFILES[options.profile];
		if (!profile) throw new Error(`Unknown Hiworks profile: ${options.profile}`);
		if (options.scope.trim().length === 0) throw new Error("Hiworks OAuth scope must not be empty");
		if (!Number.isSafeInteger(options.sessionTtlMs) || options.sessionTtlMs < 1) {
			throw new Error("Hiworks sessionTtlMs must be a positive integer");
		}
		if (!Number.isSafeInteger(options.pendingTtlMs) || options.pendingTtlMs < 1) {
			throw new Error("Hiworks pendingTtlMs must be a positive integer");
		}
		if (
			!options.callbackPath.startsWith("/") ||
			options.callbackPath.includes("?") ||
			options.callbackPath.includes("#")
		) {
			throw new Error("Hiworks callbackPath must be an absolute path without a query or fragment");
		}

		const publicBaseUrl = parsePublicBaseUrl(options.publicBaseUrl);
		this.#callbackUrl = options.redirectUri
			? parseRedirectUri(options.redirectUri, options.callbackPath)
			: new URL(options.callbackPath, `${publicBaseUrl}/`);
		this.redirectUri = this.#callbackUrl.toString();
		this.callbackPath = options.callbackPath;
		this.#secureCookies = this.#callbackUrl.protocol === "https:";
		this.#profile = options.profile;
		this.#authorizeUrl = profile.endpoints.authorizeUrl;
		this.#tokenUrl = profile.endpoints.tokenUrl;
		this.#meUrl =
			profile.endpoints.meUrl ??
			(() => {
				throw new Error(`Hiworks profile ${options.profile} does not define a /me endpoint`);
			})();
		this.#clientId = options.clientId ?? profile.clientId;
		this.#clientSecret = options.clientSecret;
		this.#scope = options.scope;
		this.#sessionTtlMs = options.sessionTtlMs;
		this.#pendingTtlMs = options.pendingTtlMs;
		this.#refreshSkewMs = options.refreshSkewMs ?? 60_000;
		this.#exchange = options.exchangeCodeForToken ?? exchangeCodeForToken;
		this.#refresh = options.refreshAccessToken ?? refreshAccessToken;
		this.#fetchMe = options.fetchMe ?? fetchHiworksMe;
		this.#now = options.now ?? Date.now;
	}

	startLogin(): HiworksLoginStart {
		this.#prune();
		const state = generateState();
		const pkce = generatePkcePair();
		this.#pending.set(state, { codeVerifier: pkce.verifier, createdAt: this.#now() });
		const location = buildAuthorizeUrl({
			authorizeUrl: this.#authorizeUrl,
			clientId: this.#clientId,
			redirectUri: this.redirectUri,
			scope: this.#scope,
			state,
			codeChallenge: pkce.challenge,
			codeChallengeMethod: pkce.method,
		});
		return {
			location,
			setCookie: serializeCookie(HIWORKS_STATE_COOKIE, state, this.#pendingTtlMs, this.#secureCookies),
		};
	}

	async completeLogin(callbackUrl: URL, cookieHeader?: string): Promise<HiworksLoginCompletion> {
		if (callbackUrl.pathname !== this.callbackPath) {
			throw new HiworksAuthFlowError("invalid_callback", 400, "Invalid OAuth callback path");
		}
		this.#prune();
		const state = callbackUrl.searchParams.get("state");
		const cookieState = readCookie(cookieHeader, HIWORKS_STATE_COOKIE);
		if (!state || !cookieState || state !== cookieState) {
			throw new HiworksAuthFlowError("invalid_oauth_state", 400, "OAuth state validation failed");
		}
		const pending = this.#pending.get(state);
		if (!pending) throw new HiworksAuthFlowError("expired_oauth_state", 400, "OAuth login has expired");
		this.#pending.delete(state);

		if (callbackUrl.searchParams.has("error")) {
			throw new HiworksAuthFlowError("oauth_denied", 400, "Hiworks login was not completed");
		}
		const code = callbackUrl.searchParams.get("code");
		if (!code)
			throw new HiworksAuthFlowError("missing_authorization_code", 400, "OAuth authorization code is missing");

		let tokens: TokenResponse;
		try {
			tokens = await this.#exchange({
				tokenUrl: this.#tokenUrl,
				code,
				redirectUri: this.redirectUri,
				clientId: this.#clientId,
				...(this.#clientSecret ? { clientSecret: this.#clientSecret } : {}),
				codeVerifier: pending.codeVerifier,
			});
		} catch {
			throw new HiworksAuthFlowError("oauth_exchange_failed", 502, "Hiworks authorization could not be completed");
		}

		let me: unknown;
		try {
			me = await this.#fetchMe(tokens.access_token, this.#meUrl);
		} catch {
			throw new HiworksAuthFlowError("hiworks_identity_failed", 502, "Hiworks identity could not be verified");
		}
		const principal = buildHiworksPrincipal(this.#profile, me);
		const sessionId = randomBytes(32).toString("base64url");
		const now = this.#now();
		this.#sessions.set(sessionId, {
			principal,
			tokens,
			obtainedAt: now,
			expiresAt: now + this.#sessionTtlMs,
		});

		return {
			principal,
			setCookies: [
				serializeCookie(HIWORKS_SESSION_COOKIE, sessionId, this.#sessionTtlMs, this.#secureCookies),
				clearCookie(HIWORKS_STATE_COOKIE, this.#secureCookies),
			],
		};
	}

	async authenticate(cookieHeader?: string): Promise<AgentPrincipal | undefined> {
		this.#prune();
		const sessionId = readCookie(cookieHeader, HIWORKS_SESSION_COOKIE);
		if (!sessionId) return undefined;
		const session = this.#sessions.get(sessionId);
		if (!session || this.#now() >= session.expiresAt) {
			this.#sessions.delete(sessionId);
			return undefined;
		}

		if (this.#tokenExpiresSoon(session)) {
			if (!session.tokens.refresh_token) {
				this.#sessions.delete(sessionId);
				return undefined;
			}
			try {
				await this.#refreshSession(session);
			} catch {
				this.#sessions.delete(sessionId);
				return undefined;
			}
		}
		return session.principal;
	}

	logout(cookieHeader?: string): string {
		const sessionId = readCookie(cookieHeader, HIWORKS_SESSION_COOKIE);
		if (sessionId) this.#sessions.delete(sessionId);
		return clearCookie(HIWORKS_SESSION_COOKIE, this.#secureCookies);
	}

	#tokenExpiresSoon(session: AuthSession): boolean {
		return this.#now() >= session.obtainedAt + session.tokens.expires_in * 1000 - this.#refreshSkewMs;
	}

	#refreshSession(session: AuthSession): Promise<void> {
		if (session.refreshing) return session.refreshing;
		const refreshToken = session.tokens.refresh_token;
		if (!refreshToken) return Promise.reject(new Error("Hiworks session has no refresh token"));
		const refreshing = (async (): Promise<void> => {
			const next = await this.#refresh({
				tokenUrl: this.#tokenUrl,
				refreshToken,
				clientId: this.#clientId,
				...(this.#clientSecret ? { clientSecret: this.#clientSecret } : {}),
				scope: this.#scope,
			});
			session.tokens = { ...session.tokens, ...next };
			session.obtainedAt = this.#now();
		})();
		let tracked: Promise<void>;
		tracked = refreshing.finally(() => {
			if (session.refreshing === tracked) session.refreshing = undefined;
		});
		session.refreshing = tracked;
		return tracked;
	}

	#prune(): void {
		const now = this.#now();
		for (const [state, pending] of this.#pending) {
			if (now >= pending.createdAt + this.#pendingTtlMs) this.#pending.delete(state);
		}
		for (const [sessionId, session] of this.#sessions) {
			if (now >= session.expiresAt) this.#sessions.delete(sessionId);
		}
	}
}

async function fetchHiworksMe(accessToken: string, meUrl: string): Promise<unknown> {
	const response = await fetch(meUrl, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
	});
	if (!response.ok) throw new Error(`Hiworks /me returned HTTP ${response.status}`);
	return (await response.json()) as unknown;
}

function buildHiworksPrincipal(profile: ProfileName, me: unknown): AgentPrincipal {
	const stableIdentity = findString(me, [
		"user_no",
		"userNo",
		"office_user_no",
		"officeUserNo",
		"master_user_no",
		"masterUserNo",
		"user_id",
		"userId",
		"member_id",
		"memberId",
		"account_id",
		"accountId",
		"account_no",
		"accountNo",
		"login_id",
		"loginId",
	]);
	const identity = stableIdentity ?? findString(me, ["email", "mail", "id"]);
	if (!identity)
		throw new HiworksAuthFlowError("invalid_hiworks_identity", 502, "Hiworks identity response is invalid");
	const email = findString(me, ["email", "mail", "email_address", "emailAddress"]);
	const displayName = findString(me, ["display_name", "displayName", "user_name", "userName", "name", "nickname"]);
	return {
		id: `hiworks:${profile}:${identity}`,
		source: "hiworks",
		profile,
		...(email ? { email } : {}),
		...(displayName ? { displayName } : {}),
		admin: false,
	};
}

function findString(value: unknown, keys: readonly string[]): string | undefined {
	if (!isRecord(value)) return undefined;
	for (const key of keys) {
		const found = findKeyString(value, key);
		if (found) return found;
	}
	return undefined;
}

function findKeyString(value: Record<string, unknown>, key: string): string | undefined {
	const direct = scalarString(value[key]);
	if (direct) return direct;
	for (const nestedKey of ["data", "user", "member", "account", "profile", "result"]) {
		const nested = value[nestedKey];
		if (!isRecord(nested)) continue;
		const found = findKeyString(nested, key);
		if (found) return found;
	}
	return undefined;
}

function scalarString(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePublicBaseUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Hiworks publicBaseUrl must be a valid HTTP(S) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Hiworks publicBaseUrl must use http or https");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("Hiworks publicBaseUrl must not contain credentials, query, or fragment");
	}
	return parsed.toString().replace(/\/$/u, "");
}

function parseRedirectUri(value: string, callbackPath: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Hiworks redirectUri must be a valid HTTP(S) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Hiworks redirectUri must use http or https");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("Hiworks redirectUri must not contain credentials, query, or fragment");
	}
	if (parsed.pathname !== callbackPath) throw new Error("Hiworks redirectUri pathname must match callbackPath");
	return parsed;
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
