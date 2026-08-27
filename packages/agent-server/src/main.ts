#!/usr/bin/env node
import { resolve } from "node:path";
import type { HiworksServerConfig } from "./config.ts";
import {
	AgentApiServer,
	AgentRegistry,
	CodingAgentRuntimeFactory,
	HiworksAuthService,
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
			"  PI_AGENT_SERVER_HIWORKS_PROFILE       Hiworks profile override",
			"  PI_AGENT_SERVER_HIWORKS_PUBLIC_URL    OAuth callback base URL override",
			"  PI_AGENT_SERVER_HIWORKS_REDIRECT_URI  Exact OAuth redirect URI override",
			"  PI_AGENT_SERVER_HIWORKS_CLIENT_ID     OAuth client ID override",
			"  PI_AGENT_SERVER_HIWORKS_CLIENT_SECRET OAuth client secret override",
			"  PI_AGENT_SERVER_HIWORKS_SCOPE         OAuth scope override",
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
	const hiworksConfig = resolveHiworksConfig(loaded.hiworks);
	if (!isLoopbackHost(host) && !authToken && !hiworksConfig) {
		throw new Error(
			"An authToken, Hiworks authentication, or PI_AGENT_SERVER_TOKEN is required when binding outside localhost",
		);
	}

	const registry = new AgentRegistry(loaded.agents);
	const factory = new CodingAgentRuntimeFactory({ agentDir, sessionDir });
	const hiworksAuth = hiworksConfig ? new HiworksAuthService(hiworksConfig) : undefined;
	const server = new AgentApiServer(registry, factory, {
		host,
		port,
		authToken,
		hiworksAuth,
		maxBodyBytes: loaded.maxBodyBytes,
		maxRunHistory: loaded.maxRunHistory,
		maxEventsPerRun: loaded.maxEventsPerRun,
		onError: (error) => process.stderr.write(`[pi-agent-server] ${error.stack ?? error.message}\n`),
	});

	await server.start();
	process.stdout.write(`pi-agent-server listening at ${server.address ?? `${host}:${port}`}\n`);
	if (hiworksAuth) process.stdout.write(`Hiworks OAuth redirect URI: ${hiworksAuth.redirectUri}\n`);
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

function resolveHiworksConfig(config: HiworksServerConfig | undefined): HiworksServerConfig | undefined {
	const profileValue = process.env.PI_AGENT_SERVER_HIWORKS_PROFILE;
	const publicBaseUrl = process.env.PI_AGENT_SERVER_HIWORKS_PUBLIC_URL;
	const redirectUri = process.env.PI_AGENT_SERVER_HIWORKS_REDIRECT_URI;
	const callbackPath = process.env.PI_AGENT_SERVER_HIWORKS_CALLBACK_PATH;
	const scope = process.env.PI_AGENT_SERVER_HIWORKS_SCOPE;
	const clientId = process.env.PI_AGENT_SERVER_HIWORKS_CLIENT_ID;
	const clientSecret = process.env.PI_AGENT_SERVER_HIWORKS_CLIENT_SECRET;
	const hasEnvironmentConfig = [
		profileValue,
		publicBaseUrl,
		redirectUri,
		callbackPath,
		scope,
		clientId,
		clientSecret,
	].some((value) => value !== undefined);
	if (!config && !hasEnvironmentConfig) return undefined;
	const base = config ?? {
		profile: "gabia" as const,
		publicBaseUrl: publicBaseUrl ?? "",
		...(redirectUri ? { redirectUri } : {}),
		callbackPath: "/auth/hiworks/callback",
		scope: "read write",
		sessionTtlMs: 86_400_000,
		pendingTtlMs: 600_000,
	};
	const profile = profileValue ?? base.profile;
	if (profile !== "gabia" && profile !== "dev") {
		throw new Error("PI_AGENT_SERVER_HIWORKS_PROFILE must be gabia or dev");
	}
	return {
		...base,
		profile,
		publicBaseUrl: publicBaseUrl ?? base.publicBaseUrl,
		...((redirectUri ?? base.redirectUri) ? { redirectUri: redirectUri ?? base.redirectUri } : {}),
		callbackPath: callbackPath ?? base.callbackPath,
		scope: scope ?? base.scope,
		...((clientId ?? base.clientId) ? { clientId: clientId ?? base.clientId } : {}),
		...((clientSecret ?? base.clientSecret) ? { clientSecret: clientSecret ?? base.clientSecret } : {}),
	};
}

try {
	await run();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
}
