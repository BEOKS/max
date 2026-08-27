export function renderAgentWebPage(): string {
	return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>PI Agent Control</title>
  <style>
    :root {
      color-scheme: dark;
      --ink: #edf1e8;
      --muted: #8d988f;
      --dim: #5f6a63;
      --panel: #171d1a;
      --panel-strong: #1d2520;
      --line: rgba(209, 230, 207, .13);
      --line-strong: rgba(209, 230, 207, .25);
      --accent: #d8f56a;
      --accent-ink: #18200f;
      --orange: #ff9e62;
      --red: #ff766e;
      --shadow: 0 24px 70px rgba(0, 0, 0, .28);
    }

    * { box-sizing: border-box; }
    html { min-width: 320px; background: #101411; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        radial-gradient(circle at 77% 0%, rgba(216, 245, 106, .13), transparent 26rem),
        radial-gradient(circle at 0% 75%, rgba(89, 139, 105, .13), transparent 25rem),
        linear-gradient(135deg, #111612 0%, #0e1210 56%, #151b17 100%);
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      letter-spacing: .01em;
    }

    body::before {
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      content: "";
      opacity: .18;
      background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
      background-size: 42px 42px;
      mask-image: linear-gradient(to bottom, black, transparent 78%);
    }

    button, input, textarea { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .45; }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      max-width: 1480px;
      margin: 0 auto;
      padding: 1.25rem clamp(1rem, 4vw, 4rem);
      border-bottom: 1px solid var(--line);
    }

    .brand { display: flex; align-items: center; gap: .75rem; }
    .brand-mark {
      display: grid;
      width: 2.25rem;
      height: 2.25rem;
      place-items: center;
      color: var(--accent-ink);
      background: var(--accent);
      border-radius: .35rem;
      box-shadow: 0 0 0 5px rgba(216, 245, 106, .08);
      font: 900 1rem/1 "SFMono-Regular", Consolas, monospace;
    }
    .brand-copy { display: grid; gap: .14rem; }
    .brand-copy strong { font: 800 .94rem/1 "SFMono-Regular", Consolas, monospace; letter-spacing: .12em; }
    .brand-copy span { color: var(--muted); font-size: .68rem; letter-spacing: .12em; text-transform: uppercase; }

    .account { display: flex; align-items: center; gap: .75rem; }
    .account-copy { display: grid; gap: .16rem; text-align: right; }
    .account-copy strong { font-size: .82rem; }
    .account-copy span { color: var(--muted); font: .68rem/1.2 "SFMono-Regular", Consolas, monospace; }
    .avatar {
      display: grid;
      width: 2rem;
      height: 2rem;
      place-items: center;
      color: var(--accent);
      border: 1px solid rgba(216, 245, 106, .35);
      border-radius: 50%;
      font: 700 .75rem/1 "SFMono-Regular", Consolas, monospace;
    }
    .ghost-button {
      padding: .55rem .72rem;
      color: var(--muted);
      background: transparent;
      border: 1px solid var(--line);
      border-radius: .35rem;
      font-size: .72rem;
    }
    .ghost-button:hover { color: var(--ink); border-color: var(--line-strong); }

    .page {
      max-width: 1480px;
      margin: 0 auto;
      padding: clamp(1.5rem, 4vw, 4.5rem) clamp(1rem, 4vw, 4rem) 4rem;
    }

    .hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 2rem; margin-bottom: 2.4rem; }
    .eyebrow { display: flex; align-items: center; gap: .55rem; color: var(--accent); font: 700 .68rem/1.2 "SFMono-Regular", Consolas, monospace; letter-spacing: .16em; text-transform: uppercase; }
    .eyebrow::before { width: 1.8rem; height: 1px; content: ""; background: var(--accent); }
    h1 { max-width: 720px; margin: .7rem 0 .8rem; font: 500 clamp(2.2rem, 5.5vw, 5.4rem)/.94 Georgia, "Times New Roman", serif; letter-spacing: -.055em; }
    .intro { max-width: 610px; margin: 0; color: var(--muted); font-size: .95rem; line-height: 1.65; }
    .hero-stamp { display: grid; gap: .4rem; min-width: 170px; padding: 1rem; border: 1px solid var(--line); border-radius: .5rem; background: rgba(23, 29, 26, .68); box-shadow: var(--shadow); }
    .hero-stamp span { color: var(--muted); font: .62rem/1 "SFMono-Regular", Consolas, monospace; letter-spacing: .12em; text-transform: uppercase; }
    .hero-stamp strong { font: 700 1.25rem/1.1 "SFMono-Regular", Consolas, monospace; }
    .pulse { display: inline-flex; align-items: center; gap: .45rem; color: var(--accent); font-size: .72rem; }
    .pulse::before { width: .45rem; height: .45rem; content: ""; background: var(--accent); border-radius: 50%; box-shadow: 0 0 0 .22rem rgba(216,245,106,.12); }

    .workspace { display: grid; grid-template-columns: minmax(225px, .72fr) minmax(0, 1.8fr); gap: 1rem; align-items: start; }
    .panel { background: rgba(23, 29, 26, .88); border: 1px solid var(--line); border-radius: .58rem; box-shadow: var(--shadow); }
    .panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.1rem; border-bottom: 1px solid var(--line); }
    .panel-heading h2 { margin: 0; font: 700 .78rem/1 "SFMono-Regular", Consolas, monospace; letter-spacing: .1em; text-transform: uppercase; }
    .panel-heading span { color: var(--dim); font: .65rem/1 "SFMono-Regular", Consolas, monospace; }

    .agent-list { display: grid; gap: .55rem; padding: .75rem; }
    .agent-card { display: grid; gap: .6rem; width: 100%; padding: .9rem; color: var(--ink); text-align: left; background: transparent; border: 1px solid transparent; border-radius: .42rem; transition: border-color .2s, background .2s, transform .2s; }
    .agent-card:hover { background: rgba(216,245,106,.045); border-color: var(--line-strong); transform: translateX(2px); }
    .agent-card.active { background: rgba(216,245,106,.08); border-color: rgba(216,245,106,.38); }
    .agent-title { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .agent-title strong { font: 700 .82rem/1.2 "SFMono-Regular", Consolas, monospace; }
    .agent-index { color: var(--accent); font: .62rem/1 "SFMono-Regular", Consolas, monospace; }
    .agent-model { overflow: hidden; color: var(--muted); font: .7rem/1.4 "SFMono-Regular", Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .agent-meta { display: flex; flex-wrap: wrap; gap: .35rem; }
    .tag { padding: .25rem .4rem; color: var(--dim); border: 1px solid var(--line); border-radius: .22rem; font: .58rem/1 "SFMono-Regular", Consolas, monospace; text-transform: uppercase; }
    .empty { padding: 1.1rem; color: var(--muted); font-size: .8rem; line-height: 1.5; }

    .console { display: grid; gap: 1rem; }
    .composer { padding: clamp(1rem, 3vw, 1.5rem); }
    .field-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, .38fr); gap: .75rem; }
    label { display: grid; gap: .42rem; color: var(--muted); font: .64rem/1.2 "SFMono-Regular", Consolas, monospace; letter-spacing: .09em; text-transform: uppercase; }
    input, textarea { width: 100%; color: var(--ink); background: #111612; border: 1px solid var(--line); border-radius: .35rem; outline: none; transition: border-color .2s, box-shadow .2s; }
    input { min-height: 2.45rem; padding: .68rem .75rem; font-size: .8rem; }
    textarea { min-height: 150px; margin-top: .75rem; padding: .9rem; resize: vertical; font: .86rem/1.55 "Avenir Next", "Segoe UI", sans-serif; }
    input:focus, textarea:focus { border-color: rgba(216,245,106,.7); box-shadow: 0 0 0 3px rgba(216,245,106,.1); }
    .composer-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: .75rem; }
    .selected-note { min-width: 0; overflow: hidden; color: var(--dim); font: .66rem/1.4 "SFMono-Regular", Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .primary-button { padding: .72rem 1rem; color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); border-radius: .32rem; font: 800 .72rem/1 "SFMono-Regular", Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; box-shadow: 0 8px 24px rgba(216,245,106,.12); }
    .primary-button:hover { background: #e4fb85; }
    .danger-button { padding: .65rem .8rem; color: var(--red); background: transparent; border: 1px solid rgba(255,118,110,.3); border-radius: .32rem; font: 700 .68rem/1 "SFMono-Regular", Consolas, monospace; text-transform: uppercase; }
    .danger-button:hover { background: rgba(255,118,110,.08); border-color: rgba(255,118,110,.6); }

    .run-panel { min-height: 265px; }
    .run-body { padding: 1rem 1.1rem 1.15rem; }
    .run-summary { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .7rem; }
    .run-id { color: var(--muted); font: .68rem/1.4 "SFMono-Regular", Consolas, monospace; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; gap: .45rem; padding: .35rem .5rem; border-radius: .22rem; font: 700 .63rem/1 "SFMono-Regular", Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
    .status::before { width: .42rem; height: .42rem; content: ""; background: currentColor; border-radius: 50%; }
    .status.queued, .status.running { color: var(--orange); background: rgba(255,158,98,.09); }
    .status.running::before { animation: blink 1.15s ease-in-out infinite; }
    .status.completed { color: var(--accent); background: rgba(216,245,106,.09); }
    .status.failed, .status.cancelled { color: var(--red); background: rgba(255,118,110,.09); }
    .run-output { margin: 1rem 0 0; padding: 1rem; min-height: 105px; color: #d5dfd1; background: #101511; border: 1px solid var(--line); border-radius: .35rem; white-space: pre-wrap; overflow-wrap: anywhere; font: .8rem/1.6 "SFMono-Regular", Consolas, monospace; }
    .run-output.placeholder { color: var(--dim); }
    .log { display: grid; gap: .42rem; max-height: 210px; margin-top: .7rem; overflow: auto; }
    .log-line { display: grid; grid-template-columns: 5.4rem minmax(0, 1fr); gap: .55rem; color: var(--muted); font: .66rem/1.45 "SFMono-Regular", Consolas, monospace; }
    .log-line time { color: var(--dim); }
    .log-line strong { color: #c3d3bf; font-weight: 500; overflow-wrap: anywhere; }
    .notice { min-height: 1.2rem; margin: .7rem 0 0; color: var(--red); font-size: .75rem; }

    .footer-note { display: flex; justify-content: space-between; gap: 1rem; margin-top: 1.1rem; color: var(--dim); font: .62rem/1.4 "SFMono-Regular", Consolas, monospace; }
    @keyframes blink { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
    @media (max-width: 760px) {
      .topbar { align-items: flex-start; }
      .account-copy { display: none; }
      .hero { grid-template-columns: 1fr; }
      .hero-stamp { width: fit-content; }
      .workspace { grid-template-columns: 1fr; }
      .field-grid { grid-template-columns: 1fr; }
      .composer-footer, .footer-note { align-items: flex-start; flex-direction: column; }
      .primary-button { width: 100%; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark">π</div>
      <div class="brand-copy"><strong>PI / AGENT CONTROL</strong><span>private execution surface</span></div>
    </div>
    <div class="account">
      <div class="account-copy"><strong id="user-name">Loading identity</strong><span id="user-id">checking session</span></div>
      <div class="avatar" id="user-avatar">—</div>
      <button class="ghost-button" id="logout-button" type="button">Logout</button>
    </div>
  </header>

  <main class="page">
    <section class="hero">
      <div>
        <div class="eyebrow">authenticated workspace</div>
        <h1>Direct the work.<br><em>Watch it unfold.</em></h1>
        <p class="intro">Choose a server-defined agent, send a focused instruction, and follow its execution stream in real time. Models, tools, and working directories remain controlled by the server.</p>
      </div>
      <div class="hero-stamp"><span>control plane</span><strong>READY / 01</strong><span class="pulse">live channel</span></div>
    </section>

    <section class="workspace">
      <aside class="panel">
        <div class="panel-heading"><h2>Agents</h2><span id="agent-count">0 online</span></div>
        <div class="agent-list" id="agent-list"><div class="empty">Loading server agents…</div></div>
      </aside>

      <div class="console">
        <section class="panel composer">
          <div class="panel-heading" style="padding:0 0 1rem;border-bottom:0"><h2>New instruction</h2><span id="selected-agent-label">select an agent</span></div>
          <form id="run-form">
            <div class="field-grid">
              <label>Conversation ID<input id="conversation-id" name="conversationId" placeholder="optional / resumes a session" autocomplete="off"></label>
              <label>Mode<input value="server-defined" readonly aria-label="Agent mode"></label>
            </div>
            <label for="prompt"><span style="margin-top:.75rem">Instruction</span><textarea id="prompt" name="prompt" placeholder="Describe the work you want the agent to perform…" required></textarea></label>
            <div class="composer-footer"><span class="selected-note" id="selected-agent-note">No agent selected</span><button class="primary-button" id="run-button" type="submit" disabled>Launch run ↗</button></div>
          </form>
          <p class="notice" id="notice" role="alert"></p>
        </section>

        <section class="panel run-panel">
          <div class="panel-heading"><h2>Execution monitor</h2><button class="danger-button" id="abort-button" type="button" hidden>Abort run</button></div>
          <div class="run-body">
            <div class="run-summary"><span class="status queued" id="run-status" hidden>queued</span><span class="run-id" id="run-id">No active run. Launch an instruction to begin.</span></div>
            <pre class="run-output placeholder" id="run-output">Your agent's final response will appear here.</pre>
            <div class="log" id="event-log" aria-live="polite"><div class="log-line"><time>—</time><strong>Waiting for a run.</strong></div></div>
          </div>
        </section>
      </div>
    </section>
    <div class="footer-note"><span>PI AGENT SERVER / SESSION-SCOPED CONTROL</span><span id="clock"></span></div>
  </main>

  <script>
    (() => {
      const state = { agents: [], selectedAgent: '', run: null, source: null, poll: null };
      const byId = (id) => document.getElementById(id);
      const agentList = byId('agent-list');
      const runButton = byId('run-button');
      const abortButton = byId('abort-button');
      const status = byId('run-status');
      const output = byId('run-output');
      const notice = byId('notice');
      const eventLog = byId('event-log');

      function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
      }

      async function api(path, options) {
        const response = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
        const contentType = response.headers.get('content-type') || '';
        const body = contentType.includes('application/json') ? await response.json() : await response.text();
        if (response.status === 401) {
          window.location.assign('/auth/hiworks/login');
          throw new Error('Authentication required');
        }
        if (!response.ok) throw new Error(body && body.error ? body.error.message : 'Request failed');
        return body;
      }

      function setNotice(message) { notice.textContent = message || ''; }

      function addLog(label, message) {
        const line = document.createElement('div');
        line.className = 'log-line';
        line.innerHTML = '<time>' + escapeHtml(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })) + '</time><strong>' + escapeHtml(label + (message ? ' — ' + message : '')) + '</strong>';
        eventLog.prepend(line);
        while (eventLog.children.length > 80) eventLog.lastElementChild.remove();
      }

      function renderAgents() {
        byId('agent-count').textContent = state.agents.length + ' online';
        if (!state.agents.length) {
          agentList.innerHTML = '<div class="empty">No server agents are configured.</div>';
          return;
        }
        agentList.innerHTML = state.agents.map((agent, index) => {
          const active = agent.id === state.selectedAgent ? ' active' : '';
          const tags = (agent.tools || []).slice(0, 4).map((tool) => '<span class="tag">' + escapeHtml(tool) + '</span>').join('');
          return '<button class="agent-card' + active + '" type="button" data-agent-id="' + escapeHtml(agent.id) + '">' +
            '<span class="agent-title"><strong>' + escapeHtml(agent.id) + '</strong><span class="agent-index">0' + (index + 1) + '</span></span>' +
            '<span class="agent-model">' + escapeHtml(agent.model.provider + ' / ' + agent.model.id) + '</span>' +
            '<span class="agent-meta">' + tags + (agent.persistent ? '<span class="tag">persistent</span>' : '') + '</span></button>';
        }).join('');
        agentList.querySelectorAll('[data-agent-id]').forEach((button) => button.addEventListener('click', () => {
          state.selectedAgent = button.getAttribute('data-agent-id');
          renderAgents();
          updateSelectedAgent();
        }));
      }

      function updateSelectedAgent() {
        const agent = state.agents.find((item) => item.id === state.selectedAgent);
        runButton.disabled = !agent || Boolean(state.run && !isTerminal(state.run.status));
        byId('selected-agent-label').textContent = agent ? agent.id : 'select an agent';
        byId('selected-agent-note').textContent = agent ? agent.model.provider + ' / ' + agent.model.id : 'No agent selected';
      }

      function isTerminal(value) { return value === 'completed' || value === 'failed' || value === 'cancelled'; }

      function updateRun(snapshot) {
        state.run = Object.assign({}, state.run || {}, snapshot);
        status.hidden = false;
        status.textContent = state.run.status;
        status.className = 'status ' + state.run.status;
        byId('run-id').textContent = 'run ' + state.run.id + '  /  conversation ' + state.run.conversationId;
        if (state.run.result && typeof state.run.result.output === 'string') {
          output.textContent = state.run.result.output || '(empty response)';
          output.classList.remove('placeholder');
        }
        if (state.run.error) {
          output.textContent = state.run.error;
          output.classList.remove('placeholder');
        }
        const active = !isTerminal(state.run.status);
        abortButton.hidden = !active;
        updateSelectedAgent();
        if (!active) stopTracking();
      }

      function handleEvent(event) {
        if (event.type === 'run_started') addLog('run started', event.agentId + ' / ' + event.conversationId);
        if (event.type === 'agent_event') addLog('agent event', event.event && event.event.type ? event.event.type : 'stream update');
        if (event.type === 'run_completed') { addLog('run completed', 'response received'); updateRun({ status: 'completed', result: event.result }); }
        if (event.type === 'run_failed') { addLog('run failed', event.error); updateRun({ status: 'failed', error: event.error }); }
        if (event.type === 'run_cancelled') { addLog('run cancelled', 'abort acknowledged'); updateRun({ status: 'cancelled' }); }
      }

      function stopTracking() {
        if (state.source) { state.source.close(); state.source = null; }
        if (state.poll) { window.clearInterval(state.poll); state.poll = null; }
      }

      function trackRun(run) {
        stopTracking();
        state.source = new EventSource(run.eventsUrl);
        ['run_started', 'agent_event', 'run_completed', 'run_failed', 'run_cancelled'].forEach((eventName) => state.source.addEventListener(eventName, (event) => {
          try { handleEvent(JSON.parse(event.data)); } catch (error) { addLog('stream parse error', error.message); }
        }));
        state.source.onerror = () => { if (state.run && !isTerminal(state.run.status)) addLog('stream reconnecting', 'waiting for server'); };
        state.poll = window.setInterval(async () => {
          if (!state.run || isTerminal(state.run.status)) return;
          try { updateRun(await api(state.run.statusUrl)); } catch (error) { setNotice(error.message); }
        }, 1500);
      }

      async function launchRun(event) {
        event.preventDefault();
        setNotice('');
        const agent = state.agents.find((item) => item.id === state.selectedAgent);
        const input = byId('prompt').value.trim();
        if (!agent || !input) { setNotice('Select an agent and enter an instruction.'); return; }
        runButton.disabled = true;
        output.textContent = 'Agent is starting…';
        output.classList.add('placeholder');
        eventLog.innerHTML = '';
        addLog('request queued', agent.id);
        const body = { input: input };
        const conversationId = byId('conversation-id').value.trim();
        if (conversationId) body.conversationId = conversationId;
        try {
          const run = await api('/v1/agents/' + encodeURIComponent(agent.id) + '/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          updateRun(run);
          trackRun(run);
        } catch (error) {
          setNotice(error.message);
          addLog('request rejected', error.message);
          updateSelectedAgent();
        }
      }

      async function abortRun() {
        if (!state.run || isTerminal(state.run.status)) return;
        abortButton.disabled = true;
        try { updateRun(await api('/v1/runs/' + encodeURIComponent(state.run.id) + '/abort', { method: 'POST' })); addLog('abort requested', ''); }
        catch (error) { setNotice(error.message); abortButton.disabled = false; }
      }

      async function loadIdentity() {
        const me = await api('/auth/me');
        if (!me.authenticated) { window.location.assign('/auth/hiworks/login'); return false; }
        const user = me.user || {};
        const label = user.displayName || user.email || user.id || 'Hiworks user';
        byId('user-name').textContent = label;
        byId('user-id').textContent = user.email || user.id || 'authenticated';
        byId('user-avatar').textContent = label.slice(0, 1).toUpperCase();
        return true;
      }

      async function load() {
        try {
          if (!await loadIdentity()) return;
          const response = await api('/v1/agents');
          state.agents = response.agents || [];
          state.selectedAgent = state.agents[0] ? state.agents[0].id : '';
          renderAgents();
          updateSelectedAgent();
        } catch (error) { setNotice(error.message); }
      }

      byId('run-form').addEventListener('submit', launchRun);
      abortButton.addEventListener('click', abortRun);
      byId('logout-button').addEventListener('click', async () => {
        try { await api('/auth/hiworks/logout', { method: 'POST' }); } finally { window.location.assign('/'); }
      });
      byId('clock').textContent = new Date().toISOString().slice(0, 10) + ' / local control';
      load();
    })();
  </script>
</body>
</html>`;
}
