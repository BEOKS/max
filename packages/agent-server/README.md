# pi-agent-server

HTTP server for running multiple server-owned pi coding-agent definitions.

This is a private application package in the monorepo. It uses the coding-agent SDK in-process and exposes asynchronous runs over HTTP.

## Start

```bash
cp packages/agent-server/agent-server.config.example.json agent-server.config.json
npm run build
node packages/agent-server/dist/main.js --config agent-server.config.json
```

Provider credentials are read from the configured `agentDir` (normally `~/.pi/agent`) or from the provider's supported environment variables. Set `PI_AGENT_SERVER_TOKEN` when the server binds outside localhost.

## API

Start a run for one configured agent:

```bash
curl -X POST http://127.0.0.1:8787/v1/agents/code-review/runs \
  -H 'content-type: application/json' \
  -d '{"conversationId":"review-1","input":"Review the current changes"}'
```

The response is `202 Accepted` with a `runId`. Poll the status or consume the event stream:

```text
GET  /healthz
GET  /v1/agents
POST /v1/agents/:agentId/runs
GET  /v1/runs/:runId
GET  /v1/runs/:runId/events
POST /v1/runs/:runId/abort
```

`conversationId` is optional. Without it, the server creates an isolated conversation. With it, persistent agents resume the corresponding session file. Only one run per agent/conversation can be active at a time; conflicting requests return `409`.

The client must select an agent by URL. Model, system prompt, working directory, and tools are always taken from the server-side definition.

## Configuration

See `agent-server.config.example.json`. Each entry under `agents` defines an independent model, prompt, working directory, tool allowlist, and persistence policy. `sessionDir` supports `~` and the `{agentid}` placeholder; the example stores each agent's sessions under `~/.pi/agent-server-/{agentid}/session`. Project-local resources are disabled by default; enable `loadProjectResources` only for trusted workspaces.

This server deliberately has no built-in sandbox. Agents with `bash`, `write`, or `edit` need OS/container/VM isolation and an authenticated deployment boundary.

## Integration test

The Gemma integration test is skipped by default. Run it explicitly with a configured local provider:

```bash
PI_AGENT_SERVER_GEMMA_INTEGRATION=1 \
PI_AGENT_DIR=/absolute/path/to/.pi/agent \
npm run test --workspace=@earendil-works/pi-agent-server -- test/integration.test.ts
```

The test discovers an authenticated Gemma model from `models.json`, verifies the HTTP API and SSE stream, and confirms that the persistent session file is created.
