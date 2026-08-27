import { PROFILES } from "hiworks-browser-auth";
import { describe, expect, test } from "vitest";
import { HiworksAuthService } from "../src/auth.ts";

describe("HiworksAuthService", () => {
	test("builds a PKCE login URL and isolates a browser session", async () => {
		let clock = 1_000_000;
		let refreshCalls = 0;
		const auth = new HiworksAuthService({
			profile: "gabia",
			publicBaseUrl: "https://agents.example.test",
			redirectUri: "https://agents.example.test/auth/hiworks/callback",
			callbackPath: "/auth/hiworks/callback",
			scope: "read",
			sessionTtlMs: 60_000,
			pendingTtlMs: 10_000,
			refreshSkewMs: 0,
			now: () => clock,
			exchangeCodeForToken: async (parameters) => {
				expect(parameters.code).toBe("authorization-code");
				expect(parameters.redirectUri).toBe("https://agents.example.test/auth/hiworks/callback");
				expect(parameters.codeVerifier).toBeTruthy();
				return {
					access_token: "access-token-1",
					token_type: "Bearer",
					expires_in: 30,
					refresh_token: "refresh-token-1",
				};
			},
			refreshAccessToken: async () => {
				refreshCalls += 1;
				return {
					access_token: "access-token-2",
					token_type: "Bearer",
					expires_in: 3_600,
				};
			},
			fetchMe: async (accessToken, meUrl) => {
				expect(accessToken).toBe("access-token-1");
				expect(meUrl).toBe("https://cache-api.gabiaoffice.hiworks.com/me");
				return { user_no: 1234, email: "user@example.com", name: "Test User" };
			},
		});

		const login = auth.startLogin();
		const authorizeUrl = new URL(login.location);
		expect(authorizeUrl.searchParams.get("client_id")).toBe(PROFILES.gabia.clientId);
		expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
		expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
		expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(login.setCookie).toContain("pi_agent_oauth_state=");
		expect(login.setCookie).toContain("HttpOnly");
		expect(login.setCookie).toContain("Secure");

		const state = authorizeUrl.searchParams.get("state");
		if (!state) throw new Error("Missing OAuth state");
		const completion = await auth.completeLogin(
			new URL(`https://agents.example.test/auth/hiworks/callback?code=authorization-code&state=${state}`),
			`pi_agent_oauth_state=${state}`,
		);
		expect(completion.principal).toEqual({
			id: "hiworks:gabia:1234",
			source: "hiworks",
			profile: "gabia",
			email: "user@example.com",
			displayName: "Test User",
			admin: false,
		});

		const sessionCookie = cookieValue(completion.setCookies[0], "pi_agent_session");
		expect(await auth.authenticate(`pi_agent_session=${sessionCookie}`)).toEqual(completion.principal);

		clock += 31_000;
		const [refreshedA, refreshedB] = await Promise.all([
			auth.authenticate(`pi_agent_session=${sessionCookie}`),
			auth.authenticate(`pi_agent_session=${sessionCookie}`),
		]);
		expect(refreshedA).toEqual(completion.principal);
		expect(refreshedB).toEqual(completion.principal);
		expect(refreshCalls).toBe(1);

		const logoutCookie = auth.logout(`pi_agent_session=${sessionCookie}`);
		expect(logoutCookie).toContain("Max-Age=0");
		expect(await auth.authenticate(`pi_agent_session=${sessionCookie}`)).toBeUndefined();
	});

	test("rejects a callback whose state does not match the browser cookie", async () => {
		const auth = new HiworksAuthService({
			profile: "gabia",
			publicBaseUrl: "http://127.0.0.1:8787",
			callbackPath: "/auth/hiworks/callback",
			scope: "read",
			sessionTtlMs: 60_000,
			pendingTtlMs: 10_000,
		});
		const login = auth.startLogin();
		const state = new URL(login.location).searchParams.get("state");
		if (!state) throw new Error("Missing OAuth state");

		await expect(
			auth.completeLogin(
				new URL(`http://127.0.0.1:8787/auth/hiworks/callback?code=code&state=${state}`),
				"pi_agent_oauth_state=wrong-state",
			),
		).rejects.toMatchObject({ code: "invalid_oauth_state", statusCode: 400 });
	});
});

function cookieValue(setCookie: string, name: string): string {
	const prefix = `${name}=`;
	const value = setCookie.split(";", 1)[0];
	if (!value.startsWith(prefix)) throw new Error(`Cookie ${name} was not set`);
	return decodeURIComponent(value.slice(prefix.length));
}
