import { AgentNotFoundError } from "./errors.ts";
import type { AgentDefinition, AgentPublicMetadata } from "./types.ts";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isSafeIdentifier(value: string): boolean {
	return SAFE_IDENTIFIER.test(value);
}

export function assertSafeIdentifier(value: string, description: string): void {
	if (!isSafeIdentifier(value)) {
		throw new Error(`${description} must match ${SAFE_IDENTIFIER.source}: ${value}`);
	}
}

export class AgentRegistry {
	readonly #agents: Map<string, AgentDefinition>;

	constructor(definitions: readonly AgentDefinition[]) {
		if (definitions.length === 0) throw new Error("At least one agent definition is required");
		this.#agents = new Map();
		for (const definition of definitions) {
			assertSafeIdentifier(definition.id, "Agent ID");
			if (this.#agents.has(definition.id)) throw new Error(`Duplicate agent ID: ${definition.id}`);
			this.#agents.set(definition.id, definition);
		}
	}

	get(agentId: string): AgentDefinition | undefined {
		return this.#agents.get(agentId);
	}

	require(agentId: string): AgentDefinition {
		const definition = this.get(agentId);
		if (!definition) throw new AgentNotFoundError(agentId);
		return definition;
	}

	list(): readonly AgentDefinition[] {
		return [...this.#agents.values()];
	}

	publicMetadata(): readonly AgentPublicMetadata[] {
		return this.list().map((definition) => ({
			id: definition.id,
			model: { ...definition.model },
			thinkingLevel: definition.thinkingLevel,
			tools: [...definition.tools],
			persistent: definition.persistent,
		}));
	}
}
