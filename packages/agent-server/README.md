# pi-agent-server

HTTP server for running multiple server-owned pi coding-agent definitions.

This private application package uses the coding-agent SDK in-process and exposes asynchronous runs over HTTP. Browser authentication uses the OpenAI Codex device-code flow; email/password authentication and the previous Hiworks browser login are not included.

## Run

```bash
cp packages/agent-server/agent-server.config.example.json agent-server.config.json
npm run dev --workspace=@earendil-works/pi-agent-server -- --config agent-server.config.json
```

Open the server root (`/`) in a browser. The page automatically starts a Codex device-code login for an unauthenticated browser. Open the displayed verification URL, enter the displayed code, and keep the page open until authentication completes.

The server stores Codex account records, OAuth credentials, and browser sessions in `authFile`. The file contains refresh tokens and must be protected like a secret. Sessions are opaque `HttpOnly` cookies and survive page re-entry and server restarts until `authSessionTtlMs` expires. Set `secureCookies` to `true` for HTTPS deployments.

## API

```text
GET  /healthz
GET  /
GET  /auth/me
POST /auth/device/start
GET  /auth/device/status?loginId=...
POST /auth/device/cancel?loginId=...
POST /auth/logout
GET  /v1/agents
POST /v1/agents/:agentId/runs
GET  /v1/agents/:agentId/sessions/:sessionId
GET  /v1/runs/:runId
GET  /v1/runs/:runId/events
POST /v1/runs/:runId/abort
```

Start a device-code login with a cookie jar:

```bash
curl -c cookies.txt -X POST http://127.0.0.1:18731/auth/device/start
curl -b cookies.txt -c cookies.txt 'http://127.0.0.1:18731/auth/device/status?loginId=LOGIN_ID'
```

`/auth/device/start` returns a verification URL, user code, login ID, and expiry. Poll the status endpoint until it returns `complete`; that response sets the authenticated session cookie. The service uses the Codex account ID as the stable user ID and stores each user's Codex credential separately.

`sessionId` is optional when starting a run. Without it, the server creates an isolated session. With it, persistent agents resume the corresponding Pi session file. Each authenticated Codex account has its own session namespace. Only one run per agent/session can be active at a time; conflicting requests return `409`.

The client must select an agent by URL. Model, system prompt, working directory, and tools are always taken from the server-side definition. `PI_AGENT_SERVER_TOKEN` remains an optional administrator credential with access to every user's runs.

## Configuration

See `agent-server.config.example.json`. Each entry under `agents` defines an independent model, prompt, working directory, tool allowlist, and persistence policy. `sessionDir` supports `~` and the `{agentid}` placeholder. `authFile` defaults to `~/.pi/agent-server/codex-auth.json`; `authSessionTtlMs` defaults to 30 days and `authPendingTtlMs` to 15 minutes.

The Gemma integration test is skipped by default. Run it explicitly with a configured local provider:

```bash
PI_AGENT_SERVER_GEMMA_INTEGRATION=1 \
PI_AGENT_DIR=/absolute/path/to/.pi/agent \
npm run test --workspace=@earendil-works/pi-agent-server -- test/integration.test.ts
```

This server deliberately has no built-in sandbox. Agents with `bash`, `write`, or `edit` need OS/container/VM isolation and an authenticated deployment boundary.
