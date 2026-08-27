export function renderAgentWebPage(): string {
	return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PI Agent Server</title>
  <style>
    :root {
      color-scheme: light;
      --background: #f5f6f4;
      --surface: #ffffff;
      --text: #18201b;
      --muted: #68736b;
      --border: #dce2dc;
      --accent: #2f6b45;
      --accent-hover: #245536;
      --danger: #b04438;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      min-height: 100vh;
      color: var(--text);
      background: var(--background);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    .container { width: min(760px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 1.35rem; letter-spacing: -.02em; }
    h2 { font-size: 1rem; }
    .subtitle { margin-top: 4px; color: var(--muted); font-size: .85rem; }
    .account { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: .8rem; }
    .logout { padding: 6px 10px; color: var(--text); background: transparent; border: 1px solid var(--border); border-radius: 5px; font-size: .78rem; }
    .logout:hover { background: var(--surface); border-color: #bac5bc; }
    .card { padding: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
    .card + .card { margin-top: 14px; }
    .field { display: grid; gap: 6px; }
    .field + .field { margin-top: 14px; }
    label { color: var(--muted); font-size: .78rem; font-weight: 600; }
    input, select, textarea { width: 100%; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 5px; outline: none; }
    input, select { height: 40px; padding: 0 10px; }
    textarea { min-height: 150px; padding: 10px; resize: vertical; line-height: 1.5; }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(47, 107, 69, .12); }
    .agent-meta { min-height: 18px; color: var(--muted); font-size: .78rem; }
    .actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    .primary { padding: 9px 14px; color: white; background: var(--accent); border: 1px solid var(--accent); border-radius: 5px; font-weight: 650; }
    .primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    .secondary { padding: 9px 14px; color: var(--danger); background: transparent; border: 1px solid #e2b8b3; border-radius: 5px; }
    .secondary:hover { background: #fff7f6; }
    .error { min-height: 20px; margin-top: 10px; color: var(--danger); font-size: .82rem; }
    .result-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .status { padding: 4px 8px; border-radius: 4px; font-size: .72rem; font-weight: 700; }
    .status.queued, .status.running { color: #8a5b00; background: #fff5d8; }
    .status.completed { color: #24633a; background: #e6f4e9; }
    .status.failed, .status.cancelled { color: #96372f; background: #fbe9e7; }
    .run-info { margin-top: 12px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .75rem; overflow-wrap: anywhere; }
    pre { margin: 14px 0 0; min-height: 120px; padding: 12px; overflow: auto; color: var(--text); background: #f8faf8; border: 1px solid var(--border); border-radius: 5px; white-space: pre-wrap; overflow-wrap: anywhere; font: .84rem/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .empty { color: var(--muted); font-size: .84rem; }
    @media (max-width: 560px) {
      .container { width: min(100% - 20px, 760px); padding-top: 20px; }
      .header { align-items: flex-start; flex-direction: column; }
      .account { width: 100%; justify-content: space-between; }
      .card { padding: 16px; }
    }
  </style>
</head>
<body>
  <main class="container">
    <header class="header">
      <div><h1>PI Agent Server</h1><p class="subtitle">서버에 정의된 에이전트를 실행합니다.</p></div>
      <div class="account"><span id="user-label">로그인 확인 중</span><button class="logout" id="logout" type="button">로그아웃</button></div>
    </header>

    <section class="card">
      <form id="run-form">
        <div class="field"><label for="agent">에이전트</label><select id="agent" required disabled><option>불러오는 중…</option></select><span class="agent-meta" id="agent-meta"></span></div>
        <div class="field"><label for="session">세션 ID (선택)</label><input id="session" autocomplete="off" placeholder="기존 세션을 이어갈 때 입력"></div>
        <div class="field"><label for="prompt">요청</label><textarea id="prompt" required placeholder="에이전트에게 요청할 내용을 입력하세요."></textarea></div>
        <div class="actions"><button class="primary" id="submit" type="submit" disabled>실행</button></div>
      </form>
      <p class="error" id="error" role="alert"></p>
    </section>

    <section class="card">
      <div class="result-header"><h2>실행 결과</h2><span class="status queued" id="status" hidden>대기 중</span></div>
      <p class="run-info" id="run-info">실행 결과가 여기에 표시됩니다.</p>
      <pre id="output" class="empty">아직 실행된 요청이 없습니다.</pre>
      <div class="actions"><button class="secondary" id="abort" type="button" hidden>중단</button></div>
    </section>
  </main>

  <script>
    (() => {
      const agentSelect = document.getElementById('agent');
      const agentMeta = document.getElementById('agent-meta');
      const form = document.getElementById('run-form');
      const prompt = document.getElementById('prompt');
      const session = document.getElementById('session');
      const submit = document.getElementById('submit');
      const abort = document.getElementById('abort');
      const status = document.getElementById('status');
      const runInfo = document.getElementById('run-info');
      const output = document.getElementById('output');
      const error = document.getElementById('error');
      const labels = { queued: '대기 중', running: '실행 중', completed: '완료', failed: '실패', cancelled: '중단됨' };
      let agents = [];
      let currentRun = null;
      let eventSource = null;
      let statusTimer = null;

      async function api(path, options) {
        const response = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
        const contentType = response.headers.get('content-type') || '';
        const body = contentType.includes('application/json') ? await response.json() : await response.text();
        if (response.status === 401) {
          window.location.assign('/auth/hiworks/login');
          throw new Error('로그인이 필요합니다.');
        }
        if (!response.ok) {
          const message = body && typeof body === 'object' && body.error && body.error.message ? body.error.message : '요청에 실패했습니다.';
          throw new Error(message);
        }
        return body;
      }

      function setError(message) { error.textContent = message || ''; }
      function terminal(value) { return value === 'completed' || value === 'failed' || value === 'cancelled'; }

      function updateAgentMeta() {
        const agent = agents.find((item) => item.id === agentSelect.value);
        agentMeta.textContent = agent ? agent.model.provider + ' / ' + agent.model.id : '';
        submit.disabled = !agent || Boolean(currentRun && !terminal(currentRun.status));
      }

      function renderAgents() {
        agentSelect.innerHTML = '';
        agents.forEach((agent) => {
          const option = document.createElement('option');
          option.value = agent.id;
          option.textContent = agent.id;
          agentSelect.append(option);
        });
        agentSelect.disabled = agents.length === 0;
        if (agents.length) agentSelect.value = agents[0].id;
        updateAgentMeta();
      }

      function stopTracking() {
        if (eventSource) { eventSource.close(); eventSource = null; }
        if (statusTimer) { window.clearInterval(statusTimer); statusTimer = null; }
      }

      function updateRun(snapshot) {
        currentRun = Object.assign({}, currentRun || {}, snapshot);
        status.hidden = false;
        status.textContent = labels[currentRun.status] || currentRun.status;
        status.className = 'status ' + currentRun.status;
        runInfo.textContent = 'run: ' + currentRun.id + ' / session: ' + currentRun.sessionId;
        if (currentRun.result && typeof currentRun.result.output === 'string') {
          output.textContent = currentRun.result.output || '(응답 없음)';
          output.classList.remove('empty');
        }
        if (currentRun.error) {
          output.textContent = currentRun.error;
          output.classList.remove('empty');
        }
        abort.hidden = terminal(currentRun.status);
        updateAgentMeta();
        if (terminal(currentRun.status)) stopTracking();
      }

      function handleEvent(event) {
        if (event.type === 'run_started') updateRun({ status: 'running' });
        if (event.type === 'run_completed') updateRun({ status: 'completed', result: event.result });
        if (event.type === 'run_failed') updateRun({ status: 'failed', error: event.error });
        if (event.type === 'run_cancelled') updateRun({ status: 'cancelled' });
      }

      function trackRun(run) {
        stopTracking();
        eventSource = new EventSource(run.eventsUrl);
        ['run_started', 'run_completed', 'run_failed', 'run_cancelled'].forEach((name) => eventSource.addEventListener(name, (message) => {
          try { handleEvent(JSON.parse(message.data)); } catch (_) { setError('실행 이벤트를 읽을 수 없습니다.'); }
        }));
        statusTimer = window.setInterval(async () => {
          if (!currentRun || terminal(currentRun.status)) return;
          try { updateRun(await api(currentRun.statusUrl)); } catch (reason) { setError(reason.message); }
        }, 1500);
      }

      async function load() {
        try {
          const me = await api('/auth/me');
          if (!me.authenticated) { window.location.assign('/auth/hiworks/login'); return; }
          const user = me.user || {};
          document.getElementById('user-label').textContent = user.displayName || user.email || user.id || 'Hiworks 사용자';
          const response = await api('/v1/agents');
          agents = response.agents || [];
          renderAgents();
        } catch (reason) { setError(reason.message); }
      }

      agentSelect.addEventListener('change', updateAgentMeta);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        setError('');
        const input = prompt.value.trim();
        if (!agentSelect.value || !input) { setError('에이전트와 요청 내용을 입력하세요.'); return; }
        submit.disabled = true;
        try {
          const body = { input: input };
          if (session.value.trim()) body.sessionId = session.value.trim();
          const run = await api('/v1/agents/' + encodeURIComponent(agentSelect.value) + '/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          output.textContent = '실행 중…';
          output.classList.add('empty');
          updateRun(run);
          trackRun(run);
        } catch (reason) { setError(reason.message); updateAgentMeta(); }
      });

      abort.addEventListener('click', async () => {
        if (!currentRun || terminal(currentRun.status)) return;
        abort.disabled = true;
        try { updateRun(await api('/v1/runs/' + encodeURIComponent(currentRun.id) + '/abort', { method: 'POST' })); }
        catch (reason) { setError(reason.message); abort.disabled = false; }
      });

      document.getElementById('logout').addEventListener('click', async () => {
        try { await api('/auth/hiworks/logout', { method: 'POST' }); } finally { window.location.assign('/'); }
      });
      load();
    })();
  </script>
</body>
</html>`;
}
