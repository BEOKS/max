import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentRuntime, AgentRuntimeFactory } from "./types.ts";

export interface CodingAgentRuntimeFactoryOptions {
	agentDir: string;
	sessionDir: string;
}

export class CodingAgentRuntimeFactory implements AgentRuntimeFactory {
	readonly #agentDir: string;
	readonly #sessionDir: string;
	#modelRuntimePromise: Promise<ModelRuntime> | undefined;

	constructor(options: CodingAgentRuntimeFactoryOptions) {
		this.#agentDir = resolve(options.agentDir);
		this.#sessionDir = options.sessionDir;
	}

	async prepare(definitions: readonly AgentDefinition[]): Promise<void> {
		const modelRuntime = await this.#getModelRuntime();
		for (const definition of definitions) {
			if (!modelRuntime.getModel(definition.model.provider, definition.model.id)) {
				throw new Error(
					`Model not found for agent ${definition.id}: ${definition.model.provider}/${definition.model.id}`,
				);
			}
		}
	}

	async create(definition: AgentDefinition, conversationId: string): Promise<AgentRuntime> {
		const modelRuntime = await this.#getModelRuntime();
		const model = modelRuntime.getModel(definition.model.provider, definition.model.id);
		if (!model) {
			throw new Error(
				`Model not found for agent ${definition.id}: ${definition.model.provider}/${definition.model.id}`,
			);
		}

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: definition.cwd,
			agentDir: this.#agentDir,
			settingsManager,
			systemPromptOverride: () => definition.systemPrompt,
			appendSystemPromptOverride: () => [],
			noExtensions: !definition.loadProjectResources,
			noSkills: !definition.loadProjectResources,
			noPromptTemplates: !definition.loadProjectResources,
			noContextFiles: !definition.loadProjectResources,
		});
		await resourceLoader.reload();

		const sessionManager = await this.#createSessionManager(definition, conversationId);
		const created = await createAgentSession({
			cwd: definition.cwd,
			agentDir: this.#agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager,
			model,
			thinkingLevel: definition.thinkingLevel,
			tools: [...definition.tools],
		});

		const session = created.session;
		return {
			get messages() {
				return session.messages;
			},
			prompt: (text: string) => session.prompt(text, { source: "rpc" }),
			abort: () => session.abort(),
			subscribe: (listener) => session.subscribe(listener),
			dispose: () => session.dispose(),
		};
	}

	async #getModelRuntime(): Promise<ModelRuntime> {
		const existing = this.#modelRuntimePromise;
		if (existing) return existing;
		const promise = ModelRuntime.create({
			authPath: join(this.#agentDir, "auth.json"),
			modelsPath: join(this.#agentDir, "models.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		this.#modelRuntimePromise = promise;
		try {
			return await promise;
		} catch (error) {
			if (this.#modelRuntimePromise === promise) this.#modelRuntimePromise = undefined;
			throw error;
		}
	}

	async #createSessionManager(definition: AgentDefinition, conversationId: string): Promise<SessionManager> {
		if (!definition.persistent) return SessionManager.inMemory(definition.cwd);
		const agentSessionDir = resolveAgentSessionDir(this.#sessionDir, definition.id);
		await mkdir(agentSessionDir, { recursive: true });
		const sessionPath = join(agentSessionDir, `${conversationId}.jsonl`);
		return SessionManager.open(sessionPath, agentSessionDir, definition.cwd);
	}
}

function resolveAgentSessionDir(template: string, agentId: string): string {
	const withAgentId = template.replaceAll("{agentid}", agentId);
	const withHome =
		withAgentId === "~" || withAgentId.startsWith("~/") ? join(homedir(), withAgentId.slice(1)) : withAgentId;
	return template.includes("{agentid}") ? resolve(withHome) : join(resolve(withHome), agentId);
}
