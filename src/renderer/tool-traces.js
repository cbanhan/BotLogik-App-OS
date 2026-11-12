import './tool-traces.css';

export function setupToolTraces({ currentAgent, currentContext = () => ({}), onResize = () => {} }) {
  const api = window.botlogik?.traces;
  const pane = document.getElementById('pane-chat');
  const surface = document.createElement('div'); surface.id = 'conversation-surface';
  surface.style.cssText = 'position:relative;display:flex;flex-direction:column;flex:1;min-height:0;min-width:0';
  surface.append(...pane.childNodes); pane.append(surface);
  const button = document.createElement('button'); button.id = 'tool-traces-toggle'; button.className = 'workspace-control mr-2'; button.textContent = 'Tools';
  button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'tool-traces');
  document.getElementById('terminal-end-session').before(button);
  const panel = document.createElement('section'); panel.id = 'tool-traces'; panel.hidden = true; panel.setAttribute('aria-label', 'AI tool traces');
  panel.innerHTML = `<header><strong>Tool activity</strong><button data-action="close" aria-label="Close tool traces">Close</button></header>
    <div class="trace-controls"><select aria-label="Trace conversation" data-field="session"></select><select aria-label="Filter tool calls" data-field="filter"><option value="all">All tools</option><option value="failed">Failed tools</option></select><button data-action="clear">Clear conversation traces</button></div>
    <p class="trace-status" role="status"></p><div class="trace-list"></div>
    <p class="trace-footnote">Observed actions, not private reasoning. Known credential patterns are redacted; details are size-limited. Review before sharing.</p>`;
  pane.append(panel);
  const $ = selector => panel.querySelector(selector);
  let agentKey = '', contextKey = '', sessions = [], selected = '', epoch = 0, timer;
  const expanded = new Set();
  function context() { return currentContext() || {}; }
  function setOpen(open) { panel.hidden = !open; button.setAttribute('aria-expanded', String(open)); onResize(); if (open) void refresh(); }
  function node(tag, text, parent) { const el = document.createElement(tag); el.textContent = text; parent.append(el); return el; }
  function render(storageError = '') {
    const select = $('[data-field="session"]'); select.replaceChildren();
    if (!selected) { const placeholder = node('option', 'Current session — no traces yet', select); placeholder.value = ''; placeholder.selected = true; }
    for (const session of [...sessions].reverse()) {
      const option = node('option', `${session.provider} · ${new Date(session.startedAt).toLocaleString()} · ${(session.conversationId || session.id).slice(0, 8)}`, select);
      option.value = session.id; option.selected = session.id === selected;
    }
    const session = sessions.find(s => s.id === selected);
    select.disabled = !sessions.length;
    $('[data-action="clear"]').disabled = !session;
    const regularShell = context().provider === 'terminal';
    $('.trace-status').textContent = storageError || (regularShell ? 'Regular shells do not produce AI traces. You can inspect saved conversations here.' : session?.availability || 'Tool tracing unavailable: no provider events have been recorded for this session. CLI hooks may be disabled or unsupported.');
    const list = $('.trace-list'), scroll = list.scrollTop; list.replaceChildren();
    let turn = null;
    const calls = (session?.tools || []).filter(t => $('[data-field="filter"]').value !== 'failed' || t.status === 'failed');
    if (!calls.length) node('p', 'No matching tool calls recorded.', list);
    for (const call of calls) {
      if (call.turn !== turn) { turn = call.turn; node('h4', turn ? `Request ${turn}` : 'Session activity', list); }
      const detail = document.createElement('details'); detail.dataset.status = call.status; detail.open = expanded.has(call.id); list.append(detail);
      detail.ontoggle = () => { if (detail.open) expanded.add(call.id); else expanded.delete(call.id); };
      const duration = call.startedAt && call.finishedAt ? ` · ${((call.finishedAt - call.startedAt) / 1000).toFixed(1)}s` : '';
      let target = '';
      try { const input = JSON.parse(call.input); target = input.path || input.file_path || input.command || input.pattern || input.query || ''; } catch {}
      node('summary', `${call.name} · ${call.status}${duration}${target ? ` · ${String(target).slice(0, 100)}` : ''}`, detail);
      const text = `${session.provider} · ${session.conversationId || session.id}\n${call.name} · ${call.status}\nObserved: ${new Date(call.observedAt).toLocaleString()}${duration}\n\nInputs\n${call.input || 'Not supplied by provider.'}\n\nResult\n${call.output || (call.status === 'unknown' ? 'Completion was not observed.' : 'No result received yet.')}`;
      node('pre', text, detail);
      const copy = node('button', 'Copy details', detail); copy.onclick = async () => { try { await window.botlogik.clipboard.writeText(text); copy.textContent = 'Copied'; } catch { copy.textContent = 'Could not copy'; } };
    }
    list.scrollTop = scroll;
  }
  async function refresh() {
    const agent = currentAgent(); if (!agent || panel.hidden) return;
    const requestEpoch = ++epoch;
    try {
      const result = api ? await api.list({ agentId: agent.id, path: agent.path }) : { sessions: [], storageError: 'Tool tracing is unavailable.' };
      if (requestEpoch !== epoch || currentAgent()?.id !== agent.id) return;
      sessions = result.sessions;
      if (!sessions.some(s => s.id === selected)) {
        const c = context();
        const matching = sessions.filter(s => (!c.provider || s.provider === c.provider) && (!c.conversationId || s.conversationId === c.conversationId));
        selected = (matching.at(-1) || (!c.provider ? sessions.at(-1) : null))?.id || '';
      }
      render(result.storageError);
    } catch { if (requestEpoch === epoch) $('.trace-status').textContent = 'Could not load tool traces. Close and reopen Tools to retry.'; }
  }
  function sync() {
    const agent = currentAgent(), c = context(); const next = `${c.provider || ''}:${c.conversationId || ''}`;
    if (agent?.id !== agentKey || next !== contextKey) {
      agentKey = agent?.id || ''; contextKey = next; selected = ''; sessions = []; expanded.clear(); epoch++;
      render(); void refresh();
    }
  }
  button.onclick = () => { sync(); setOpen(panel.hidden); };
  $('[data-action="close"]').onclick = () => setOpen(false);
  $('[data-field="session"]').onchange = event => { selected = event.target.value; render(); };
  $('[data-field="filter"]').onchange = () => render();
  $('[data-action="clear"]').onclick = async () => {
    const agent = currentAgent(); if (!agent || !selected || !api) return;
    try { await api.clear({ agentId: agent.id, path: agent.path, id: selected }); selected = ''; await refresh(); }
    catch { $('.trace-status').textContent = 'Could not clear tool traces.'; }
  };
  api?.onChanged(() => { clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 100); });
  return { sync, show() { sync(); selected = ''; $('[data-field="filter"]').value = 'all'; setOpen(true); }, showFailed() { sync(); selected = ''; $('[data-field="filter"]').value = 'failed'; setOpen(true); } };
}
