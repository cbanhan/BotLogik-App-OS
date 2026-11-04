export function setupImageAttachments({ currentAgent, running, showTerminal, focusTerminal, onInserted, fit, toast }) {
  const api = window.botlogik?.images;
  const pane = document.getElementById('pane-chat');
  const tray = document.getElementById('image-tray');
  const list = document.getElementById('image-list');
  const insert = document.getElementById('images-insert');
  const queues = new Map();
  const pending = new Set();
  let pathPending = false;
  const queue = id => queues.get(id) || [];
  const message = error => {
    const detail = String(error?.message || error)
      .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '')
      .replace(/^Error:\s*/i, '');
    if (/no image on the clipboard/i.test(detail)) {
      toast('No screenshot to paste yet. Copy an image, then try again—or use Images to choose a file.');
    } else {
      toast(detail || 'Couldn’t add that image. Please try again.');
    }
  };
  function render() {
    const agent = currentAgent();
    const images = queue(agent?.id);
    tray.classList.toggle('hidden', !images.length);
    list.replaceChildren();
    for (const image of images) {
      const card = document.createElement('div'); card.className = 'image-attachment';
      const preview = document.createElement('img'); preview.src = image.thumbnail; preview.alt = image.name;
      const name = document.createElement('span'); name.textContent = image.name; name.title = image.path;
      const copy = document.createElement('button'); copy.textContent = 'Copy path'; copy.title = image.path;
      copy.addEventListener('click', () => { window.botlogik.clipboard.writeText(image.path); toast('Image path copied'); });
      const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${image.name}`);
      remove.disabled = pending.has(agent.id);
      remove.addEventListener('click', () => {
        queues.set(agent.id, queue(agent.id).filter(item => item.id !== image.id));
        api.release([image.id]).catch(message); render();
      });
      card.append(preview, name, copy, remove); list.append(card);
    }
    document.getElementById('insert-path').disabled = !running(agent?.id) || pathPending;
    insert.disabled = !images.length || !running(agent?.id) || pending.has(agent?.id);
    document.getElementById('images-count').textContent = `${images.length}/10 images`;
    document.getElementById('images-hint').textContent = running(agent?.id) ? 'Adds local image paths; you send the prompt.' : 'Start Claude or Codex to add these images to your prompt.';
    for (const id of ['attach-images', 'images-paste']) document.getElementById(id).disabled = !agent || pending.has(agent.id);
    requestAnimationFrame(() => {
      document.getElementById('agent-launch-overlay').style.bottom = `${tray.classList.contains('hidden') ? 0 : tray.offsetHeight}px`;
      fit();
    });
  }
  async function stage(request, agent = currentAgent()) {
    if (!agent || pending.has(agent.id)) return;
    if (!api) { toast('Restart BotLogik to enable image attachments.'); return; }
    const remaining = 10 - queue(agent.id).length;
    if (!remaining) { toast('Remove an image first. You can add up to 10 per prompt.'); return; }
    if (request.images?.length > remaining) { toast(`You can add ${remaining} more images.`); return; }
    pending.add(agent.id); render();
    try {
      if (request.source === 'picker') request = { images: await api.pick() };
      if (request.images?.length === 0) return;
      if (request.images?.length > remaining) throw new Error(`You can add ${remaining} more images.`);
      for (const source of request.images || []) {
        if (!/\.webp$/i.test(source.path || source.name || '')) continue;
        const bytes = source.path ? await api.readWebp(source.path) : source.bytes;
        const bitmap = await createImageBitmap(new Blob([bytes], {type:'image/webp'}));
        try {
          if (bitmap.width * bitmap.height > 40000000) throw new Error('Resize the image below 40 megapixels.');
          const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          if (!png || png.size > 20 * 1024 * 1024) throw new Error('Resize the image below 20 MB.');
          source.bytes = new Uint8Array(await png.arrayBuffer());
          source.name ||= source.path.split(/[\\/]/).at(-1);
          delete source.path;
        } finally { bitmap.close(); }
      }
      const result = await api.stage({ ...request, agentId: agent.id, agentPath: agent.path });
      const accepted = result.images.slice(0, remaining);
      queues.set(agent.id, [...queue(agent.id), ...accepted]);
      const overflow = result.images.slice(remaining);
      if (overflow.length) { await api.release(overflow.map(image => image.id)); toast('Only 10 images can be added per prompt.'); }
      if (result.errors.length) toast(result.errors.join(' '));
      if (accepted.length && currentAgent()?.id === agent.id) showTerminal();
    } catch (error) { message(error); }
    finally { pending.delete(agent.id); render(); }
  }
  async function stageFiles(files, agent) {
    try {
      if (files.length > 10) throw new Error('Choose up to 10 images at a time.');
      const images = [];
      for (const file of files) {
        if (!/image\/(png|jpeg|webp)/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error('Use PNG, JPEG, or WebP images.');
        if (file.size > 20 * 1024 * 1024) throw new Error('Each image must be under 20 MB.');
        const path = api?.pathForFile(file);
        images.push(path ? { path, name: file.name } : { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name });
      }
      await stage({ images }, agent);
    } catch (error) { message(error); }
  }
  document.getElementById('insert-path').addEventListener('click', async () => {
    const agent = currentAgent();
    if (!agent || !running(agent.id) || pathPending) return;
    pathPending = true; render();
    try {
      const result = await window.botlogik.references.pickAndInsert(agent.id);
      if (result.canceled) return;
      onInserted(agent.id, result.text);
      if (currentAgent()?.id === agent.id) { showTerminal(); focusTerminal(); }
      toast('Path added. Write your instructions, then press Enter.');
    } catch (error) { message(error); }
    finally { pathPending = false; render(); }
  });
  document.getElementById('attach-images').addEventListener('click', () => stage({ source: 'picker' }));
  document.getElementById('images-paste').addEventListener('click', () => stage({ source: 'clipboard' }));
  insert.addEventListener('click', async () => {
    const agent = currentAgent();
    if (!agent || insert.disabled) return;
    const images = [...queue(agent.id)]; pending.add(agent.id); render();
    try {
      const result = await api.insert({ agentId: agent.id, ids: images.map(image => image.id) });
      onInserted(agent.id, result.text);
      queues.set(agent.id, []);
      if (currentAgent()?.id === agent.id) focusTerminal();
      toast('Image references added. Write your instructions, then press Enter.');
    } catch (error) { message(error); }
    finally { pending.delete(agent.id); render(); }
  });
  pane.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.some(file => file.type.startsWith('image/'))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    stageFiles(files, currentAgent());
  }, true);
  // Capture before xterm's keyboard handler so native clipboard images become previews.
  pane.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyV') {
      event.preventDefault(); event.stopImmediatePropagation(); stage({ source: 'clipboard' });
    }
  }, true);
  const accepts = event => [...event.dataTransfer.types].some(type => type === 'Files' || type === 'application/x-botlogik-image');
  pane.addEventListener('dragover', event => {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; pane.classList.add('image-drop-target');
  }, true);
  pane.addEventListener('dragleave', event => { if (!pane.contains(event.relatedTarget)) pane.classList.remove('image-drop-target'); });
  pane.addEventListener('drop', event => {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopImmediatePropagation(); pane.classList.remove('image-drop-target');
    const path = event.dataTransfer.getData('application/x-botlogik-image');
    if (path) stage({ images: [{ path }] });
    else stageFiles([...event.dataTransfer.files], currentAgent());
  }, true);
  new ResizeObserver(() => {
    document.getElementById('agent-launch-overlay').style.bottom = `${tray.classList.contains('hidden') ? 0 : tray.offsetHeight}px`;
    fit();
  }).observe(tray);
  return { render, addPath: path => stage({ images: [{ path }] }) };
}
