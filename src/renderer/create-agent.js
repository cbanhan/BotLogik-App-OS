import { agentNameError } from '../shared/agent-name.js';

export function setupCreateAgent({ onConnected }) {
  const element = id => document.getElementById(`create-agent-${id}`);
  const modal = element('modal');
  const nameInput = element('name');
  const instructionFile = element('instruction-file');
  const choose = element('location');
  const cancel = element('cancel');
  const submit = element('submit');
  const connect = element('connect-existing');
  const trigger = document.getElementById('btn-create-agent');
  let parent = '';
  let existingPath = '';
  let busy = false;

  function error(message = '') {
    element('error').textContent = message;
    element('error').classList.toggle('hidden', !message);
  }

  function render() {
    const name = nameInput.value.trim();
    element('parent').textContent = parent || 'No location selected';
    element('preview').textContent = parent && name ? `${parent.replace(/[\\/]$/, '')}/${name}` : 'Choose a name and location';
    submit.disabled = busy || !parent || Boolean(agentNameError(name)) || Boolean(existingPath);
    choose.disabled = cancel.disabled = nameInput.disabled = instructionFile.disabled = connect.disabled = busy;
    connect.classList.toggle('hidden', !existingPath);
    submit.textContent = busy ? 'Please wait…' : 'Create Agent';
  }

  function close() {
    if (busy) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    trigger.focus();
  }

  trigger.addEventListener('click', () => {
    if (busy) return;
    nameInput.value = '';
    instructionFile.value = 'agent.md';
    nameInput.setAttribute('aria-invalid', 'false');
    existingPath = '';
    error(); render();
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    nameInput.focus();
  });
  cancel.addEventListener('click', close);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const controls = [...modal.querySelectorAll('input, select, button')].filter(node => !node.disabled && node.getClientRects().length);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  nameInput.addEventListener('input', () => {
    existingPath = '';
    const message = nameInput.value ? agentNameError(nameInput.value) : '';
    nameInput.setAttribute('aria-invalid', String(Boolean(message)));
    error(message); render();
  });
  choose.addEventListener('click', async () => {
    if (busy) return;
    busy = true; render();
    try {
      const selected = await window.botlogik.agents.chooseParent();
      if (selected) { parent = selected; existingPath = ''; error(); }
    } catch (failure) { error(failure.message || String(failure)); }
    finally { busy = false; render(); choose.focus(); }
  });

  async function finish(action) {
    if (busy) return;
    busy = true; error(); render();
    try {
      const result = await action();
      if (result?.status === 'exists' || result?.status === 'created-unconnected') {
        existingPath = result.path;
        connect.textContent = result.status === 'exists' ? 'Connect existing folder' : 'Connect created agent';
        error(result.message || 'That folder already exists. Connect it or choose a different name.');
        return;
      }
      if (!result?.agent) throw new Error('Could not open the new agent. Try connecting its folder.');
      busy = false;
      close();
      onConnected(result);
    } catch (failure) { error(failure.message || String(failure)); }
    finally { busy = false; render(); }
  }
  element('form').addEventListener('submit', event => {
    event.preventDefault();
    if (submit.disabled) return;
    const name = nameInput.value.trim();
    finish(() => window.botlogik.agents.create(name, instructionFile.value));
  });
  connect.addEventListener('click', () => {
    if (existingPath) finish(() => window.botlogik.agents.connectPath(existingPath));
  });
}
