export class AgentServerError extends Error {
	readonly code: string;
	readonly statusCode: number;

	constructor(code: string, statusCode: number, message: string) {
		super(message);
		this.name = "AgentServerError";
		this.code = code;
		this.statusCode = statusCode;
	}
}

export class AgentNotFoundError extends AgentServerError {
	constructor(agentId: string) {
		super("agent_not_found", 404, `Unknown agent: ${agentId}`);
		this.name = "AgentNotFoundError";
	}
}

export class AgentRunNotFoundError extends AgentServerError {
	constructor(runId: string) {
		super("run_not_found", 404, `Unknown run: ${runId}`);
		this.name = "AgentRunNotFoundError";
	}
}

export class AgentRunConflictError extends AgentServerError {
	readonly runId: string;

	constructor(runId: string, conversationId: string) {
		super("conversation_busy", 409, `Conversation is already running: ${conversationId}`);
		this.name = "AgentRunConflictError";
		this.runId = runId;
	}
}
