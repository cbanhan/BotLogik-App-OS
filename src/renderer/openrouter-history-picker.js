// A dialog contains real buttons so row actions remain independently keyboard accessible.
export function setupHistoryPicker(button, { manage }) {
  const popup = document.createElement('dialog');
  popup.className = 'or-history-popup';
  popup.setAttribute('aria-label', 'OpenRouter conversations');
  popup.innerHTML = `<div class="or-history-heading"><strong>Conversations</strong><button type="button" class="or-history-close" aria-label="Close conversations">×</button></div><input type="search" class="or-history-search" placeholder="Search conversations…" aria-label="Search conversations"><button type="button" class="or-history-new">＋ New conversation</button><div class="or-history-list"></div><p class="or-history-error" role="alert"></p><p class="or-history-footnote">Unpinned chats expire after 30 inactive days.</p>`;
  document.body.append(popup);
  const search = popup.querySelector('input'), list = popup.querySelector('.or-history-list'), error = popup.querySelector('[role=alert]');
  let entries = [], working = false;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  function label() {
    const entry = entries.find(c => c.id === button.value);
    button.textContent = `${entry?.pinned ? '📌 ' : ''}${entry?.title || 'New conversation'} ▾`;
    button.title = entry?.title || 'Choose a conversation';
  }
  function choose(id) { button.value = id; label(); popup.close(); button.dispatchEvent(new Event('change')); }
  const icon = action => action === 'pin'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m16 3 5 5-4 1-3 5v3l-7-7h3l5-3zM8 16l-5 5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
  function render() {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const matches = entries.filter(c => `${c.title} ${c.model}`.toLowerCase().includes(query)).sort((a,b) => Number(b.pinned)-Number(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    let group = '';
    for (const entry of matches) {
      const heading = entry.pinned ? 'Pinned' : 'Recent';
      if (heading !== group) { const h = document.createElement('p'); h.className = 'or-history-group'; h.textContent = heading; list.append(h); group = heading; }
      const row = document.createElement('div'); row.className = 'or-history-row'; row.dataset.id = entry.id;
      row.classList.toggle('is-selected', entry.id === button.value);
      const select = document.createElement('button'); select.type = 'button'; select.className = 'or-history-select';
      select.setAttribute('aria-current', String(entry.id === button.value));
      const title = document.createElement('strong'), meta = document.createElement('span');
      title.textContent = entry.title; select.title = entry.title;
      const date = new Date(entry.updatedAt);
      meta.textContent = `${entry.model}${Number.isNaN(date.getTime()) ? '' : ' · ' + date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      select.append(title, meta); select.onclick = () => choose(entry.id); row.append(select);
      for (const action of ['pin', 'delete']) {
        const control = document.createElement('button'); control.type = 'button'; control.dataset.action = action;
        const name = action === 'pin' ? entry.pinned ? 'Unpin' : 'Pin' : 'Delete';
        control.title = `${name} conversation`; control.setAttribute('aria-label', `${name} ${entry.title}`);
        if (action === 'pin') control.setAttribute('aria-pressed', String(Boolean(entry.pinned)));
        control.innerHTML = icon(action);
        control.onclick = async () => {
          if (working) return;
          working = true; error.textContent = ''; lock();
          try { await manage(action, entry); }
          catch (e) { error.textContent = e.message; }
          finally {
            working = false; render();
            const updated = [...list.querySelectorAll('.or-history-row')].find(r => r.dataset.id === entry.id);
            (updated?.querySelector(`[data-action="${action}"]`) || search).focus();
          }
        };
        row.append(control);
      }
      list.append(row);
    }
    if (!matches.length) { const empty = document.createElement('p'); empty.className = 'or-history-empty'; empty.textContent = query ? 'No matching conversations.' : 'Your saved chats will appear here.'; list.append(empty); }
    lock();
  }
  function lock() { popup.querySelectorAll('button,input').forEach(el => { el.disabled = working; }); }
  popup.querySelector('.or-history-new').onclick = () => choose('');
  popup.querySelector('.or-history-close').onclick = () => popup.close();
  search.oninput = render;
  popup.onkeydown = event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const buttons = [...list.querySelectorAll('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
  };
  popup.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  popup.onclick = event => {
    const r = popup.getBoundingClientRect();
    if (!working && event.target === popup && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) popup.close();
  };
  popup.onclose = () => { button.setAttribute('aria-expanded', 'false'); button.focus(); };
  button.onclick = () => {
    if (button.disabled) return;
    search.value = ''; error.textContent = ''; render(); popup.showModal();
    const r = button.getBoundingClientRect(), width = Math.min(460, window.innerWidth - 24), height = Math.min(440, window.innerHeight - 24);
    Object.assign(popup.style, { width: `${width}px`, maxHeight: `${height}px`, left: `${Math.max(12, Math.min(r.left, window.innerWidth - width - 12))}px`, top: `${Math.max(12, Math.min(r.bottom + 4, window.innerHeight - height - 12))}px` });
    button.setAttribute('aria-expanded', 'true'); search.focus();
  };
  return { set(items, id) { entries = items; button.value = id || ''; label(); if (popup.open) render(); }, select(id) { button.value = id || ''; label(); } };
}
