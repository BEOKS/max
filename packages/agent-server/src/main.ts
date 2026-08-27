#!/usr/bin/env node
import { resolve } from "node:path";
import {
	AgentApiServer,
	AgentRegistry,
	CodingAgentRuntimeFactory,
	isLoopbackHost,
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
	if (!isLoopbackHost(host) && !authToken) {
		throw new Error("An authToken or PI_AGENT_SERVER_TOKEN is required when binding outside localhost");
	}

	const registry = new AgentRegistry(loaded.agents);
	const factory = new CodingAgentRuntimeFactory({ agentDir, sessionDir });
	const server = new AgentApiServer(registry, factory, {
		host,
		port,
		authToken,
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

try {
	await run();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
}
