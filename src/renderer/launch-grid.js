// Light the grid beneath the pointer without moving the grid or intercepting clicks.
export function setupLaunchGridHighlight(region) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0;
  let pointerX = 0;
  let pointerY = 0;

  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    region.classList.remove('is-pointer-active');
  }

  region.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || reducedMotion.matches) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const bounds = region.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return reset();
      region.style.setProperty('--grid-pointer-x', `${pointerX - bounds.left}px`);
      region.style.setProperty('--grid-pointer-y', `${pointerY - bounds.top}px`);
      region.classList.add('is-pointer-active');
    });
  });
  region.addEventListener('pointerleave', reset);
  region.addEventListener('pointercancel', reset);
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  reducedMotion.addEventListener('change', reset);
  return reset;
}
