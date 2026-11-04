// Searchable, keyboard-accessible model popup. The dialog escapes the scrolling options panel.
export function setupModelPicker(button) {
  const popup = document.createElement('dialog');
  popup.className = 'or-model-popup';
  popup.setAttribute('aria-label', 'Choose an OpenRouter model');
  popup.innerHTML = `<input type="search" class="or-model-search" placeholder="Search models by name or ID…" aria-label="Search models" role="combobox" aria-expanded="true" aria-controls="or-model-results" autocomplete="off"><div id="or-model-results" role="listbox" aria-label="Models"></div><p class="or-model-empty" role="status" hidden>No matching models.</p>`;
  document.body.append(popup);
  const input = popup.querySelector('input'), list = popup.querySelector('[role="listbox"]');
  let models = [], matches = [], index = 0;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  function highlight() {
    [...list.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
    if (matches.length) {
      input.setAttribute('aria-activedescendant', `or-model-option-${index}`);
      list.children[index]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(id) {
    button.value = id;
    popup.close();
    button.dispatchEvent(new Event('change'));
  }
  function search() {
    const words = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    matches = models.filter(m => words.every(w => `${m.name} ${m.id}`.toLowerCase().includes(w)));
    index = Math.max(0, matches.findIndex(m => m.id === button.value));
    list.replaceChildren();
    matches.forEach((m, i) => {
      const option = document.createElement('div'); option.id = `or-model-option-${i}`;
      option.setAttribute('role', 'option');
      const name = document.createElement('strong'), id = document.createElement('span');
      name.textContent = m.name; id.textContent = m.id;
      option.append(name, id); option.onclick = () => choose(m.id);
      list.append(option);
    });
    popup.querySelector('.or-model-empty').hidden = matches.length > 0;
    highlight();
  }
  button.onclick = () => {
    if (button.disabled) return;
    input.value = ''; popup.showModal();
    const rect = button.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 24);
    const height = Math.min(340, window.innerHeight - 24);
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${height}px`;
    popup.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    popup.style.top = `${Math.max(12, Math.min(rect.bottom + 4, window.innerHeight - height - 12))}px`;
    button.setAttribute('aria-expanded', 'true'); search(); input.focus();
  };
  input.oninput = search;
  input.onkeydown = event => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      index = event.key === 'Home' ? 0 : event.key === 'End' ? matches.length - 1 : Math.max(0, Math.min(matches.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      highlight();
    } else if (event.key === 'Enter') { event.preventDefault(); if (matches[index]) choose(matches[index].id); }
  };
  popup.addEventListener('click', event => { if (event.target === popup) { const r = popup.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) popup.close(); } });
  popup.addEventListener('close', () => { button.setAttribute('aria-expanded', 'false'); button.focus(); });
  return {
    set(items, id) {
      models = items; button.value = id || '';
      button.textContent = `${models.find(m => m.id === id)?.name || id || 'Choose a model'} ▾`;
      button.title = id || 'Search and choose a model';
      if (popup.open) popup.close();
    }
  };
}
