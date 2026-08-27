# pi-agent-server

HTTP server for running multiple server-owned pi coding-agent definitions.

This is a private application package in the monorepo. It uses the coding-agent SDK in-process and exposes asynchronous runs over HTTP.

## Start

```bash
cp packages/agent-server/agent-server.config.example.json agent-server.config.json
npm run build
node packages/agent-server/dist/main.js --config agent-server.config.json
```

Provider credentials are read from the configured `agentDir` (normally `~/.pi/agent`) or from the provider's supported environment variables. Set `PI_AGENT_SERVER_TOKEN` when the server binds outside localhost. For multiple browser users, enable the `hiworks` block in the example config. The server then redirects each user through Hiworks OAuth and keeps the resulting access and refresh tokens only in server memory; the browser receives an opaque `HttpOnly` session cookie.

## API

Start a run for one configured agent:

```bash
curl -X POST http://127.0.0.1:18731/v1/agents/code-review/runs \
  -H 'content-type: application/json' \
  -d '{"conversationId":"review-1","input":"Review the current changes"}'
```

The response is `202 Accepted` with a `runId`. Poll the status or consume the event stream:

```text
GET  /healthz
GET  /
GET  /auth/hiworks/login
GET  /auth/hiworks/callback
GET  /auth/me
POST /auth/hiworks/logout
GET  /v1/agents
POST /v1/agents/:agentId/runs
GET  /v1/runs/:runId
GET  /v1/runs/:runId/events
POST /v1/runs/:runId/abort
```

`conversationId` is optional. Without it, the server creates an isolated conversation. With it, persistent agents resume the corresponding session file. Only one run per agent/conversation can be active at a time; conflicting requests return `409`.

The client must select an agent by URL. Model, system prompt, working directory, and tools are always taken from the server-side definition.

### Web UI

Open the server root (`/`) in a browser. When Hiworks authentication is enabled, unauthenticated requests are redirected to `/auth/hiworks/login`; after login the page provides agent selection, instruction submission, live execution events, run abort, and logout.

### Hiworks authentication

Open `/auth/hiworks/login` in the user's browser. After the Hiworks callback completes, use the session cookie for the `/v1/*` APIs. `GET /auth/me` returns the current user without exposing tokens, and `POST /auth/hiworks/logout` invalidates the server-side session.

The callback URL must be registered exactly in the Hiworks OAuth application. By default it is `{publicBaseUrl}{callbackPath}`; set `hiworks.redirectUri` or `PI_AGENT_SERVER_HIWORKS_REDIRECT_URI` when the registered URI must be specified explicitly. Use an HTTPS `publicBaseUrl` for a remote deployment. The built-in `gabia`/`dev` profile supplies the Hiworks endpoints; set `PI_AGENT_SERVER_HIWORKS_CLIENT_ID` and, when required, `PI_AGENT_SERVER_HIWORKS_CLIENT_SECRET` to override the client credentials. The server prints the final redirect URI at startup.

When Hiworks authentication is enabled, each user can access only their own runs, event streams, and abort operations. Persistent sessions are stored below the configured `sessionDir` in a SHA-256-derived user directory, for example `~/.pi/agent-server-/{agentid}/session/<user-hash>/<conversationId>.jsonl`. `PI_AGENT_SERVER_TOKEN` remains an optional administrator credential with access to every user's runs. Authentication sessions are in memory, so a server restart requires users to log in again.

For API clients that can retain cookies, use a cookie jar after completing the browser login:

```bash
curl -b cookies.txt -c cookies.txt https://agents.example.com/auth/me
curl -b cookies.txt -c cookies.txt https://agents.example.com/v1/agents
```

## Configuration

See `agent-server.config.example.json`. Each entry under `agents` defines an independent model, prompt, working directory, tool allowlist, and persistence policy. `sessionDir` supports `~` and the `{agentid}` placeholder; the example stores each agent's sessions under `~/.pi/agent-server-/{agentid}/session`. The optional `hiworks` block enables multi-user browser login. `publicBaseUrl` must be reachable by the user's browser, and `callbackPath` must match the path in the registered OAuth redirect URI. Project-local resources are disabled by default; enable `loadProjectResources` only for trusted workspaces.

This server deliberately has no built-in sandbox. Agents with `bash`, `write`, or `edit` need OS/container/VM isolation and an authenticated deployment boundary.

## Integration test

The Gemma integration test is skipped by default. Run it explicitly with a configured local provider:

```bash
PI_AGENT_SERVER_GEMMA_INTEGRATION=1 \
PI_AGENT_DIR=/absolute/path/to/.pi/agent \
npm run test --workspace=@earendil-works/pi-agent-server -- test/integration.test.ts
```

The test discovers an authenticated Gemma model from `models.json`, verifies the HTTP API and SSE stream, and confirms that the persistent session file is created.
