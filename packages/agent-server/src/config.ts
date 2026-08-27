import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { assertSafeIdentifier } from "./registry.ts";
import type { AgentDefinition, AgentModelReference } from "./types.ts";

export interface AgentServerConfig {
	host: string;
	port: number;
	authToken?: string;
	agentDir: string;
	sessionDir: string;
	maxBodyBytes: number;
	maxRunHistory: number;
	maxEventsPerRun: number;
	agents: readonly AgentDefinition[];
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, path);
}

function optionalBoolean(value: unknown, path: string, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
	return value;
}

function integer(value: unknown, path: string, defaultValue: number, minimum: number): number {
	if (value === undefined) return defaultValue;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${path} must be an integer >= ${minimum}`);
	}
	return value;
}

function stringArray(value: unknown, path: string, defaultValue: readonly string[]): readonly string[] {
	if (value === undefined) return [...defaultValue];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
		throw new Error(`${path} must be an array of non-empty strings`);
	}
	return [...new Set(value as string[])];
}

function parseThinkingLevel(value: unknown, path: string): ThinkingLevel {
	const level = value === undefined ? "medium" : value;
	if (typeof level !== "string" || !THINKING_LEVELS.includes(level as ThinkingLevel)) {
		throw new Error(`${path} must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	return level as ThinkingLevel;
}

function parseModel(value: unknown, path: string): AgentModelReference {
	const model = asRecord(value, path);
	return {
		provider: requiredString(model.provider, `${path}.provider`),
		id: requiredString(model.id, `${path}.id`),
	};
}

function parseAgent(id: string, value: unknown): AgentDefinition {
	assertSafeIdentifier(id, "Agent ID");
	const agent = asRecord(value, `agents.${id}`);
	return {
		id,
		cwd: resolve(requiredString(agent.cwd, `agents.${id}.cwd`)),
		model: parseModel(agent.model, `agents.${id}.model`),
		thinkingLevel: parseThinkingLevel(agent.thinkingLevel, `agents.${id}.thinkingLevel`),
		systemPrompt: requiredString(agent.systemPrompt, `agents.${id}.systemPrompt`),
		tools: stringArray(agent.tools, `agents.${id}.tools`, ["read"]),
		persistent: optionalBoolean(agent.persistent, `agents.${id}.persistent`, true),
		loadProjectResources: optionalBoolean(agent.loadProjectResources, `agents.${id}.loadProjectResources`, false),
	};
}

export async function loadAgentServerConfig(path: string): Promise<AgentServerConfig> {
	const content = await readFile(path, "utf8");
	let raw: unknown;
	try {
		raw = JSON.parse(content) as unknown;
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const config = asRecord(raw, "root");
	const agentConfig = asRecord(config.agents, "agents");
	const agents = Object.entries(agentConfig).map(([id, value]) => parseAgent(id, value));
	if (agents.length === 0) throw new Error("agents must contain at least one agent definition");

	const host = optionalString(config.host, "host") ?? "127.0.0.1";
	const port = integer(config.port, "port", 8787, 0);
	if (port > 65_535) throw new Error("port must be between 0 and 65535");
	const authToken = optionalString(config.authToken, "authToken");
	const agentDir = resolve(optionalString(config.agentDir, "agentDir") ?? getAgentDir());
	const sessionDir = optionalString(config.sessionDir, "sessionDir") ?? "~/.pi-agent-server/sessions";

	return {
		host,
		port,
		authToken,
		agentDir,
		sessionDir,
		maxBodyBytes: integer(config.maxBodyBytes, "maxBodyBytes", 1_048_576, 1),
		maxRunHistory: integer(config.maxRunHistory, "maxRunHistory", 1_000, 1),
		maxEventsPerRun: integer(config.maxEventsPerRun, "maxEventsPerRun", 20_000, 1),
		agents,
	};
}

export function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function parsePort(value: string, description: string): number {
	if (!/^\d+$/u.test(value)) throw new Error(`${description} must be an integer between 0 and 65535`);
	const port = Number(value);
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`${description} must be an integer between 0 and 65535`);
	}
	return port;
}
