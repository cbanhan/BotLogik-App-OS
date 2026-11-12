// Persist only allowlisted diagnostic fields, never provider output or prompts.
export function describeFailure(provider, phase, message = '', code = null) {
  const text = String(message);
  let reason = 'unknown', summary = `${provider} could not ${phase === 'exit' ? 'keep running' : 'complete this action'}.`;
  let action = 'Review the details below. Check the provider in Terminal, then try again.';
  if (/CLI_NOT_FOUND|ENOENT|not found|command not found/i.test(text)) {
    reason = 'not-found'; summary = `${provider} could not be found by BotLogik.`;
    action = 'Check the installation and executable location in Terminal. An installed tool may be missing from BotLogik’s PATH.';
  } else if (/EACCES|EPERM|permission denied/i.test(text)) {
    reason = 'permission'; summary = `${provider} could not access a required file or executable.`;
    action = 'Check workspace and executable permissions, then try again.';
  } else if (/API key|401|unlock.*key|Secure key/i.test(text)) {
    reason = 'authentication'; summary = `${provider} authentication failed.`; action = 'Check your API key in Settings or sign in through the provider’s Terminal app.';
  } else if (/credits|402/i.test(text)) {
    reason = 'credits'; summary = `${provider} has insufficient credits.`; action = 'Review your provider account balance before retrying.';
  } else if (/rate limit|429/i.test(text)) {
    reason = 'rate-limit'; summary = `${provider} is rate limited.`; action = 'Wait before trying again.';
  } else if (/fetch|network|timeout|timed out|ENOTFOUND/i.test(text)) {
    reason = 'network'; summary = `${provider} could not reach the service.`; action = 'Check your connection and provider availability, then try again.';
  }
  return { provider, phase, reason, summary, action, code: Number.isInteger(code) ? code : null };
}
export function redactDetails(value) {
  return String(value).replace(/(?:sk-[\w-]+|Bearer\s+[^\s"']+)/gi, '[redacted]').slice(0, 4000);
}
export function setupProviderErrors({ currentAgent, viewTools, viewTerminal, returnToLaunch, storage = localStorage }) {
  const key = 'botlogik.providerErrors.v1';
  let records = [], selected = null, minimized = false;
  const liveDetails = new Map();
  try { records = JSON.parse(storage.getItem(key) || '[]').filter(r => r && typeof r.agentId === 'string' && typeof r.summary === 'string').slice(-50); } catch {}
  const host = document.createElement('aside');
  host.id = 'provider-errors';
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:55;max-width:min(460px,90vw);max-height:60vh;overflow:auto;background:#202126;color:#eee;border:1px solid #99525b;border-radius:10px;padding:12px;font-size:13px;box-shadow:0 8px 32px #0008';
  document.body.append(host);
  const add = (tag, text) => { const el = document.createElement(tag); el.textContent = text; host.append(el); return el; };
  function save() { try { storage.setItem(key, JSON.stringify(records)); } catch {} }
  function render() {
    const agentId = currentAgent();
    const items = records.filter(r => r.agentId === agentId);
    host.replaceChildren(); host.hidden = !items.length;
    if (!items.length) return;
    const record = minimized ? null : (items.find(r => r.id === selected) || items.findLast(r => !r.dismissed));
    if (!record) { const b = add('button', `Recent errors (${items.length})`); b.onclick = () => { minimized = false; selected = items.at(-1).id; render(); }; return; }
    add('strong', record.summary).setAttribute('role', 'alert');
    add('p', record.action).style.margin = '8px 0';
    const details = add('details', ''); const summary = document.createElement('summary'); summary.textContent = 'Technical details'; details.append(summary);
    const technical = `${record.provider} · ${record.phase}\n${record.time}\nCategory: ${record.reason}${record.code === null ? '' : `\nExit code: ${record.code}`}\n${liveDetails.get(record.id) || 'Raw details are not retained after restarting BotLogik.'}`;
    const pre = document.createElement('pre'); pre.textContent = technical; pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0'; details.append(pre);
    if (record.phase === 'exit' && liveDetails.has(record.id) && viewTerminal) { const view = add('button', 'View current terminal output'); view.style.cssText = 'display:block;margin:8px 0'; view.onclick = () => { viewTerminal(); view.textContent = 'Return to launch choices'; view.onclick = returnToLaunch; }; }
    if (viewTools) { const tools = add('button', 'View failed tools'); tools.style.cssText = 'display:block;margin:8px 0'; tools.onclick = () => { minimized = true; render(); viewTools(); }; }
    const copy = add('button', 'Copy details'); copy.onclick = async () => { try { await window.botlogik.clipboard.writeText(technical); copy.textContent = 'Copied'; } catch { copy.textContent = 'Could not copy'; } };
    const dismiss = add('button', 'Dismiss'); dismiss.style.marginLeft = '16px'; dismiss.onclick = () => { record.dismissed = true; selected = null; save(); render(); };
    const history = add('select', ''); history.setAttribute('aria-label', 'Recent workspace errors'); history.style.cssText = 'display:block;margin-top:10px;background:#202126;max-width:100%';
    for (const item of [...items].reverse()) { const option = document.createElement('option'); option.value = item.id; option.textContent = `${new Date(item.time).toLocaleString()} · ${item.summary}`; option.selected = item.id === record.id; history.append(option); }
    history.onchange = () => { selected = history.value; render(); };
    const clear = add('button', 'Clear workspace error history'); clear.style.cssText = 'display:block;margin-top:10px'; clear.onclick = () => { for (const r of items) liveDetails.delete(r.id); records = records.filter(r => r.agentId !== agentId); selected = null; save(); render(); };
  }
  return { render, report(agentId, provider, phase, message, code) {
    const record = { ...describeFailure(provider, phase, message, code), agentId, id: crypto.randomUUID(), time: new Date().toISOString(), dismissed: false };
    records.push(record); records = records.slice(-50);
    liveDetails.set(record.id, redactDetails(message));
    for (const id of liveDetails.keys()) if (!records.some(r => r.id === id)) liveDetails.delete(id);
    selected = record.id; minimized = false; save(); render();
  } };
}
