import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		alias: [
			{
				find: /^@earendil-works\/pi-agent-core$/u,
				replacement: fileURLToPath(new URL("../agent/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-agent-core\/(.+)$/u,
				replacement: `${fileURLToPath(new URL("../agent/src/", import.meta.url))}$1`,
			},
			{
				find: /^@earendil-works\/pi-ai$/u,
				replacement: fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-ai\/(.+)$/u,
				replacement: `${fileURLToPath(new URL("../ai/src/", import.meta.url))}$1`,
			},
			{
				find: /^@earendil-works\/pi-coding-agent$/u,
				replacement: fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url)),
			},
			{
				find: /^@earendil-works\/pi-coding-agent\/(.+)$/u,
				replacement: `${fileURLToPath(new URL("../coding-agent/src/", import.meta.url))}$1`,
			},
		],
	},
});
