import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { CODEX_PROVIDER_ID, CodexDeviceAuthService, DEVICE_LOGIN_COOKIE, type DeviceLoginStatus } from "../src/auth.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
	temporaryDirectories.length = 0;
});

describe("CodexDeviceAuthService", () => {
	test("starts device login, persists the account, and restores the session", async () => {
		const directory = await makeTemporaryDirectory();
		const oauth = new FakeCodexOAuth();
		const authFile = join(directory, "codex-auth.json");
		const auth = new CodexDeviceAuthService({ authFile, oauth, secureCookies: true });

		const start = await auth.startDeviceLogin();
		expect(start.userCode).toBe("ABCD-1234");
		expect(start.verificationUri).toBe("https://auth.openai.com/codex/device");
		expect(start.setCookie).toContain(`${DEVICE_LOGIN_COOKIE}=`);

		const pending = await auth.getDeviceLoginStatus(start.loginId, start.setCookie);
		expect(pending).toMatchObject({ status: "pending", loginId: start.loginId, userCode: "ABCD-1234" });

		oauth.complete();
		const completed = await waitForCompleted(auth, start.loginId, start.setCookie);
		expect(completed.user).toEqual({
			id: "codex:account-123",
			source: "codex",
			accountId: "account-123",
			email: "user@example.com",
			displayName: "Codex User",
			admin: false,
		});
		expect(completed.setCookies[0]).toContain("pi_agent_session=");

		const sessionCookie = completed.setCookies[0];
		expect(await auth.authenticate(sessionCookie)).toEqual(completed.user);
		const credentialStore = auth.credentialStoreFor(completed.user.id);
		expect(await credentialStore.read(CODEX_PROVIDER_ID)).toMatchObject({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
		});

		const stored = await readFile(authFile, "utf8");
		expect(stored).toContain("refresh-token");
		expect(stored).not.toContain("ABCD-1234");

		const restarted = new CodexDeviceAuthService({ authFile, oauth });
		await restarted.initialize();
		expect(await restarted.authenticate(sessionCookie)).toEqual(completed.user);
		expect(await restarted.credentialStoreFor(completed.user.id).read(CODEX_PROVIDER_ID)).toMatchObject({
			access: "access-token",
		});

		const logoutCookies = await restarted.logout(sessionCookie);
		expect(logoutCookies[0]).toContain("Max-Age=0");
		expect(await restarted.authenticate(sessionCookie)).toBeUndefined();
	});

	test("binds device status to its login cookie and isolates credentials by account", async () => {
		const directory = await makeTemporaryDirectory();
		const oauth = new FakeCodexOAuth();
		const auth = new CodexDeviceAuthService({ authFile: join(directory, "codex-auth.json"), oauth });
		const start = await auth.startDeviceLogin();

		await expect(auth.getDeviceLoginStatus(start.loginId, "pi_agent_device_login=wrong")).rejects.toMatchObject({
			code: "invalid_device_login",
			statusCode: 404,
		});

		oauth.complete();
		const completed = await waitForCompleted(auth, start.loginId, start.setCookie);
		const store = auth.credentialStoreFor(completed.user.id);
		expect(await store.read(CODEX_PROVIDER_ID)).toBeDefined();
		expect(await auth.credentialStoreFor("codex:another-account").read(CODEX_PROVIDER_ID)).toBeUndefined();
	});

	test("expires persistent sessions", async () => {
		let now = 1_000;
		const directory = await makeTemporaryDirectory();
		const oauth = new FakeCodexOAuth();
		const auth = new CodexDeviceAuthService({
			authFile: join(directory, "codex-auth.json"),
			oauth,
			sessionTtlMs: 100,
			now: () => now,
		});
		const start = await auth.startDeviceLogin();
		oauth.complete();
		const completed = await waitForCompleted(auth, start.loginId, start.setCookie);

		now += 101;
		expect(await auth.authenticate(completed.setCookies[0])).toBeUndefined();
	});
});

class FakeCodexOAuth implements OAuthAuth {
	readonly name = "Fake Codex";
	readonly isSubscription = true;
	#resolve: ((credential: OAuthCredential) => void) | undefined;

	async login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
		interaction.notify({
			type: "device_code",
			userCode: "ABCD-1234",
			verificationUri: "https://auth.openai.com/codex/device",
			intervalSeconds: 1,
			expiresInSeconds: 900,
		});
		return new Promise<OAuthCredential>((resolve, reject) => {
			this.#resolve = resolve;
			interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
		});
	}

	async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
		return credential;
	}

	async toAuth(credential: OAuthCredential): Promise<{ apiKey: string }> {
		return { apiKey: credential.access };
	}

	complete(): void {
		this.#resolve?.({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 3_600_000,
			accountId: "account-123",
			email: "user@example.com",
			displayName: "Codex User",
		});
		this.#resolve = undefined;
	}
}

async function waitForCompleted(
	auth: CodexDeviceAuthService,
	loginId: string,
	cookie: string,
): Promise<Extract<DeviceLoginStatus, { status: "complete" }>> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const status = await auth.getDeviceLoginStatus(loginId, cookie);
		if (status.status === "complete") return status;
		if (status.status === "failed") throw new Error(status.error);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Timed out waiting for fake Codex login");
}

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-auth-test-"));
	temporaryDirectories.push(directory);
	return directory;
}
