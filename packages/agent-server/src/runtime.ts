import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentRuntime, AgentRuntimeFactory, AgentSessionSnapshot } from "./types.ts";

export interface CodingAgentRuntimeFactoryOptions {
	agentDir: string;
	sessionDir: string;
	credentialsForOwner?: (ownerId: string, fallback: CredentialStore) => CredentialStore;
}

export class CodingAgentRuntimeFactory implements AgentRuntimeFactory {
	readonly #agentDir: string;
	readonly #sessionDir: string;
	readonly #credentialsForOwner: CodingAgentRuntimeFactoryOptions["credentialsForOwner"];
	readonly #fallbackCredentials: CredentialStore;
	readonly #modelRuntimePromises = new Map<string, Promise<ModelRuntime>>();

	constructor(options: CodingAgentRuntimeFactoryOptions) {
		this.#agentDir = resolve(options.agentDir);
		this.#sessionDir = options.sessionDir;
		this.#credentialsForOwner = options.credentialsForOwner;
		this.#fallbackCredentials = AuthStorage.create(join(this.#agentDir, "auth.json"));
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

	async create(definition: AgentDefinition, sessionId: string, ownerId?: string): Promise<AgentRuntime> {
		const modelRuntime = await this.#getModelRuntime(ownerId);
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

		const sessionManager = await this.#createSessionManager(definition, sessionId, ownerId);
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

	async readSession(
		definition: AgentDefinition,
		sessionId: string,
		ownerId?: string,
	): Promise<AgentSessionSnapshot | undefined> {
		if (!definition.persistent) return undefined;
		const agentSessionDir = resolveUserSessionDir(this.#sessionDir, definition.id, ownerId);
		const sessionPath = join(agentSessionDir, `${sessionId}.jsonl`);
		try {
			await access(sessionPath);
		} catch (error) {
			if (isFileNotFoundError(error)) return undefined;
			throw error;
		}

		const sessionManager = SessionManager.open(sessionPath, agentSessionDir, definition.cwd);
		return {
			piSessionId: sessionManager.getSessionId(),
			header: sessionManager.getHeader(),
			entries: sessionManager.getEntries(),
			tree: sessionManager.getTree(),
			context: sessionManager.buildSessionContext(),
			sessionName: sessionManager.getSessionName(),
			leafId: sessionManager.getLeafId(),
		};
	}

	async #getModelRuntime(ownerId?: string): Promise<ModelRuntime> {
		const key = ownerId ?? "__server__";
		const existing = this.#modelRuntimePromises.get(key);
		if (existing) return existing;
		const credentials =
			ownerId && this.#credentialsForOwner
				? this.#credentialsForOwner(ownerId, this.#fallbackCredentials)
				: this.#fallbackCredentials;
		const promise = ModelRuntime.create({
			credentials,
			modelsPath: join(this.#agentDir, "models.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		this.#modelRuntimePromises.set(key, promise);
		try {
			return await promise;
		} catch (error) {
			if (this.#modelRuntimePromises.get(key) === promise) this.#modelRuntimePromises.delete(key);
			throw error;
		}
	}

	async #createSessionManager(
		definition: AgentDefinition,
		sessionId: string,
		ownerId?: string,
	): Promise<SessionManager> {
		if (!definition.persistent) return SessionManager.inMemory(definition.cwd);
		const agentSessionDir = resolveUserSessionDir(this.#sessionDir, definition.id, ownerId);
		await mkdir(agentSessionDir, { recursive: true });
		const sessionPath = join(agentSessionDir, `${sessionId}.jsonl`);
		return SessionManager.open(sessionPath, agentSessionDir, definition.cwd);
	}
}

function resolveUserSessionDir(template: string, agentId: string, ownerId: string | undefined): string {
	const agentSessionDir = resolveAgentSessionDir(template, agentId);
	if (!ownerId) return agentSessionDir;
	const ownerDirectory = createHash("sha256").update(ownerId).digest("hex").slice(0, 32);
	return join(agentSessionDir, ownerDirectory);
}

function isFileNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function resolveAgentSessionDir(template: string, agentId: string): string {
	const withAgentId = template.replaceAll("{agentid}", agentId);
	const withHome =
		withAgentId === "~" || withAgentId.startsWith("~/") ? join(homedir(), withAgentId.slice(1)) : withAgentId;
	return template.includes("{agentid}") ? resolve(withHome) : join(resolve(withHome), agentId);
}
