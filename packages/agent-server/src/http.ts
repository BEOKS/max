import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AgentServerError } from "./errors.ts";
import { type AgentRegistry, isSafeIdentifier } from "./registry.ts";
import { AgentRunManager } from "./runs.ts";
import type { AgentRunEvent, AgentRunRequest, AgentRuntimeFactory } from "./types.ts";

const INTERNAL_ERROR_MESSAGE = "Internal server error";

export interface AgentApiServerOptions {
	host: string;
	port: number;
	authToken?: string;
	maxBodyBytes: number;
	maxRunHistory: number;
	maxEventsPerRun: number;
	onError?: (error: Error) => void;
}

class HttpError extends Error {
	readonly statusCode: number;
	readonly code: string;

	constructor(statusCode: number, code: string, message: string) {
		super(message);
		this.name = "HttpError";
		this.statusCode = statusCode;
		this.code = code;
	}
}

export class AgentApiServer {
	readonly #options: AgentApiServerOptions;
	readonly #registry: AgentRegistry;
	readonly #factory: AgentRuntimeFactory;
	readonly #runs: AgentRunManager;
	readonly #server: Server;
	#started = false;
	#closing = false;
	#startPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;

	constructor(registry: AgentRegistry, factory: AgentRuntimeFactory, options: AgentApiServerOptions) {
		this.#options = options;
		this.#registry = registry;
		this.#factory = factory;
		this.#runs = new AgentRunManager(registry, factory, {
			maxRunHistory: options.maxRunHistory,
			maxEventsPerRun: options.maxEventsPerRun,
			onError: options.onError,
		});
		this.#server = createServer((request, response) => {
			void this.#handle(request, response).catch((error: unknown) => this.#handleError(response, error));
		});
	}

	get address(): string | undefined {
		const address = this.#server.address();
		if (!address || typeof address === "string") return address ?? undefined;
		const host = address.address.includes(":") ? `[${address.address}]` : address.address;
		return `http://${host}:${address.port}`;
	}

	start(): Promise<void> {
		if (this.#started) return Promise.reject(new Error("Agent API server is already started"));
		if (this.#startPromise) return Promise.reject(new Error("Agent API server is already starting"));
		if (this.#closing) return Promise.reject(new Error("Agent API server is closing or closed"));
		this.#startPromise = this.#startInternal();
		return this.#startPromise.finally(() => {
			this.#startPromise = undefined;
		});
	}

	async #startInternal(): Promise<void> {
		await this.#factory.prepare(this.#registry.list());
		if (this.#closing) throw new Error("Agent API server is closing or closed");
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				this.#server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				this.#server.off("error", onError);
				this.#started = true;
				resolve();
			};
			this.#server.once("error", onError);
			this.#server.once("listening", onListening);
			this.#server.listen(this.#options.port, this.#options.host);
		});
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		this.#closePromise = (async () => {
			const starting = this.#startPromise;
			if (starting) await starting.catch(() => {});
			let serverClosed = Promise.resolve();
			if (this.#started) {
				serverClosed = new Promise<void>((resolve, reject) => {
					this.#server.close((error) => (error ? reject(error) : resolve()));
				});
				this.#started = false;
			}
			try {
				await this.#runs.close();
			} finally {
				await serverClosed;
			}
		})();
		return this.#closePromise;
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const pathname = this.#pathname(request.url);
		if (pathname === "/healthz") {
			if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
			writeJson(response, 200, { ok: true });
			return;
		}

		if (this.#closing) throw new HttpError(503, "server_closing", "Server is shutting down");

		if (!this.#isAuthorized(request)) {
			response.setHeader("WWW-Authenticate", "Bearer");
			throw new HttpError(401, "unauthorized", "Authentication required");
		}

		const parts = pathname
			.split("/")
			.filter(Boolean)
			.map((part) => this.#decodeSegment(part));
		if (parts.length === 2 && parts[0] === "v1" && parts[1] === "agents") {
			if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
			writeJson(response, 200, { agents: this.#registryMetadata() });
			return;
		}

		if (parts.length === 4 && parts[0] === "v1" && parts[1] === "agents" && parts[3] === "runs") {
			if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
			const body = await readRunRequest(request, this.#options.maxBodyBytes);
			const snapshot = this.#runs.create(parts[2], body);
			writeJson(response, 202, {
				runId: snapshot.id,
				agentId: snapshot.agentId,
				conversationId: snapshot.conversationId,
				status: snapshot.status,
				statusUrl: `/v1/runs/${snapshot.id}`,
				eventsUrl: `/v1/runs/${snapshot.id}/events`,
			});
			return;
		}

		if (parts.length === 3 && parts[0] === "v1" && parts[1] === "runs") {
			if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
			writeJson(response, 200, this.#runs.get(parts[2]));
			return;
		}

		if (parts.length === 4 && parts[0] === "v1" && parts[1] === "runs" && parts[3] === "events") {
			if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Method not allowed");
			this.#streamEvents(response, parts[2]);
			return;
		}

		if (parts.length === 4 && parts[0] === "v1" && parts[1] === "runs" && parts[3] === "abort") {
			if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed");
			writeJson(response, 200, await this.#runs.abort(parts[2]));
			return;
		}

		throw new HttpError(404, "not_found", "Route not found");
	}

	#registryMetadata(): ReturnType<AgentRegistry["publicMetadata"]> {
		return this.#registry.publicMetadata();
	}

	#streamEvents(response: ServerResponse, runId: string): void {
		this.#runs.get(runId);
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.write(": connected\n\n");

		let active = true;
		let unsubscribe = (): void => {};
		const finish = (): void => {
			if (!active) return;
			active = false;
			unsubscribe();
			if (!response.writableEnded) response.end();
		};
		const onEvent = (event: AgentRunEvent): void => {
			if (!active || response.destroyed) return;
			try {
				response.write(formatSse(event));
				if (event.type === "run_completed" || event.type === "run_failed" || event.type === "run_cancelled")
					finish();
			} catch {
				finish();
			}
		};

		unsubscribe = this.#runs.subscribe(runId, onEvent);
		response.once("close", () => {
			active = false;
			unsubscribe();
		});
	}

	#pathname(rawUrl: string | undefined): string {
		try {
			return new URL(rawUrl ?? "/", "http://localhost").pathname;
		} catch {
			throw new HttpError(400, "invalid_url", "Invalid request URL");
		}
	}

	#decodeSegment(segment: string): string {
		try {
			return decodeURIComponent(segment);
		} catch {
			throw new HttpError(400, "invalid_path", "Invalid URL path");
		}
	}

	#isAuthorized(request: IncomingMessage): boolean {
		if (!this.#options.authToken) return true;
		const authorization = request.headers.authorization;
		if (!authorization?.startsWith("Bearer ")) return false;
		const received = Buffer.from(authorization.slice("Bearer ".length));
		const expected = Buffer.from(this.#options.authToken);
		return received.length === expected.length && timingSafeEqual(received, expected);
	}

	#handleError(response: ServerResponse, error: unknown): void {
		if (response.headersSent) {
			response.destroy();
			return;
		}
		const knownError = error instanceof AgentServerError || error instanceof HttpError ? error : undefined;
		if (!knownError) this.#reportError(error);
		const statusCode = knownError?.statusCode ?? 500;
		const code = knownError?.code ?? "internal_error";
		const message = knownError?.message ?? INTERNAL_ERROR_MESSAGE;
		writeJson(response, statusCode, { error: { code, message } });
	}

	#reportError(error: unknown): void {
		try {
			this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Diagnostics cannot affect the HTTP server.
		}
	}
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
	response.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	response.end(JSON.stringify(value));
}

async function readRunRequest(request: IncomingMessage, maxBodyBytes: number): Promise<AgentRunRequest> {
	const contentLength = request.headers["content-length"];
	if (contentLength !== undefined) {
		const length = Number(contentLength);
		if (!Number.isSafeInteger(length) || length < 0 || length > maxBodyBytes) {
			throw new HttpError(413, "body_too_large", "Request body is too large");
		}
	}

	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
		totalBytes += bytes.byteLength;
		if (totalBytes > maxBodyBytes) throw new HttpError(413, "body_too_large", "Request body is too large");
		chunks.push(bytes);
	}
	if (chunks.length === 0) throw new HttpError(400, "invalid_json", "Request body is required");

	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HttpError(400, "invalid_request", "Request body must be an object");
	}
	const body = value as Record<string, unknown>;
	if (typeof body.input !== "string" || body.input.trim().length === 0) {
		throw new HttpError(400, "invalid_request", "input must be a non-empty string");
	}
	if (body.conversationId !== undefined) {
		if (typeof body.conversationId !== "string" || !isSafeIdentifier(body.conversationId)) {
			throw new HttpError(400, "invalid_request", "conversationId contains unsupported characters");
		}
		return { input: body.input, conversationId: body.conversationId };
	}
	return { input: body.input };
}

function formatSse(event: AgentRunEvent): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
