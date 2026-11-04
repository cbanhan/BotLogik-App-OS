export function setupSidebarResize(sidebar, handle, onResize) {
  const storageKey = 'botlogik.sidebarWidth';
  const defaultWidth = 328;
  const minWidth = 280;
  let preferredWidth = defaultWidth;
  let drag = null;
  let frame = null;

  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= minWidth) preferredWidth = Math.min(saved, 560);
  } catch {}

  function maxWidth() {
    return Math.max(minWidth, Math.min(560, sidebar.parentElement.clientWidth - 600));
  }

  function applyWidth(width, save = false) {
    const bounded = Math.round(Math.max(minWidth, Math.min(maxWidth(), width)));
    sidebar.style.width = `${bounded}px`;
    handle.setAttribute('aria-valuemin', String(minWidth));
    handle.setAttribute('aria-valuemax', String(maxWidth()));
    handle.setAttribute('aria-valuenow', String(bounded));
    handle.setAttribute('aria-valuetext', `${bounded} pixels`);
    if (save) {
      preferredWidth = bounded;
      try { localStorage.setItem(storageKey, String(bounded)); } catch {}
    }
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      onResize();
    });
  }

  function finishDrag(event) {
    if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    const pointerId = drag.pointerId;
    drag = null;
    document.body.classList.remove('sidebar-resizing');
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    applyWidth(sidebar.getBoundingClientRect().width, true);
  }

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus();
    drag = { pointerId: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('sidebar-resizing');
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.pointerId === event.pointerId) applyWidth(drag.width + event.clientX - drag.x);
  });
  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);
  handle.addEventListener('lostpointercapture', finishDrag);
  window.addEventListener('blur', finishDrag);
  handle.addEventListener('dblclick', () => applyWidth(defaultWidth, true));
  handle.addEventListener('keydown', event => {
    const width = sidebar.getBoundingClientRect().width;
    const step = event.shiftKey ? 40 : 10;
    const widths = { ArrowLeft: width - step, ArrowRight: width + step, Home: minWidth, End: maxWidth(), Enter: defaultWidth };
    if (!(event.key in widths)) return;
    event.preventDefault();
    applyWidth(widths[event.key], true);
  });
  window.addEventListener('resize', () => applyWidth(preferredWidth));
  applyWidth(preferredWidth);
}
