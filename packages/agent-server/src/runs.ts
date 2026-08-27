import { randomUUID } from "node:crypto";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import { AgentRunConflictError, AgentRunNotFoundError } from "./errors.ts";
import { type AgentRegistry, isSafeIdentifier } from "./registry.ts";
import type {
	AgentDefinition,
	AgentRunEvent,
	AgentRunRequest,
	AgentRunResult,
	AgentRunSnapshot,
	AgentRunStatus,
	AgentRuntime,
	AgentRuntimeFactory,
} from "./types.ts";

interface RunRecord {
	snapshot: AgentRunSnapshot;
	definition: AgentDefinition;
	input: string;
	ownerId?: string;
	events: AgentRunEvent[];
	subscribers: Set<(event: AgentRunEvent) => void>;
	cancelRequested: boolean;
	runtime?: AgentRuntime;
	completion?: Promise<void>;
}

export interface AgentRunManagerOptions {
	maxRunHistory: number;
	maxEventsPerRun: number;
	onError?: (error: Error) => void;
}

export class AgentRunManager {
	readonly #registry: AgentRegistry;
	readonly #factory: AgentRuntimeFactory;
	readonly #maxRunHistory: number;
	readonly #maxEventsPerRun: number;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #runs = new Map<string, RunRecord>();
	readonly #activeConversations = new Map<string, string>();
	#closing = false;

	constructor(registry: AgentRegistry, factory: AgentRuntimeFactory, options: AgentRunManagerOptions) {
		this.#registry = registry;
		this.#factory = factory;
		this.#maxRunHistory = options.maxRunHistory;
		this.#maxEventsPerRun = options.maxEventsPerRun;
		this.#onError = options.onError;
	}

	create(agentId: string, request: AgentRunRequest, ownerId?: string): AgentRunSnapshot {
		if (this.#closing) throw new Error("Agent run manager is closing");
		const definition = this.#registry.require(agentId);
		const conversationId = request.conversationId ?? randomUUID();
		if (!isSafeIdentifier(conversationId)) throw new Error("conversationId contains unsupported characters");
		const conversationKey = makeConversationKey(ownerId, agentId, conversationId);
		const activeRunId = this.#activeConversations.get(conversationKey);
		if (activeRunId) throw new AgentRunConflictError(activeRunId, conversationId);

		const id = randomUUID();
		const snapshot: AgentRunSnapshot = {
			id,
			agentId,
			conversationId,
			status: "queued",
			createdAt: new Date().toISOString(),
		};
		const record: RunRecord = {
			snapshot,
			definition,
			input: request.input,
			...(ownerId ? { ownerId } : {}),
			events: [],
			subscribers: new Set(),
			cancelRequested: false,
		};
		this.#runs.set(id, record);
		this.#activeConversations.set(conversationKey, id);
		record.completion = this.#execute(record, conversationKey);
		return this.#copySnapshot(record.snapshot);
	}

	get(runId: string, ownerId?: string, isAdmin = false): AgentRunSnapshot {
		return this.#copySnapshot(this.#requireOwned(runId, ownerId, isAdmin).snapshot);
	}

	subscribe(runId: string, listener: (event: AgentRunEvent) => void, ownerId?: string, isAdmin = false): () => void {
		const record = this.#requireOwned(runId, ownerId, isAdmin);
		for (const event of record.events) listener(event);
		if (isTerminalStatus(record.snapshot.status)) return () => {};
		record.subscribers.add(listener);
		return () => record.subscribers.delete(listener);
	}

	async abort(runId: string, ownerId?: string, isAdmin = false): Promise<AgentRunSnapshot> {
		const record = this.#requireOwned(runId, ownerId, isAdmin);
		if (isTerminalStatus(record.snapshot.status)) return this.#copySnapshot(record.snapshot);
		record.cancelRequested = true;
		if (record.runtime) await record.runtime.abort();
		return this.#copySnapshot(record.snapshot);
	}

	async close(): Promise<void> {
		this.#closing = true;
		const active = [...this.#runs.values()].filter((record) => !isTerminalStatus(record.snapshot.status));
		await Promise.allSettled(
			active.map(async (record) => {
				record.cancelRequested = true;
				if (record.runtime) await record.runtime.abort();
				if (record.completion) await record.completion;
			}),
		);
	}

	async #execute(record: RunRecord, conversationKey: string): Promise<void> {
		const startedAt = new Date().toISOString();
		record.snapshot = { ...record.snapshot, status: "running", startedAt };
		this.#publish(record, {
			type: "run_started",
			runId: record.snapshot.id,
			agentId: record.snapshot.agentId,
			conversationId: record.snapshot.conversationId,
			timestamp: startedAt,
		});

		let unsubscribe = (): void => {};
		try {
			if (record.cancelRequested) {
				this.#finishCancelled(record);
				return;
			}

			const runtime = await this.#factory.create(record.definition, record.snapshot.conversationId, record.ownerId);
			record.runtime = runtime;
			unsubscribe = runtime.subscribe((event) => {
				this.#publish(record, {
					type: "agent_event",
					runId: record.snapshot.id,
					event,
					timestamp: new Date().toISOString(),
				});
			});

			if (record.cancelRequested) {
				await runtime.abort();
				this.#finishCancelled(record);
				return;
			}

			await runtime.prompt(record.input);
			if (record.cancelRequested) {
				this.#finishCancelled(record);
				return;
			}

			const messages = [...runtime.messages];
			const lastAssistant = [...messages].reverse().find(isAssistantMessage);
			const result: AgentRunResult = {
				messages,
				output: lastAssistant ? contentText(lastAssistant.content) : "",
			};
			const finishedAt = new Date().toISOString();
			record.snapshot = {
				...record.snapshot,
				status: "completed",
				finishedAt,
				result,
			};
			this.#publish(record, { type: "run_completed", runId: record.snapshot.id, result, timestamp: finishedAt });
		} catch (error) {
			if (record.cancelRequested) {
				this.#finishCancelled(record);
			} else {
				const message = error instanceof Error ? error.message : "Agent run failed";
				const finishedAt = new Date().toISOString();
				record.snapshot = {
					...record.snapshot,
					status: "failed",
					finishedAt,
					error: message,
				};
				this.#publish(record, {
					type: "run_failed",
					runId: record.snapshot.id,
					error: message,
					timestamp: finishedAt,
				});
			}
		} finally {
			unsubscribe();
			try {
				record.runtime?.dispose();
			} catch (error) {
				this.#reportError(error);
			}
			record.runtime = undefined;
			if (this.#activeConversations.get(conversationKey) === record.snapshot.id) {
				this.#activeConversations.delete(conversationKey);
			}
			this.#prune();
		}
	}

	#finishCancelled(record: RunRecord): void {
		if (isTerminalStatus(record.snapshot.status)) return;
		const finishedAt = new Date().toISOString();
		record.snapshot = { ...record.snapshot, status: "cancelled", finishedAt };
		this.#publish(record, { type: "run_cancelled", runId: record.snapshot.id, timestamp: finishedAt });
	}

	#publish(record: RunRecord, event: AgentRunEvent): void {
		if (record.events.length >= this.#maxEventsPerRun) record.events.shift();
		record.events.push(event);
		for (const listener of [...record.subscribers]) {
			try {
				listener(event);
			} catch (error) {
				record.subscribers.delete(listener);
				this.#reportError(error);
			}
		}
	}

	#require(runId: string): RunRecord {
		const record = this.#runs.get(runId);
		if (!record) throw new AgentRunNotFoundError(runId);
		return record;
	}

	#requireOwned(runId: string, ownerId: string | undefined, isAdmin: boolean): RunRecord {
		const record = this.#require(runId);
		if (!isAdmin && record.ownerId !== ownerId) throw new AgentRunNotFoundError(runId);
		return record;
	}

	#copySnapshot(snapshot: AgentRunSnapshot): AgentRunSnapshot {
		return {
			...snapshot,
			result: snapshot.result
				? { messages: [...snapshot.result.messages], output: snapshot.result.output }
				: undefined,
		};
	}

	#prune(): void {
		while (this.#runs.size > this.#maxRunHistory) {
			let removed = false;
			for (const [runId, record] of this.#runs) {
				if (isTerminalStatus(record.snapshot.status) && record.subscribers.size === 0) {
					this.#runs.delete(runId);
					removed = true;
					break;
				}
			}
			if (!removed) return;
		}
	}

	#reportError(error: unknown): void {
		try {
			this.#onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Diagnostics cannot affect a run.
		}
	}
}

function makeConversationKey(ownerId: string | undefined, agentId: string, conversationId: string): string {
	return JSON.stringify([ownerId ?? null, agentId, conversationId]);
}

function isAssistantMessage(message: AgentRunResult["messages"][number]): message is AssistantMessage {
	return message.role === "assistant";
}

function isTerminalStatus(status: AgentRunStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}
