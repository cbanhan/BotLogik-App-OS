import './chat-models.css';

export function setupChatModels({ currentAgent, currentProvider, isBlocked, focusTerminal, toast }) {
  const api = window.botlogik?.chatModels;
  const button = document.createElement('button');
  button.id = 'chat-model-toggle'; button.className = 'workspace-control mr-2'; button.textContent = 'Models';
  button.title = 'Models and reasoning for this project';
  button.setAttribute('aria-haspopup', 'dialog');
  document.getElementById('terminal-end-session').before(button);
  const panel = document.createElement('dialog'); panel.id = 'chat-model-picker'; panel.setAttribute('aria-labelledby', 'chat-model-title');
  panel.innerHTML = `<form method="dialog"><header><strong id="chat-model-title">Model & reasoning</strong><button aria-label="Close model selector">×</button></header></form>
    <p class="cm-project"></p>
    <label>Provider<select class="cm-provider"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
    <label>Model<select class="cm-model"></select></label>
    <label>Reasoning effort<select class="cm-effort"></select></label>
    <p class="cm-source"></p><p class="cm-session"></p>
    <label class="cm-check"><input type="checkbox" class="cm-save"> Save as this project’s default</label>
    <label class="cm-check cm-ready"><input type="checkbox"> The terminal is at an empty prompt, with no menu or approval open.</label>
    <p class="cm-help"></p><p class="cm-error" role="alert"></p>
    <footer><button type="button" class="cm-default">Use project default</button><button type="button" class="cm-apply">Use for next chat</button><button type="button" class="cm-effort-picker">Change effort…</button></footer>`;
  document.body.append(panel);
  const $ = selector => panel.querySelector(selector);
  const choices = new Map();
  let epoch = 0, snapshot, agent, catalog = {}, busy = false;
  const key = (id, provider) => `${id}:${provider}`;
  const provider = () => $('.cm-provider').value;
  const selection = () => ({ model: $('.cm-model').value, reasoningEffort: $('.cm-effort').value });
  const live = () => snapshot?.session?.provider === provider();
  function option(select, value, label, disabled = false) { const el = new Option(label, value); el.disabled = disabled; select.add(el); }
  function efforts(value = 'default') {
    const select = $('.cm-effort'); select.replaceChildren(); option(select, 'default', 'Provider default');
    const model = catalog[provider()]?.find(item => item.id === $('.cm-model').value);
    for (const effort of model?.efforts || []) option(select, effort, ({xhigh:'Extra high',max:'Maximum'})[effort] || effort[0].toUpperCase() + effort.slice(1));
    if (value !== 'default' && ![...select.options].some(o => o.value === value)) option(select, value, `${value} · unavailable`, true);
    select.value = value; select.disabled = !$('.cm-model').value || !model?.efforts?.length;
    render();
  }
  function models(value = {}) {
    const select = $('.cm-model'); select.replaceChildren(); option(select, '', 'Provider default');
    for (const model of catalog[provider()] || []) if (model.id) option(select, model.id, model.label || model.id);
    if (value.model && ![...select.options].some(o => o.value === value.model)) option(select, value.model, `${value.model} · unavailable`, true);
    select.value = value.model || ''; efforts(value.reasoningEffort || 'default');
  }
  function render() {
    const active = live(), claude = provider() === 'claude';
    $('.cm-ready').hidden = !active;
    $('.cm-effort-picker').hidden = !active || !claude;
    $('.cm-apply').textContent = active ? (claude ? 'Prepare model picker' : 'Prepare switch') : 'Use for next chat';
    $('.cm-help').textContent = active
      ? claude ? 'Press Enter in the terminal to open the picker. Choose your model or effort, then press s to apply to this session only. Model and effort use separate pickers; the choices above are for saved defaults.'
        : 'Prepares /model without submitting. Press Enter in the terminal, then verify the result there. Provider default opens the native picker; default effort adds no override.'
      : 'Applies when you start a new chat. Resumed conversations keep their provider settings.';
    const initial = snapshot?.session?.selection;
    $('.cm-session').textContent = snapshot?.session ? (initial?.model ? `Launched with ${initial.model} · ${initial.reasoningEffort}. ` : '') + 'Current settings are controlled by the provider; changes inside the terminal cannot be verified here.' : '';
    $('.cm-source').textContent = claude ? (catalog.claudeError || (catalog.claudeVersion ? `Installed Claude Code ${catalog.claudeVersion}` : 'Models reported by installed Claude Code')) : 'From the local Codex model cache. Open Codex to refresh missing models.';
    const unavailable = $('.cm-model').selectedOptions[0]?.disabled || $('.cm-effort').selectedOptions[0]?.disabled;
    const ready = !active || $('.cm-ready input').checked;
    $('.cm-apply').disabled = busy || !ready || !!unavailable;
    $('.cm-effort-picker').disabled = busy || !ready || !!unavailable;
    $('.cm-provider').disabled = busy || !!snapshot?.session;
  }
  async function open() {
    agent = currentAgent(); if (!agent || !api || isBlocked()) return;
    const request = ++epoch; const target = agent;
    panel.showModal(); $('.cm-error').textContent = ''; $('.cm-project').textContent = target.name;
    $('.cm-save').checked = false; $('.cm-ready input').checked = false;
    busy = true; snapshot = null; catalog = {}; models(); $('.cm-source').textContent = 'Loading available models…';
    try {
      const [state, available] = await Promise.all([api.get({ agentId: target.id, cwd: target.path }), api.catalog({ agentId: target.id, cwd: target.path })]);
      if (request !== epoch || currentAgent()?.id !== target.id || !panel.open) return;
      snapshot = state; catalog = available;
      $('.cm-provider').value = state.session?.provider || (['claude','codex'].includes(currentProvider()) ? currentProvider() : 'claude');
      models(state.session?.selection || choices.get(key(target.id, provider())) || state.defaults[provider()] || {});
    } catch (error) { $('.cm-error').textContent = error.message; }
    finally { if (request === epoch) { busy = false; render(); } }
  }
  async function apply(control = 'model') {
    if (busy || currentAgent()?.id !== agent?.id || isBlocked()) return;
    const target = agent, selectedProvider = provider(), value = selection(), active = live(), applyEpoch = epoch;
    busy = true; render(); $('.cm-error').textContent = '';
    try {
      const request = { agentId: target.id, cwd: target.path, provider: selectedProvider, ...value };
      if ($('.cm-save').checked) {
        const saved = await api.save(request);
        snapshot.defaults[selectedProvider] = saved;
        choices.delete(key(target.id, selectedProvider));
      }
      if (currentAgent()?.id !== target.id || epoch !== applyEpoch || !panel.open) return;
      if (active) {
        await api.prepare({ ...request, token: snapshot.session.token, emptyPrompt: $('.cm-ready input').checked, control });
        if (epoch !== applyEpoch || currentAgent()?.id !== target.id) return;
        panel.close(); focusTerminal(); toast('Command prepared. Press Enter and confirm the change in the terminal.');
      } else {
        choices.set(key(target.id, selectedProvider), value);
        panel.close(); toast('Model preferences ready for the next new chat.');
      }
      sync();
    } catch (error) { $('.cm-error').textContent = error.message; }
    finally { busy = false; render(); }
  }
  function sync() {
    const current = currentAgent();
    button.hidden = !api || !current || isBlocked() || ['terminal','openrouter'].includes(currentProvider());
    if (panel.open && current?.id !== agent?.id) panel.close();
    const p = currentProvider();
    button.textContent = p === 'claude' ? 'Claude · Model & effort' : p === 'codex' ? 'Codex · Model & effort' : 'Models';
  }
  button.addEventListener('click', open);
  panel.addEventListener('close', () => { epoch++; });
  $('.cm-provider').addEventListener('change', () => models(choices.get(key(agent.id, provider())) || snapshot?.defaults[provider()] || {}));
  $('.cm-model').addEventListener('change', () => efforts());
  $('.cm-effort').addEventListener('change', render);
  $('.cm-ready input').addEventListener('change', render);
  $('.cm-default').addEventListener('click', () => models(snapshot?.defaults[provider()] || {}));
  $('.cm-apply').addEventListener('click', () => apply());
  $('.cm-effort-picker').addEventListener('click', () => apply('effort'));
  sync();
  return { sync, launchSelection: (agentId, provider) => choices.get(key(agentId, provider)), didLaunch: (agentId, provider) => choices.delete(key(agentId, provider)) };
}
