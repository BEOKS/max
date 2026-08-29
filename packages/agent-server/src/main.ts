#!/usr/bin/env node
import { resolve } from "node:path";
import { loadOpenAICodexOAuth } from "@earendil-works/pi-ai";
import {
	AgentApiServer,
	AgentRegistry,
	CodexDeviceAuthService,
	CodingAgentRuntimeFactory,
	loadAgentServerConfig,
	parsePort,
} from "./index.ts";

interface CliOptions {
	configPath: string;
	help: boolean;
}

function parseArgs(args: readonly string[]): CliOptions {
	let configPath = process.env.PI_AGENT_SERVER_CONFIG ?? resolve(process.cwd(), "agent-server.config.json");
	let help = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--config") {
			const value = args[++index];
			if (!value) throw new Error("--config requires a path");
			configPath = resolve(value);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { configPath, help };
}

function printHelp(): void {
	process.stdout.write(
		[
			"Usage: pi-agent-server [--config path]",
			"",
			"Environment:",
			"  PI_AGENT_SERVER_CONFIG  Default config path",
			"  PI_AGENT_SERVER_TOKEN   Bearer token override",
			"  PI_AGENT_SERVER_HOST    Host override",
			"  PI_AGENT_SERVER_PORT    Port override",
			"  PI_AGENT_SERVER_SESSION_DIR  Session directory override",
			"  PI_AGENT_SERVER_AUTH_FILE     Codex auth file override",
			"  PI_AGENT_SERVER_AUTH_PENDING_TTL_MS  Device login timeout override",
			"  PI_AGENT_SERVER_SECURE_COOKIES  Set true for HTTPS deployments",
			"  PI_AGENT_DIR            pi auth/models directory override",
			"",
		].join("\n"),
	);
}

async function run(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	const loaded = await loadAgentServerConfig(options.configPath);
	const host = process.env.PI_AGENT_SERVER_HOST ?? loaded.host;
	const port = process.env.PI_AGENT_SERVER_PORT
		? parsePort(process.env.PI_AGENT_SERVER_PORT, "PI_AGENT_SERVER_PORT")
		: loaded.port;
	const authToken = process.env.PI_AGENT_SERVER_TOKEN ?? loaded.authToken;
	const agentDir = process.env.PI_AGENT_DIR ?? loaded.agentDir;
	const sessionDir = process.env.PI_AGENT_SERVER_SESSION_DIR ?? loaded.sessionDir;
	const authFile = process.env.PI_AGENT_SERVER_AUTH_FILE ?? loaded.authFile;
	const pendingTtlMs = process.env.PI_AGENT_SERVER_AUTH_PENDING_TTL_MS
		? parsePositiveInteger(process.env.PI_AGENT_SERVER_AUTH_PENDING_TTL_MS, "PI_AGENT_SERVER_AUTH_PENDING_TTL_MS")
		: loaded.authPendingTtlMs;
	const secureCookies = process.env.PI_AGENT_SERVER_SECURE_COOKIES
		? parseBoolean(process.env.PI_AGENT_SERVER_SECURE_COOKIES, "PI_AGENT_SERVER_SECURE_COOKIES")
		: loaded.secureCookies;

	const oauth = await loadOpenAICodexOAuth();
	const auth = new CodexDeviceAuthService({
		authFile,
		oauth,
		sessionTtlMs: loaded.authSessionTtlMs,
		pendingTtlMs,
		secureCookies,
	});
	await auth.initialize();
	const registry = new AgentRegistry(loaded.agents);
	const factory = new CodingAgentRuntimeFactory({
		agentDir,
		sessionDir,
		credentialsForOwner: (ownerId, fallback) => auth.credentialStoreFor(ownerId, fallback),
	});
	const server = new AgentApiServer(registry, factory, {
		host,
		port,
		authToken,
		auth,
		maxBodyBytes: loaded.maxBodyBytes,
		maxRunHistory: loaded.maxRunHistory,
		maxEventsPerRun: loaded.maxEventsPerRun,
		onError: (error) => process.stderr.write(`[pi-agent-server] ${error.stack ?? error.message}\n`),
	});

	await server.start();
	process.stdout.write(`pi-agent-server listening at ${server.address ?? `${host}:${port}`}\n`);
	await new Promise<void>((resolveShutdown) => {
		let shuttingDown = false;
		const shutdown = async (signal: string): Promise<void> => {
			if (shuttingDown) return;
			shuttingDown = true;
			process.stdout.write(`Received ${signal}; shutting down\n`);
			try {
				await server.close();
				resolveShutdown();
			} catch (error) {
				process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
				process.exitCode = 1;
				resolveShutdown();
			}
		};
		process.once("SIGINT", () => void shutdown("SIGINT"));
		process.once("SIGTERM", () => void shutdown("SIGTERM"));
	});
}

function parseBoolean(value: string, description: string): boolean {
	if (value === "1" || value === "true") return true;
	if (value === "0" || value === "false") return false;
	throw new Error(`${description} must be true or false`);
}

function parsePositiveInteger(value: string, description: string): number {
	if (!/^\d+$/u.test(value)) throw new Error(`${description} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${description} must be a positive integer`);
	return parsed;
}

try {
	await run();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
}
