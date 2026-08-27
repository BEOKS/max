import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
	type AgentAuthService,
	type AgentPrincipal,
	HiworksAuthService,
	type HiworksLoginCompletion,
	type HiworksLoginStart,
} from "../src/auth.ts";
import { AgentApiServer } from "../src/http.ts";
import { AgentRegistry } from "../src/registry.ts";
import { CodingAgentRuntimeFactory } from "../src/runtime.ts";
import type { AgentDefinition, AgentRuntime, AgentRuntimeFactory, AgentSessionSnapshot } from "../src/types.ts";

interface JsonRecord {
	[key: string]: unknown;
}

interface GemmaModel {
	provider: string;
	id: string;
}

const integrationEnabled = process.env.PI_AGENT_SERVER_GEMMA_INTEGRATION === "1";
let temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
	temporaryDirectories = [];
});

const fakeDefinition: AgentDefinition = {
	id: "fake-agent",
	cwd: process.cwd(),
	model: { provider: "fake", id: "fake" },
	thinkingLevel: "off",
	systemPrompt: "test",
	tools: [],
	persistent: false,
	loadProjectResources: false,
};

class BlockingRuntime implements AgentRuntime {
	readonly messages = [];
	readonly promptStarted: Promise<void>;
	readonly #listeners = new Set<Parameters<AgentRuntime["subscribe"]>[0]>();
	#resolvePromptStarted: (() => void) | undefined;
	#resolvePrompt: (() => void) | undefined;

	constructor() {
		this.promptStarted = new Promise<void>((resolve) => {
			this.#resolvePromptStarted = resolve;
		});
	}

	async prompt(): Promise<void> {
		this.#resolvePromptStarted?.();
		await new Promise<void>((resolve) => {
			this.#resolvePrompt = resolve;
		});
	}

	async abort(): Promise<void> {
		this.#resolvePrompt?.();
	}

	subscribe(listener: Parameters<AgentRuntime["subscribe"]>[0]): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	dispose(): void {
		this.#resolvePrompt?.();
	}
}

class BlockingRuntimeFactory implements AgentRuntimeFactory {
	readonly started: Promise<BlockingRuntime>;
	#resolveStarted: ((runtime: BlockingRuntime) => void) | undefined;

	constructor() {
		this.started = new Promise<BlockingRuntime>((resolve) => {
			this.#resolveStarted = resolve;
		});
	}

	async prepare(): Promise<void> {}

	async create(): Promise<AgentRuntime> {
		const runtime = new BlockingRuntime();
		this.#resolveStarted?.(runtime);
		this.#resolveStarted = undefined;
		return runtime;
	}
}

describe("pi-agent-server HTTP integration", () => {
	test("supports health, auth, run status, SSE, conflict, and abort APIs", async () => {
		const token = "pi-agent-server-test-token";
		const factory = new BlockingRuntimeFactory();
		const server = new AgentApiServer(new AgentRegistry([fakeDefinition]), factory, {
			host: "127.0.0.1",
			port: 0,
			authToken: token,
			maxBodyBytes: 64 * 1024,
			maxRunHistory: 20,
			maxEventsPerRun: 100,
		});

		try {
			await server.start();
			const baseUrl = server.address;
			if (!baseUrl) throw new Error("Server did not expose a listening address");
			const headers = { Authorization: `Bearer ${token}` };

			const health = await fetch(`${baseUrl}/healthz`);
			expect(health.status).toBe(200);
			expect(await health.json()).toEqual({ ok: true });

			expect((await fetch(`${baseUrl}/v1/agents`)).status).toBe(401);
			const agents = await fetch(`${baseUrl}/v1/agents`, { headers });
			expect(agents.status).toBe(200);
			const agentsBody = (await agents.json()) as { agents: unknown[] };
			expect(agentsBody.agents).toContainEqual({
				id: fakeDefinition.id,
				model: fakeDefinition.model,
				thinkingLevel: fakeDefinition.thinkingLevel,
				tools: [],
				persistent: false,
			});

			const invalidBody = await fetch(`${baseUrl}/v1/agents/fake-agent/runs`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(invalidBody.status).toBe(400);

			const legacySessionField = await fetch(`${baseUrl}/v1/agents/fake-agent/runs`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ conversationId: "legacy-name", input: "hello" }),
			});
			expect(legacySessionField.status).toBe(400);

			const unknownAgent = await fetch(`${baseUrl}/v1/agents/missing/runs`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ input: "hello" }),
			});
			expect(unknownAgent.status).toBe(404);

			const createResponse = await fetch(`${baseUrl}/v1/agents/fake-agent/runs`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: "busy-session", input: "wait" }),
			});
			expect(createResponse.status).toBe(202);
			const created = (await createResponse.json()) as { runId: string; statusUrl: string; eventsUrl: string };
			const runtime = await factory.started;
			await runtime.promptStarted;

			const conflict = await fetch(`${baseUrl}/v1/agents/fake-agent/runs`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: "busy-session", input: "second request" }),
			});
			expect(conflict.status).toBe(409);

			const abortResponse = await fetch(`${baseUrl}/v1/runs/${created.runId}/abort`, {
				method: "POST",
				headers,
			});
			expect(abortResponse.status).toBe(200);
			const cancelled = await waitForRunStatus(baseUrl, created.statusUrl, headers, "cancelled");
			expect(cancelled.status).toBe("cancelled");

			const statusResponse = await fetch(`${baseUrl}${created.statusUrl}`, { headers });
			expect(statusResponse.status).toBe(200);
			const eventsResponse = await fetch(`${baseUrl}${created.eventsUrl}`, { headers });
			expect(eventsResponse.status).toBe(200);
			expect(await eventsResponse.text()).toContain("event: run_cancelled");

			expect((await fetch(`${baseUrl}/v1/runs/missing`, { headers })).status).toBe(404);
			expect((await fetch(`${baseUrl}/v1/runs/missing/events`, { headers })).status).toBe(404);
			expect(
				(
					await fetch(`${baseUrl}/v1/runs/missing/abort`, {
						method: "POST",
						headers,
					})
				).status,
			).toBe(404);
		} finally {
			await server.close();
		}
	}, 15_000);

	test("isolates runs and sessions between Hiworks users", async () => {
		const factory = new BlockingRuntimeFactory();
		const server = new AgentApiServer(new AgentRegistry([fakeDefinition]), factory, {
			host: "127.0.0.1",
			port: 0,
			hiworksAuth: new TestCookieAuthService(),
			maxBodyBytes: 64 * 1024,
			maxRunHistory: 20,
			maxEventsPerRun: 100,
		});

		try {
			await server.start();
			const baseUrl = server.address;
			if (!baseUrl) throw new Error("Server did not expose a listening address");
			const userAHeaders = { Cookie: "pi_agent_session=user-a" };
			const userBHeaders = { Cookie: "pi_agent_session=user-b" };

			expect((await fetch(`${baseUrl}/v1/agents`)).status).toBe(401);
			const runAResponse = await fetch(`${baseUrl}/v1/agents/fake-agent/runs`, {
				method: "POST",
				headers: { ...userAHeaders, "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: "shared-name", input: "user A" }),
			});
			const runA = (await runAResponse.json()) as { runId: string };
			expect(runAResponse.status).toBe(202);

			const sameSessionForB = await fetch(`${baseUrl}/v1/agents/fake-agent/runs`, {
				method: "POST",
				headers: { ...userBHeaders, "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: "shared-name", input: "user B" }),
			});
			const runB = (await sameSessionForB.json()) as { runId: string };
			expect(sameSessionForB.status).toBe(202);

			const sameSessionForA = await fetch(`${baseUrl}/v1/agents/fake-agent/runs`, {
				method: "POST",
				headers: { ...userAHeaders, "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: "shared-name", input: "user A again" }),
			});
			expect(sameSessionForA.status).toBe(409);

			expect((await fetch(`${baseUrl}/v1/runs/${runA.runId}`, { headers: userBHeaders })).status).toBe(404);
			expect(
				(
					await fetch(`${baseUrl}/v1/runs/${runA.runId}/abort`, {
						method: "POST",
						headers: userBHeaders,
					})
				).status,
			).toBe(404);

			const abortA = await fetch(`${baseUrl}/v1/runs/${runA.runId}/abort`, {
				method: "POST",
				headers: userAHeaders,
			});
			const abortB = await fetch(`${baseUrl}/v1/runs/${runB.runId}/abort`, {
				method: "POST",
				headers: userBHeaders,
			});
			expect(abortA.status).toBe(200);
			expect(abortB.status).toBe(200);
			expect((await waitForRunStatus(baseUrl, `/v1/runs/${runA.runId}`, userAHeaders, "cancelled")).status).toBe(
				"cancelled",
			);
			expect((await waitForRunStatus(baseUrl, `/v1/runs/${runB.runId}`, userBHeaders, "cancelled")).status).toBe(
				"cancelled",
			);
		} finally {
			await server.close();
		}
	}, 15_000);

	test("supports Hiworks login, current-user, and logout routes", async () => {
		const auth = new HiworksAuthService({
			profile: "gabia",
			publicBaseUrl: "http://127.0.0.1:8787",
			callbackPath: "/auth/hiworks/callback",
			scope: "read",
			sessionTtlMs: 60_000,
			pendingTtlMs: 10_000,
			exchangeCodeForToken: async () => ({
				access_token: "route-access-token",
				token_type: "Bearer",
				expires_in: 3_600,
				refresh_token: "route-refresh-token",
			}),
			fetchMe: async (accessToken) => {
				expect(accessToken).toBe("route-access-token");
				return { user_no: "route-user", email: "route@example.com" };
			},
		});
		const server = new AgentApiServer(new AgentRegistry([fakeDefinition]), new BlockingRuntimeFactory(), {
			host: "127.0.0.1",
			port: 0,
			hiworksAuth: auth,
			maxBodyBytes: 64 * 1024,
			maxRunHistory: 20,
			maxEventsPerRun: 100,
		});

		try {
			await server.start();
			const baseUrl = server.address;
			if (!baseUrl) throw new Error("Server did not expose a listening address");

			const anonymousMe = await fetch(`${baseUrl}/auth/me`);
			expect(anonymousMe.status).toBe(200);
			expect(await anonymousMe.json()).toEqual({ authenticated: false, user: null });
			const anonymousHome = await fetch(`${baseUrl}/`, { redirect: "manual" });
			expect(anonymousHome.status).toBe(302);
			expect(anonymousHome.headers.get("location")).toBe("/auth/hiworks/login");

			const login = await fetch(`${baseUrl}/auth/hiworks/login`, { redirect: "manual" });
			expect(login.status).toBe(302);
			const loginLocation = login.headers.get("location");
			const state = loginLocation ? new URL(loginLocation).searchParams.get("state") : undefined;
			if (!state) throw new Error("Hiworks login route did not return state");
			const stateCookie = cookieValueFromHeader(login.headers.get("set-cookie"), "pi_agent_oauth_state");
			expect(stateCookie).toBe(state);

			const callback = await fetch(
				`${baseUrl}/auth/hiworks/callback?code=route-code&state=${encodeURIComponent(state)}`,
				{ headers: { Cookie: `pi_agent_oauth_state=${stateCookie}` }, redirect: "manual" },
			);
			expect(callback.status).toBe(303);
			expect(callback.headers.get("location")).toBe("/");
			const sessionCookie = cookieValueFromHeader(callback.headers.get("set-cookie"), "pi_agent_session");
			const home = await fetch(`${baseUrl}/`, { headers: { Cookie: `pi_agent_session=${sessionCookie}` } });
			expect(home.status).toBe(200);
			expect(await home.text()).toContain("PI Agent Server");

			const me = await fetch(`${baseUrl}/auth/me`, { headers: { Cookie: `pi_agent_session=${sessionCookie}` } });
			expect(me.status).toBe(200);
			expect(await me.json()).toEqual({
				authenticated: true,
				user: {
					id: "hiworks:gabia:route-user",
					source: "hiworks",
					admin: false,
					profile: "gabia",
					email: "route@example.com",
				},
			});
			expect(
				(await fetch(`${baseUrl}/v1/agents`, { headers: { Cookie: `pi_agent_session=${sessionCookie}` } })).status,
			).toBe(200);

			const logout = await fetch(`${baseUrl}/auth/hiworks/logout`, {
				method: "POST",
				headers: { Cookie: `pi_agent_session=${sessionCookie}` },
			});
			expect(logout.status).toBe(200);
			expect(
				(await fetch(`${baseUrl}/v1/agents`, { headers: { Cookie: `pi_agent_session=${sessionCookie}` } })).status,
			).toBe(401);
		} finally {
			await server.close();
		}
	}, 15_000);

	test("returns full persistent session data by sessionId", async () => {
		const definition: AgentDefinition = { ...fakeDefinition, id: "history-agent", persistent: true };
		const server = new AgentApiServer(new AgentRegistry([definition]), new SessionReadingFactory(), {
			host: "127.0.0.1",
			port: 0,
			hiworksAuth: new TestCookieAuthService(),
			maxBodyBytes: 64 * 1024,
			maxRunHistory: 20,
			maxEventsPerRun: 100,
		});

		try {
			await server.start();
			const baseUrl = server.address;
			if (!baseUrl) throw new Error("Server did not expose a listening address");

			const userA = await fetch(`${baseUrl}/v1/agents/history-agent/sessions/history`, {
				headers: { Cookie: "pi_agent_session=user-a" },
			});
			expect(userA.status).toBe(200);
			expect(await userA.json()).toEqual({
				agentId: "history-agent",
				sessionId: "history",
				piSessionId: "session-user-a",
				header: {
					type: "session",
					version: 3,
					id: "session-user-a",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: process.cwd(),
				},
				entries: [],
				tree: [],
				context: { messages: [], thinkingLevel: "off", model: null },
				sessionName: "User A history",
				leafId: null,
			});

			const userB = await fetch(`${baseUrl}/v1/agents/history-agent/sessions/history`, {
				headers: { Cookie: "pi_agent_session=user-b" },
			});
			expect(userB.status).toBe(404);
			expect(
				(
					await fetch(`${baseUrl}/v1/agents/history-agent/sessions/missing`, {
						headers: { Cookie: "pi_agent_session=user-a" },
					})
				).status,
			).toBe(404);
			expect(
				(
					await fetch(`${baseUrl}/v1/agents/history-agent/sessions/bad%2Fid`, {
						headers: { Cookie: "pi_agent_session=user-a" },
					})
				).status,
			).toBe(400);
		} finally {
			await server.close();
		}
	}, 15_000);
});

class TestCookieAuthService implements AgentAuthService {
	readonly callbackPath = "/auth/hiworks/callback";
	readonly #principals = new Map<string, AgentPrincipal>([
		["user-a", { id: "hiworks:gabia:user-a", source: "hiworks", profile: "gabia", admin: false }],
		["user-b", { id: "hiworks:gabia:user-b", source: "hiworks", profile: "gabia", admin: false }],
	]);

	async authenticate(cookieHeader?: string): Promise<AgentPrincipal | undefined> {
		const cookie = cookieHeader
			?.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith("pi_agent_session="));
		return cookie ? this.#principals.get(cookie.slice("pi_agent_session=".length)) : undefined;
	}

	startLogin(): HiworksLoginStart {
		return { location: "https://hiworks.example.test/login", setCookie: "pi_agent_oauth_state=test" };
	}

	async completeLogin(): Promise<HiworksLoginCompletion> {
		throw new Error("Not used in this test");
	}

	logout(): string {
		return "pi_agent_session=; Max-Age=0; Path=/";
	}
}

class SessionReadingFactory implements AgentRuntimeFactory {
	async prepare(): Promise<void> {}

	async create(): Promise<AgentRuntime> {
		return new BlockingRuntime();
	}

	async readSession(
		definition: AgentDefinition,
		sessionId: string,
		ownerId?: string,
	): Promise<AgentSessionSnapshot | undefined> {
		if (definition.id !== "history-agent" || sessionId !== "history" || ownerId !== "hiworks:gabia:user-a") {
			return undefined;
		}
		return {
			piSessionId: "session-user-a",
			header: {
				type: "session",
				version: 3,
				id: "session-user-a",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: definition.cwd,
			},
			entries: [],
			tree: [],
			context: { messages: [], thinkingLevel: "off", model: null },
			sessionName: "User A history",
			leafId: null,
		};
	}
}

describe.skipIf(!integrationEnabled)("pi-agent-server Gemma integration", () => {
	test("routes a configured Gemma agent through HTTP, SSE, and persistent session storage", async () => {
		const agentDir = process.env.PI_AGENT_DIR ?? getAgentDir();
		const gemma = await findConfiguredGemma(agentDir);
		const cwd = await makeTemporaryDirectory("pi-agent-server-cwd-");
		const sessionDir = await makeTemporaryDirectory("pi-agent-server-sessions-");
		const definition: AgentDefinition = {
			id: "gemma-smoke",
			cwd,
			model: gemma,
			thinkingLevel: "off",
			systemPrompt: "You are an integration test agent. Reply with exactly INTEGRATION_TEST_OK and nothing else.",
			tools: [],
			persistent: true,
			loadProjectResources: false,
		};
		const token = "pi-agent-server-integration-token";
		const server = new AgentApiServer(
			new AgentRegistry([definition]),
			new CodingAgentRuntimeFactory({ sessionDir: join(sessionDir, "{agentid}", "session"), agentDir }),
			{
				host: "127.0.0.1",
				port: 0,
				authToken: token,
				maxBodyBytes: 64 * 1024,
				maxRunHistory: 20,
				maxEventsPerRun: 2_000,
			},
		);

		try {
			await server.start();
			const baseUrl = server.address;
			if (!baseUrl) throw new Error("Server did not expose a listening address");
			const headers = { Authorization: `Bearer ${token}` };

			const healthResponse = await fetch(`${baseUrl}/healthz`);
			expect(healthResponse.status).toBe(200);

			expect((await fetch(`${baseUrl}/v1/agents`)).status).toBe(401);
			const agentsResponse = await fetch(`${baseUrl}/v1/agents`, { headers });
			expect(agentsResponse.status).toBe(200);
			const agents = (await agentsResponse.json()) as {
				agents: Array<{ id: string; model: { provider: string; id: string } }>;
			};
			expect(agents.agents).toContainEqual({
				id: "gemma-smoke",
				model: gemma,
				thinkingLevel: "off",
				tools: [],
				persistent: true,
			});

			const createResponse = await fetch(`${baseUrl}/v1/agents/gemma-smoke/runs`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: "gemma-integration",
					input: "Reply with exactly INTEGRATION_TEST_OK.",
				}),
			});
			expect(createResponse.status).toBe(202);
			const created = (await createResponse.json()) as { runId: string; statusUrl: string; eventsUrl: string };

			const eventsResponse = await fetch(`${baseUrl}${created.eventsUrl}`, { headers });
			expect(eventsResponse.status).toBe(200);
			const events = await eventsResponse.text();
			expect(events).toContain("event: run_started");
			expect(events).toContain("event: run_completed");

			const statusResponse = await fetch(`${baseUrl}${created.statusUrl}`, { headers });
			expect(statusResponse.status).toBe(200);
			const snapshot = (await statusResponse.json()) as {
				status: string;
				sessionId: string;
				result?: { output: string };
			};
			expect(snapshot.status).toBe("completed");
			expect(snapshot.sessionId).toBe("gemma-integration");
			expect(snapshot.result?.output).toContain("INTEGRATION_TEST_OK");

			const agentSessionDirectory = join(sessionDir, "gemma-smoke", "session");
			const sessionFiles = await readdir(agentSessionDirectory);
			expect(sessionFiles).toContain("gemma-integration.jsonl");
		} finally {
			await server.close();
		}
	}, 120_000);
});

async function findConfiguredGemma(agentDir: string): Promise<GemmaModel> {
	const [modelsContent, authContent] = await Promise.all([
		readFile(join(agentDir, "models.json"), "utf8"),
		readFile(join(agentDir, "auth.json"), "utf8"),
	]);
	const models = asRecord(JSON.parse(modelsContent) as unknown, "models.json");
	const providers = asRecord(models.providers, "models.json.providers");
	const auth = asRecord(JSON.parse(authContent) as unknown, "auth.json");
	const preferredProviders = ["ai-hub-openai", "ai-hub-teams", "ai-hub"];
	for (const providerId of preferredProviders) {
		const provider = asRecord(providers[providerId], `models.json.providers.${providerId}`);
		const configured = auth[providerId] !== undefined || typeof provider.apiKey === "string";
		if (!configured || !Array.isArray(provider.models)) continue;
		const model = provider.models.find(
			(candidate): candidate is JsonRecord =>
				isRecord(candidate) && typeof candidate.id === "string" && candidate.id.toLowerCase().includes("gemma"),
		);
		if (model) return { provider: providerId, id: model.id as string };
	}
	throw new Error(`No authenticated Gemma model found in ${join(homedir(), ".pi", "agent")}`);
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function waitForRunStatus(
	baseUrl: string,
	statusUrl: string,
	headers: Record<string, string>,
	expectedStatus: string,
): Promise<{ status: string }> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const response = await fetch(`${baseUrl}${statusUrl}`, { headers });
		const snapshot = (await response.json()) as { status: string };
		if (snapshot.status === expectedStatus) return snapshot;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for run status ${expectedStatus}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

function asRecord(value: unknown, description: string): JsonRecord {
	if (!isRecord(value)) throw new Error(`${description} must be an object`);
	return value;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cookieValueFromHeader(header: string | null, name: string): string {
	const match = header?.match(new RegExp(`${name}=([^;,]+)`, "u"));
	if (!match?.[1]) throw new Error(`Cookie ${name} was not set`);
	return match[1];
}
