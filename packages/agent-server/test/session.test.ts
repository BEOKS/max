import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { CodingAgentRuntimeFactory } from "../src/runtime.ts";
import type { AgentDefinition } from "../src/types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("CodingAgentRuntimeFactory session inspection", () => {
	test("reads the complete session in the authenticated user's namespace", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-agent-server-session-test-"));
		temporaryDirectories.push(directory);
		const ownerId = "codex:user-a";
		const sessionId = "session-a";
		const definition: AgentDefinition = {
			id: "history-agent",
			cwd: directory,
			model: { provider: "fake", id: "fake" },
			thinkingLevel: "off",
			systemPrompt: "test",
			tools: [],
			persistent: true,
			loadProjectResources: false,
		};
		const sessionDir = join(directory, "{agentid}", "session");
		const ownerDirectory = createHash("sha256").update(ownerId).digest("hex").slice(0, 32);
		const sessionPath = join(directory, definition.id, "session", ownerDirectory, `${sessionId}.jsonl`);
		const sessionManager = SessionManager.open(
			sessionPath,
			join(directory, definition.id, "session", ownerDirectory),
			directory,
		);
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "world" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		const factory = new CodingAgentRuntimeFactory({ agentDir: directory, sessionDir });
		const snapshot = await factory.readSession(definition, sessionId, ownerId);
		expect(snapshot?.piSessionId).toBe(sessionManager.getSessionId());
		expect(snapshot?.header?.cwd).toBe(directory);
		expect(snapshot?.entries).toHaveLength(2);
		expect(snapshot?.tree).toHaveLength(1);
		expect(snapshot?.context.messages).toHaveLength(2);
		expect(await factory.readSession(definition, sessionId, "codex:user-b")).toBeUndefined();
	});
});
