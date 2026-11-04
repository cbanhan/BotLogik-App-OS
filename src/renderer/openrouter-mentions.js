import { activeFileMention, fileMentions, mentionToken } from '../shared/file-mentions.js';

export function setupFileMentions({ prompt, tray, getState, api, dirtyFiles, onDraft }) {
  const popup = document.createElement('div');
  popup.className = 'or-mention-popup'; popup.hidden = true;
  popup.innerHTML = '<div id="or-mention-results" role="listbox" aria-label="Workspace files"></div><p class="or-mention-status" role="status"></p>';
  document.body.append(popup);
  const list = popup.querySelector('[role="listbox"]'), status = popup.querySelector('p');
  prompt.setAttribute('aria-autocomplete', 'list');
  let sequence = 0, timer, options = [], selected = 0, context = null;
  function hide() {
    clearTimeout(timer); sequence++; context = null; popup.hidden = true; options = [];
    prompt.removeAttribute('aria-controls'); prompt.removeAttribute('aria-activedescendant');
  }
  function position() {
    const rect = prompt.getBoundingClientRect();
    const width = Math.min(Math.max(280, rect.width), window.innerWidth - 24);
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    popup.style.maxHeight = `${Math.min(240, Math.max(100, rect.top - 12))}px`;
    popup.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 4)}px`;
  }
  function highlight() {
    [...list.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === selected)));
    if (options[selected]) {
      prompt.setAttribute('aria-activedescendant', `or-mention-${selected}`);
      list.children[selected]?.scrollIntoView({ block: 'nearest' });
    } else prompt.removeAttribute('aria-activedescendant');
  }
  function choose(path) {
    const s = getState();
    if (!context || !s || context.agentId !== s.agent.id || context.text !== prompt.value) return hide();
    const { start, end } = context.mention;
    const token = mentionToken(path);
    prompt.setRangeText(`${token} `, start, end, 'end');
    onDraft(prompt.value); hide(); render(); prompt.focus();
  }
  function render() {
    const s = getState(); tray.replaceChildren();
    if (!s) { tray.hidden = true; return; }
    const paths = [...new Set(fileMentions(prompt.value).map(m => m.path))];
    tray.hidden = paths.length === 0;
    const dirty = new Set(dirtyFiles(s.agent.id));
    for (const path of paths) {
      const chip = document.createElement('span'); chip.className = 'or-file-chip';
      chip.textContent = path;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '×';
      button.setAttribute('aria-label', `Remove file ${path}`);
      button.onclick = () => {
        const mentions = fileMentions(prompt.value).filter(m => m.path === path).reverse();
        let value = prompt.value;
        for (const m of mentions) value = value.slice(0, m.start) + value.slice(m.end);
        prompt.value = value; onDraft(value); hide(); render(); prompt.focus();
      };
      chip.append(button); tray.append(chip);
    }
    const note = document.createElement('p'); note.className = 'or-file-note';
    const unsaved = paths.filter(path => dirty.has(path));
    note.textContent = unsaved.length ? `Unsaved edits in ${unsaved.join(', ')}. Only the saved disk versions will be attached.` : 'Saved disk versions will be attached · Up to 8 files, 50 KB each, 100 KB total.';
    if (unsaved.length) note.classList.add('or-file-unsaved');
    tray.append(note);
  }
  function update() {
    render(); hide();
    const s = getState();
    const mention = activeFileMention(prompt.value, prompt.selectionStart);
    if (!s || !s.open || !mention || !api?.mentionFiles || prompt.selectionStart !== prompt.selectionEnd) return;
    const epoch = sequence;
    context = { agentId: s.agent.id, text: prompt.value, mention };
    popup.hidden = false; list.replaceChildren(); status.textContent = 'Finding files…'; position();
    prompt.setAttribute('aria-controls', 'or-mention-results');
    timer = setTimeout(async () => {
      try {
        const result = await api.mentionFiles({ agentId: s.agent.id, path: s.agent.path, query: mention.query });
        if (sequence !== epoch || getState() !== s || prompt.value !== context?.text) return;
        options = result.files; selected = 0;
        list.replaceChildren();
        options.forEach((path, i) => {
          const item = document.createElement('div'); item.id = `or-mention-${i}`; item.textContent = path;
          item.setAttribute('role', 'option'); item.onclick = () => choose(path);
          list.append(item);
        });
        status.textContent = options.length ? `${result.limited ? 'Limited results. Refine your search. ' : ''}↑ ↓ to choose · Enter to attach · Esc to dismiss` : 'No matching text files. Try a filename or folder path.';
        highlight(); position();
      } catch (e) { if (sequence === epoch) status.textContent = e.message; }
    }, 120);
  }
  popup.addEventListener('mousedown', event => event.preventDefault());
  prompt.addEventListener('input', update);
  prompt.addEventListener('click', update);
  prompt.addEventListener('blur', hide);
  prompt.addEventListener('keydown', event => {
    if (popup.hidden || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); hide(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); selected = Math.max(0, Math.min(options.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1))); highlight();
    } else if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && options.length)) {
      event.preventDefault(); event.stopImmediatePropagation(); if (options[selected]) choose(options[selected]);
    } else if (event.key === 'Enter' && event.shiftKey) hide();
  }, true);
  window.addEventListener('resize', hide);
  document.addEventListener('scroll', event => { if (!popup.contains(event.target)) hide(); }, true);
  return { render, hide, unsaved: () => { const s = getState(); const dirty = new Set(s ? dirtyFiles(s.agent.id) : []); return [...new Set(fileMentions(prompt.value).map(m => m.path))].filter(p => dirty.has(p)); } };
}
