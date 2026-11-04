import './openrouter.css';
import { setupHistoryPicker } from './openrouter-history-picker';
import { renderMarkdown } from './openrouter-markdown';
import { setupFileMentions } from './openrouter-mentions';
import { setupModelPicker } from './openrouter-model-picker';

export function setupOpenRouter({ currentAgent, showSettings, dirtyFiles = () => [], onVisibility = () => {}, onActivity = () => {} }) {
  const api = window.botlogik?.openrouter;
  const panel = document.createElement('section');
  panel.id = 'openrouter-chat'; panel.className = 'or-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'OpenRouter conversation');
  panel.innerHTML = `
    <header class="or-header"><strong>OpenRouter</strong><span class="or-workspace"></span><div class="or-header-actions"><button type="button" data-action="new" title="Start a fresh chat with this agent’s saved model">New Chat</button><button type="button" data-action="end" title="Stop this session and return to the agent choices">End Session</button></div><p class="or-session-hint">Conversations are saved in history.</p></header>
    <details class="or-options" open><summary>Model and conversations</summary><div class="or-controls">
      <label>Conversation<button type="button" class="or-history" aria-label="Saved OpenRouter conversation">New conversation ▾</button></label>
      <label>Model<button type="button" class="or-model" aria-label="OpenRouter model">Choose a model ▾</button></label>
      <button type="button" data-action="reload">Reload models</button>
    </div>
    <div class="or-model-note"></div><div class="or-price"></div></details>
    <div class="or-messages" role="log" aria-label="Conversation messages"></div>
    <div class="or-approval" hidden></div>
    <div class="or-status" role="status"></div>
    <form class="or-compose">
      <label class="or-label" for="or-prompt">Message</label>
      <div class="or-file-tray" aria-label="Attached workspace files" hidden></div>
      <textarea id="or-prompt" rows="3" maxlength="20000" placeholder="What would you like to build? Type @ to attach a file. Enter to send · Shift+Enter for a new line"></textarea>
      <div class="or-compose-actions"><label>Max requests per turn <input class="or-limit" type="number" min="1" max="30" value="12"></label><span class="or-usage"></span><button type="button" data-action="stop" hidden>Stop</button><button type="submit" class="or-send">Send</button></div>
      <p class="or-help">Messages and tool results go to OpenRouter and the selected provider. Edits and commands ask for approval. Conversations are saved on this Mac.</p>
    </form>`;
  document.getElementById('pane-chat').append(panel);
  const $ = sel => panel.querySelector(sel);
  const history = $('.or-history'), model = $('.or-model'), messages = $('.or-messages'), prompt = $('#or-prompt'), status = $('.or-status');
  const picker = setupModelPicker(model);
  const states = new Map(); let shown = null, catalogue = [], generation = 0;
  const stateFor = agent => {
    if (!states.has(agent.id)) states.set(agent.id, { agent, chat: null, open: false, draft: '', loading: false, selectedModel: '', error: '' });
    return states.get(agent.id);
  };
  const request = s => ({ agentId: s.agent.id, path: s.agent.path });
  const node = (tag, text, className) => { const n = document.createElement(tag); n.textContent = text; if (className) n.className = className; return n; };
  const mentions = setupFileMentions({ prompt, tray: $('.or-file-tray'), getState: () => shown, api, dirtyFiles, onDraft: text => { if (shown) shown.draft = text; } });
  function renderModels(s) {
    const id = s.chat?.model || s.selectedModel;
    picker.set(catalogue, id);
    $('.or-model-note').textContent = s.chat ? 'Choose another model to start a new chat. This conversation stays in history.' : s.selectedModel && !catalogue.some(m => m.id === s.selectedModel) ? 'Your saved model is unavailable. Choose another model.' : s.selectedModel ? 'Saved for this agent. Choose a different model anytime.' : 'Your selection will be saved for this agent.';
    const chosen = catalogue.find(m => m.id === id);
    const price = p => Number.isFinite(Number(p)) ? `$${(Number(p) * 1e6).toFixed(2)}` : 'Unavailable';
    $('.or-price').textContent = chosen ? `Per 1M tokens: ${price(chosen.inputPrice)} input · ${price(chosen.outputPrice)} output. Provider charges may vary.` : 'Select a tool-capable model. Your OpenRouter account pays for usage.';
  }
  function render(s) {
    if (shown !== s) return;
    mentions.render();
    historyPicker.select(s.chat?.id || '');
    const chat = s.chat, busy = Boolean(chat?.busy || s.sending);
    const locked = Boolean(s.ending);
    $('.or-workspace').textContent = s.agent.name;
    history.disabled = busy || s.loading || locked;
    model.disabled = busy || s.loading || locked || !catalogue.length;
    $('[data-action="new"]').disabled = locked || s.loading;
    $('[data-action="end"]').disabled = locked;
    $('[data-action="new"]').textContent = busy ? 'Stop & New Chat' : 'New Chat';
    $('.or-session-hint').textContent = locked ? 'Ending session…' : busy ? 'Stops the run; history is kept.' : 'Conversations are saved in history.';
    $('[data-action="reload"]').disabled = busy || s.loading || locked;
    $('.or-send').disabled = busy || s.loading || locked || !model.value || (!chat && !catalogue.some(m => m.id === model.value));
    $('[data-action="stop"]').hidden = !busy;
    $('.or-limit').disabled = busy;
    status.textContent = s.error || (chat?.pending ? 'Waiting for your approval' : busy ? 'Working…' : chat?.notice || 'Ready');
    const usage = chat?.usage;
    $('.or-usage').textContent = usage ? `${usage.requests} requests · ${usage.tokens.toLocaleString()} tokens${usage.costReported ? ` · $${usage.cost.toFixed(4)} reported` : ''}` : '';
    const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90;
    messages.replaceChildren();
    if (!chat?.messages.length) messages.append(node('p', 'Build in this workspace with your choice of model. BotLogik can read files, search, propose edits, and run commands.', 'or-empty'));
    for (const message of chat?.messages || []) {
      if (message.role === 'tool') {
        const detail = node('details', '', 'or-tool'); detail.append(node('summary', 'Tool result'), node('pre', message.content)); messages.append(detail); continue;
      }
      const item = node('article', '', `or-message or-${message.role}`);
      item.append(node('strong', message.role === 'user' ? 'You' : chat.model));
      if (message.content) {
        const content = node('div', message.displayText ?? message.content, 'or-content');
        if (message.role === 'assistant') {
          content.classList.add('or-markdown'); content.innerHTML = renderMarkdown(message.content);
          for (const link of content.querySelectorAll('a')) { link.onclick = event => { event.preventDefault(); if (link.hasAttribute('href')) api.openLink(link.href).catch(e => { s.error = e.message; render(s); }); }; }
        }
        item.append(content);
      }
      for (const file of message.attachments || []) {
        const detail = node('details', '', 'or-tool or-attached-file');
        detail.append(node('summary', `${file.path} · saved snapshot`), node('pre', file.content)); item.append(detail);
      }
      for (const call of message.tool_calls || []) {
        const detail = node('details', '', 'or-tool'); detail.append(node('summary', call.function.name), node('pre', call.function.arguments)); item.append(detail);
      }
      messages.append(item);
    }
    if (nearBottom) messages.scrollTop = messages.scrollHeight;
    const approval = $('.or-approval'); approval.replaceChildren(); approval.hidden = !chat?.pending;
    if (chat?.pending) {
      const p = chat.pending;
      approval.append(node('strong', p.name === 'run_command' ? 'Allow this command?' : `Allow edit to ${p.path}?`));
      const body = node('div', '', 'or-approval-body'); approval.append(body);
      if (p.warning) body.append(node('p', p.warning));
      if (p.command) body.append(node('pre', p.command));
      else {
        for (const [title, content] of [['Current file', p.before ?? '(new file)'], ['Proposed file', p.after]]) {
          const detail = node('details', ''); detail.append(node('summary', title), node('pre', content)); body.append(detail);
        }
      }
      const actions = node('div', '', 'or-approval-actions'); approval.append(actions);
      for (const [text, allowed] of [['Deny', false], ['Allow once', true]]) {
        const button = node('button', text); button.type = 'button';
        button.onclick = async () => {
          for (const b of approval.querySelectorAll('button')) b.disabled = true;
          try { await api.decide({ ...request(s), id: p.id, allowed }); }
          catch (e) { s.error = e.message; render(s); }
        };
        actions.append(button);
      }
    }
  }
  async function refreshHistory(s) {
    const entries = await api.list(request(s));
    if (shown !== s) return;
    historyPicker.set(entries, s.chat?.id || '');
  }
  async function loadModels(s) {
    s.loading = true; render(s);
    try { catalogue = await api.models(); s.error = ''; if (shown === s) renderModels(s); }
    catch (e) { s.error = e.message; }
    finally { s.loading = false; render(s); }
  }
  function sync(agent, blocked = false) {
    const s = agent ? stateFor(agent) : null;
    if (shown && shown !== s) shown.draft = prompt.value;
    const changed = shown !== s;
    if (changed || !s?.open || blocked) mentions.hide();
    shown = s;
    panel.hidden = !s?.open || blocked;
    if (changed && s && api) { $('.or-options').open = !s.chat; prompt.value = s.draft; renderModels(s); render(s); refreshHistory(s).catch(e => { s.error = e.message; render(s); }); }
    return !panel.hidden;
  }
  async function launch() {
    const agent = currentAgent(); if (!agent || !api) return;
    const s = stateFor(agent); s.open = true; sync(agent); onVisibility();
    s.error = ''; render(s);
    const epoch = ++generation;
    try {
      const config = await api.status();
      if (!config.configured) { s.error = 'Add your OpenRouter API key in Settings to begin.'; render(s); showSettings(); return; }
      const preference = await api.modelPreference(request(s));
      if (epoch !== generation) return;
      s.selectedModel = preference.model;
      await loadModels(s);
      if (shown === s) { $('.or-options').open = !s.chat; renderModels(s); await refreshHistory(s); render(s); prompt.focus(); }
    } catch (e) { s.error = e.message; render(s); }
  }
  async function finishSession(exit) {
    const s = shown;
    if (!s || s.ending) return;
    const unsent = prompt.value.trim() && prompt.value !== s.submission?.text;
    if (unsent && !window.confirm('Discard the unsent message and ' + (exit ? 'end this session?' : 'start a new chat?'))) return;
    s.ending = true; s.cancelRequested = true; generation++; mentions.hide(); render(s);
    try {
      if (s.chat?.busy || s.sending) {
        if (s.chat) await api.stop(request(s));
        // Wait for the send handler too, so its final history update cannot reopen the old chat.
        await s.sendSettled;
      }
      s.chat = null; s.draft = ''; s.error = ''; s.open = !exit;
      onActivity(s.agent.id, false, false);
      if (shown === s) {
        prompt.value = ''; history.value = ''; $('.or-options').open = true;
        renderModels(s); render(s);
        panel.hidden = exit;
        onVisibility();
        if (!exit) { await refreshHistory(s); prompt.focus(); }
        else document.getElementById('launch-openrouter').focus();
      }
    } catch (e) { s.error = e.message; }
    finally { s.ending = false; render(s); }
  }
  $('[data-action="end"]').onclick = () => finishSession(true);
  $('[data-action="new"]').onclick = () => finishSession(false);
  const historyPicker = setupHistoryPicker(history, { manage: async (action, entry) => {
    const s = shown;
    if (!s || s.loading || s.sending || s.chat?.busy || s.ending) return;
    if (action === 'delete' && !window.confirm(`Permanently delete “${entry.title}” and its saved file snapshots? This cannot be undone.`)) return;
    s.loading = true; render(s);
    try {
      if (action === 'pin') {
        const updated = await api.pin({ ...request(s), id: entry.id, pinned: !entry.pinned });
        if (s.chat?.id === entry.id) s.chat = updated;
      } else {
        await api.remove({ ...request(s), id: entry.id });
        if (s.chat?.id === entry.id) s.chat = null;
      }
      s.error = ''; await refreshHistory(s);
      if (shown === s) renderModels(s);
    } finally { s.loading = false; render(s); }
  } });
  $('[data-action="reload"]').onclick = () => shown && loadModels(shown);
  history.onchange = async () => {
    const s = shown; if (!s) return;
    const selectedId = history.value;
    s.loading = true; render(s);
    try { s.chat = selectedId ? await api.get({ ...request(s), id: selectedId }) : null; s.error = ''; }
    catch (e) { s.error = e.message; }
    finally { s.loading = false; if (shown === s) { renderModels(s); render(s); } }
  };
  model.onchange = async () => {
    const s = shown; if (!s || s.sending || s.chat?.busy || s.loading) return;
    const selected = model.value;
    s.loading = true; render(s);
    try {
      await api.modelPreference({ ...request(s), model: selected });
      s.selectedModel = selected;
      if (s.chat && s.chat.model !== selected) s.chat = null;
      s.error = '';
      if (shown === s) { renderModels(s); await refreshHistory(s); }
    } catch (e) { s.error = e.message; if (shown === s) renderModels(s); }
    finally { s.loading = false; render(s); }
  };
  prompt.oninput = () => { if (shown) shown.draft = prompt.value; };
  prompt.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('.or-compose').requestSubmit(); } };
  $('.or-compose').onsubmit = async event => {
    event.preventDefault(); const s = shown;
    if (!s || s.sending || s.chat?.busy || s.loading || s.ending || !prompt.value.trim() || !model.value) return;
    const unsaved = mentions.unsaved();
    if (unsaved.length && !window.confirm(`These files have unsaved edits: ${unsaved.join(', ')}. Send their saved disk versions?`)) return;
    mentions.hide();
    const text = prompt.value, selected = model.value, maxRequests = Number($('.or-limit').value);
    let settleSend;
    s.sendSettled = new Promise(resolve => { settleSend = resolve; });
    s.sending = true; s.cancelRequested = false; s.error = ''; $('.or-options').open = false; render(s);
    try {
      if (!s.chat) s.chat = await api.create({ ...request(s), model: selected });
      if (s.cancelRequested) return;
      s.submission = { text, previousMessages: s.chat.messages.length };
      await api.send({ ...request(s), id: s.chat.id, text, maxRequests });
      if (s.draft === text || (shown === s && prompt.value === text)) { s.draft = ''; if (shown === s) prompt.value = ''; }
      s.chat = await api.get({ ...request(s), id: s.chat.id });
      await refreshHistory(s);
    } catch (e) { s.error = e.message; s.draft = text; if (shown === s && !prompt.value) prompt.value = text; }
    finally { s.sending = false; s.submission = null; render(s); settleSend(); }
  };
  $('[data-action="stop"]').onclick = async () => { const s = shown; if (!s) return; s.cancelRequested = true; try { await api.stop(request(s)); } catch (e) { s.error = e.message; render(s); } };
  api?.onChanged(chat => {
    for (const s of states.values()) if (s.chat?.id === chat.id) {
      const submitted = s.submission;
      const message = submitted && chat.messages[submitted.previousMessages];
      if (message?.role === 'user' && (message.displayText ?? message.content) === submitted.text.trim()) {
        if (s.draft === submitted.text || (shown === s && prompt.value === submitted.text)) { s.draft = ''; if (shown === s) prompt.value = ''; }
        s.submission = null;
      }
      s.chat = chat;
      if (s.cancelRequested && chat.busy) api.stop(request(s)).catch(e => { s.error = e.message; render(s); });
      render(s); onActivity(s.agent.id, chat.busy, Boolean(chat.pending));
    }
  });
  document.getElementById('launch-openrouter').addEventListener('click', launch);

  const settings = document.getElementById('openrouter-settings');
  const keyInput = settings.querySelector('input');
  const keyStatus = settings.querySelector('[role="status"]');
  async function keyAction(action) {
    const buttons = settings.querySelectorAll('button'); buttons.forEach(b => { b.disabled = true; });
    keyStatus.textContent = action === 'save' ? 'Validating key…' : 'Loading…';
    try {
      const value = keyInput.value; keyInput.value = '';
      const result = action === 'save' ? await api.saveKey(value) : action === 'remove' ? await api.removeKey() : await api.status();
      if (result.configured && action === 'save' && shown?.open) await loadModels(shown);
      keyStatus.textContent = result.configured ? 'Key connected and encrypted on this Mac.' : result.secureStorage ? 'No key connected.' : 'Secure key storage is unavailable.';
    } catch (e) { keyStatus.textContent = e.message; }
    finally { buttons.forEach(b => { b.disabled = false; }); }
  }
  settings.querySelector('[data-key="create"]').onclick = () => api?.openKeys().catch(e => { keyStatus.textContent = e.message; });
  settings.querySelector('[data-key="save"]').onclick = () => keyAction('save');
  settings.querySelector('[data-key="remove"]').onclick = () => keyAction('remove');
  if (api) keyAction('status');
  return { sync, launch, refreshMentions: () => mentions.render(), get busy() { return [...states.values()].some(s => s.chat?.busy || s.sending); }, isOpen: id => states.get(id)?.open, isBusy: id => Boolean(states.get(id)?.chat?.busy || states.get(id)?.sending),
    async close(agent) { const s = states.get(agent?.id); if (!s) return; s.cancelRequested = true; if (api && (s.chat?.busy || s.sending)) await api.stop(request(s)); s.open = false; sync(currentAgent()); onVisibility(); } };
}
