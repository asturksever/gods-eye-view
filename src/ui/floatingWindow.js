/**
 * Turn a fixed-position panel into a portable, resizable window: drag it by a
 * handle, resize it from a corner grip, remember where it went, and snap it
 * back with a double-click on the handle. Works on panels the layout engine
 * positions too — the first drag lifts the panel out of its stack by
 * switching it to `position: fixed` (class `gev-floating`).
 */

const DRAG_THRESHOLD_PX = 4;
const EDGE_MARGIN_PX = 6;
const INTERACTIVE =
  'input, select, option, textarea, button, a, [role="button"], [contenteditable]';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function readStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/**
 * @param {HTMLElement} panel The window element.
 * @param {object} options
 * @param {HTMLElement} options.handle Drag handle (usually the header).
 * @param {string} options.storageKey localStorage key for position and size.
 * @param {number} [options.minWidth=280]
 * @param {number} [options.minHeight=140]
 * @param {boolean} [options.resizable=true]
 * @param {string} [options.dragThrough] Selector for interactive children (a title
 *   button, say) that should still start a drag; their click is swallowed
 *   when a drag actually happened.
 * @param {(state: {floating: boolean, resizing: boolean}) => void} [options.onChange]
 * @returns {{destroy(): void, reset(): void, isFloating(): boolean}}
 */
export function makeFloating(
  panel,
  {
    handle,
    storageKey,
    minWidth = 280,
    minHeight = 140,
    resizable = true,
    dragThrough = null,
    onChange = () => {},
  } = {},
) {
  if (!panel || !handle)
    return { destroy() {}, reset() {}, isFloating: () => false };
  const abort = new AbortController();
  const { signal } = abort;
  const listen = (target, type, fn, options) =>
    target.addEventListener(type, fn, { ...options, signal });
  let grip = null;

  const isFloating = () => panel.classList.contains('gev-floating');

  function currentBox() {
    const rect = panel.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function apply({ left, top, width, height }) {
    const maxLeft = Math.max(
      EDGE_MARGIN_PX,
      window.innerWidth - (width || panel.offsetWidth) - EDGE_MARGIN_PX,
    );
    const maxTop = Math.max(
      EDGE_MARGIN_PX,
      window.innerHeight -
        Math.min(height || panel.offsetHeight, window.innerHeight * 0.5) -
        EDGE_MARGIN_PX,
    );
    panel.classList.add('gev-floating');
    panel.style.left = `${clamp(left, EDGE_MARGIN_PX, maxLeft)}px`;
    panel.style.top = `${clamp(top, EDGE_MARGIN_PX, maxTop)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    if (Number.isFinite(width))
      panel.style.width = `${clamp(width, minWidth, window.innerWidth - 2 * EDGE_MARGIN_PX)}px`;
    if (Number.isFinite(height))
      panel.style.height = `${clamp(height, minHeight, window.innerHeight - 2 * EDGE_MARGIN_PX)}px`;
  }

  function persist() {
    if (!storageKey) return;
    writeStorage(storageKey, isFloating() ? { ...currentBox(), v: 1 } : null);
  }

  function reset() {
    panel.classList.remove(
      'gev-floating',
      'gev-floating-dragging',
      'gev-floating-resizing',
    );
    for (const property of [
      'left',
      'top',
      'right',
      'bottom',
      'width',
      'height',
    ])
      panel.style.removeProperty(property);
    writeStorage(storageKey, null);
    onChange({ floating: false, resizing: false });
  }

  // Restore a remembered window.
  const stored = storageKey ? readStorage(storageKey) : null;
  if (stored && Number.isFinite(stored.left) && Number.isFinite(stored.top)) {
    apply(stored);
    onChange({ floating: true, resizing: false });
  }

  // Drag by the handle.
  handle.classList.add('gev-floating-handle');
  let swallowNextClick = false;
  listen(
    handle,
    'click',
    (event) => {
      if (!swallowNextClick) return;
      swallowNextClick = false;
      event.stopImmediatePropagation();
      event.preventDefault();
    },
    { capture: true },
  );
  listen(handle, 'pointerdown', (event) => {
    if (event.button !== 0) return;
    const interactive = event.target.closest(INTERACTIVE);
    if (interactive && !(dragThrough && interactive.matches(dragThrough)))
      return;
    // A header drag must not start a text selection across the page.
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let box = null;
    let offsetX = 0;
    let offsetY = 0;
    const onMove = (move) => {
      if (!dragging) {
        if (
          Math.hypot(move.clientX - startX, move.clientY - startY) <
          DRAG_THRESHOLD_PX
        )
          return;
        dragging = true;
        box = currentBox();
        offsetX = startX - box.left;
        offsetY = startY - box.top;
        panel.classList.add('gev-floating-dragging');
        try {
          window.getSelection()?.removeAllRanges();
        } catch {
          /* no selection API */
        }
        apply({ left: box.left, top: box.top });
        onChange({ floating: true, resizing: false });
      }
      move.preventDefault();
      apply({ left: move.clientX - offsetX, top: move.clientY - offsetY });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!dragging) return;
      swallowNextClick = true;
      setTimeout(() => {
        swallowNextClick = false;
      }, 0);
      panel.classList.remove('gev-floating-dragging');
      persist();
      onChange({ floating: true, resizing: false });
    };
    window.addEventListener('pointermove', onMove, { signal });
    window.addEventListener('pointerup', onUp, { signal });
    window.addEventListener('pointercancel', onUp, { signal });
  });
  listen(handle, 'dblclick', (event) => {
    if (event.target.closest(INTERACTIVE)) return;
    if (isFloating()) reset();
  });

  // Resize from the bottom-right grip.
  if (resizable) {
    grip = document.createElement('div');
    grip.className = 'gev-resize-grip';
    grip.title = 'Drag to resize · double-click the header to snap back';
    grip.setAttribute('aria-hidden', 'true');
    panel.appendChild(grip);
    listen(grip, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const box = currentBox();
      const startX = event.clientX;
      const startY = event.clientY;
      panel.classList.add('gev-floating-resizing');
      apply(box);
      onChange({ floating: true, resizing: true });
      const onMove = (move) => {
        move.preventDefault();
        apply({
          left: box.left,
          top: box.top,
          width: box.width + (move.clientX - startX),
          height: box.height + (move.clientY - startY),
        });
        onChange({ floating: true, resizing: true });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        panel.classList.remove('gev-floating-resizing');
        persist();
        onChange({ floating: true, resizing: false });
      };
      window.addEventListener('pointermove', onMove, { signal });
      window.addEventListener('pointerup', onUp, { signal });
      window.addEventListener('pointercancel', onUp, { signal });
    });
  }

  // Keep a floating window on screen when the viewport shrinks.
  listen(window, 'resize', () => {
    if (isFloating()) apply(currentBox());
  });

  return {
    isFloating,
    reset,
    destroy() {
      abort.abort();
      grip?.remove();
      handle.classList.remove('gev-floating-handle');
    },
  };
}
