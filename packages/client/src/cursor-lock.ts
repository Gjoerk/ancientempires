/**
 * In fullscreen the real mouse pointer is locked to the game, so that pushing it against the edge of
 * the screen to scroll cannot carry it onto another monitor. A drawn cursor stands in for the real
 * one, and every mouse event is passed on as if it happened where the drawn cursor is, so the rest
 * of the game does not need to know about the lock.
 */

const ARROW = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="24" viewBox="0 0 20 24">' +
  '<path d="M1 1 L1 19 L6 14.5 L9.5 22 L12.5 20.6 L9 13.2 L15.5 13.2 Z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>',
);
const CROSS = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 23 23">' +
  '<path d="M11.5 1v8M11.5 14v8M1 11.5h8M14 11.5h8" stroke="#000" stroke-width="3.5"/>' +
  '<path d="M11.5 1v8M11.5 14v8M1 11.5h8M14 11.5h8" stroke="#fff" stroke-width="1.5"/></svg>',
);

const PASSED_ON = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup'] as const;

export function installCursorLock(target: HTMLElement, wanted: () => boolean): void {
  const drawn = document.createElement('img');
  drawn.alt = '';
  drawn.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;display:none;';
  document.body.append(drawn);

  let x = 0;
  let y = 0;
  let hovered: Element | null = null;
  const locked = () => document.pointerLockElement === target;

  const place = () => {
    const onMap = hovered === target;
    const src = onMap ? CROSS : ARROW;
    if (drawn.getAttribute('src') !== src) drawn.src = src;
    drawn.style.transform = onMap ? `translate(${x - 11.5}px, ${y - 11.5}px)` : `translate(${x - 1}px, ${y - 1}px)`;
  };

  const init = (ev: MouseEvent): MouseEventInit => ({
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x, screenY: y,
    button: ev.button, buttons: ev.buttons, detail: ev.detail,
    ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey, metaKey: ev.metaKey,
  });

  const hover = (ev: MouseEvent) => {
    const now = document.elementFromPoint(x, y);
    if (now === hovered) return;
    hovered?.dispatchEvent(new MouseEvent('mouseout', { ...init(ev), relatedTarget: now }));
    now?.dispatchEvent(new MouseEvent('mouseover', { ...init(ev), relatedTarget: hovered }));
    hovered = now;
  };

  const moveBy = (dx: number, dy: number, ev: MouseEvent) => {
    x = Math.max(0, Math.min(innerWidth - 1, x + dx));
    y = Math.max(0, Math.min(innerHeight - 1, y + dy));
    hover(ev);
    place();
    (hovered ?? target).dispatchEvent(new MouseEvent('mousemove', init(ev)));
  };
  // Only real events are caught here; the copies sent on below pass straight through.
  window.addEventListener('mousemove', (ev) => {
    if (!ev.isTrusted || !locked()) return;
    ev.stopImmediatePropagation();
    moveBy(ev.movementX, ev.movementY, ev);
  }, true);
  // Test browsers report no real movement while the pointer is locked, so tests move the drawn cursor directly.
  if (import.meta.env.DEV) Object.assign(window, { __cursorMove: (dx: number, dy: number) => moveBy(dx, dy, new MouseEvent('mousemove')) });

  for (const type of PASSED_ON) {
    window.addEventListener(type, (ev) => {
      if (!ev.isTrusted || !locked()) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      hover(ev);
      const at = hovered ?? target;
      if (type === 'mousedown' && at instanceof HTMLElement && at.matches('input, textarea')) at.focus();
      at.dispatchEvent(type.startsWith('pointer')
        ? new PointerEvent(type, { ...init(ev), pointerType: 'mouse', isPrimary: true })
        : new MouseEvent(type, init(ev)));
    }, true);
  }

  window.addEventListener('wheel', (ev) => {
    if (!ev.isTrusted || !locked()) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    (hovered ?? target).dispatchEvent(new WheelEvent('wheel', { ...init(ev), deltaX: ev.deltaX, deltaY: ev.deltaY, deltaMode: ev.deltaMode }));
  }, { capture: true, passive: false });

  // A click into the game while in fullscreen takes the pointer; the click itself still counts.
  window.addEventListener('mousedown', (ev) => {
    if (!ev.isTrusted || locked() || !document.fullscreenElement || !wanted()) return;
    x = ev.clientX;
    y = ev.clientY;
    void Promise.resolve(target.requestPointerLock()).catch(() => undefined);
  }, true);

  document.addEventListener('pointerlockchange', () => {
    drawn.style.display = locked() ? 'block' : 'none';
    hovered = locked() ? document.elementFromPoint(x, y) : null;
    place();
  });
  // Leaving fullscreen frees the pointer again.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && locked()) document.exitPointerLock();
  });
}
