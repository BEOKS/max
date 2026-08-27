import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	AgentSessionEvent,
	SessionContext,
	SessionEntry,
	SessionHeader,
	SessionTreeNode,
} from "@earendil-works/pi-coding-agent";

export interface AgentModelReference {
	provider: string;
	id: string;
}

/** Server-owned configuration for one named agent. */
export interface AgentDefinition {
	readonly id: string;
	readonly cwd: string;
	readonly model: AgentModelReference;
	readonly thinkingLevel: ThinkingLevel;
	readonly systemPrompt: string;
	readonly tools: readonly string[];
	readonly persistent: boolean;
	readonly loadProjectResources: boolean;
}

export interface AgentPublicMetadata {
	readonly id: string;
	readonly model: AgentModelReference;
	readonly thinkingLevel: ThinkingLevel;
	readonly tools: readonly string[];
	readonly persistent: boolean;
}

/** Small runtime boundary that keeps the HTTP layer independent of coding-agent internals. */
export interface AgentRuntime {
	readonly messages: readonly AgentMessage[];
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	dispose(): void;
}

export interface AgentRuntimeFactory {
	prepare(definitions: readonly AgentDefinition[]): Promise<void>;
	create(definition: AgentDefinition, sessionId: string, ownerId?: string): Promise<AgentRuntime>;
	readSession?(
		definition: AgentDefinition,
		sessionId: string,
		ownerId?: string,
	): Promise<AgentSessionSnapshot | undefined>;
}

export interface AgentSessionSnapshot {
	readonly piSessionId: string;
	readonly header: SessionHeader | null;
	readonly entries: readonly SessionEntry[];
	readonly tree: readonly SessionTreeNode[];
	readonly context: SessionContext;
	readonly sessionName?: string;
	readonly leafId: string | null;
}

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AgentRunRequest {
	readonly input: string;
	readonly sessionId?: string;
}

export interface AgentRunResult {
	readonly messages: readonly AgentMessage[];
	readonly output: string;
}

export interface AgentRunSnapshot {
	readonly id: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly status: AgentRunStatus;
	readonly createdAt: string;
	readonly startedAt?: string;
	readonly finishedAt?: string;
	readonly result?: AgentRunResult;
	readonly error?: string;
}

export type AgentRunEvent =
	| {
			type: "run_started";
			runId: string;
			agentId: string;
			sessionId: string;
			timestamp: string;
	  }
	| {
			type: "agent_event";
			runId: string;
			event: AgentSessionEvent;
			timestamp: string;
	  }
	| {
			type: "run_completed";
			runId: string;
			result: AgentRunResult;
			timestamp: string;
	  }
	| {
			type: "run_failed";
			runId: string;
			error: string;
			timestamp: string;
	  }
	| {
			type: "run_cancelled";
			runId: string;
			timestamp: string;
	  };
