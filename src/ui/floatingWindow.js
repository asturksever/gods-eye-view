/**
 * Turn a fixed-position panel into a portable, resizable window: drag it by a
 * handle, resize it from any edge or corner, remember where it went, and snap
 * it back with a double-click on the handle. Works on panels the layout engine
 * positions too — the first drag lifts the panel out of its stack by
 * switching it to `position: fixed` (class `gev-floating`).
 */

const DRAG_THRESHOLD_PX = 4;
const EDGE_MARGIN_PX = 6;
/** Resize directions: compass edges first, then corners. */
const RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'sw', 'se'];
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
 * Work out the box a resize gesture produces. Edges named in `dir` move with
 * the pointer; the opposite edge stays put, so growing from the left keeps
 * the right side pinned. Minimum size and the viewport margin win over the
 * pointer.
 */
export function resizeBox(
  box,
  dir,
  dx,
  dy,
  {
    minWidth,
    minHeight,
    viewportWidth = Infinity,
    viewportHeight = Infinity,
    margin = EDGE_MARGIN_PX,
  } = {},
) {
  let { left, top, width, height } = box;
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  if (dir.includes('e'))
    width = clamp(box.width + dx, minWidth, viewportWidth - margin - box.left);
  if (dir.includes('s'))
    height = clamp(
      box.height + dy,
      minHeight,
      viewportHeight - margin - box.top,
    );
  if (dir.includes('w')) {
    width = clamp(box.width - dx, minWidth, right - margin);
    left = right - width;
  }
  if (dir.includes('n')) {
    height = clamp(box.height - dy, minHeight, bottom - margin);
    top = bottom - height;
  }
  return { left, top, width, height };
}

/**
 * @param {HTMLElement} panel The window element.
 * @param {object} options
 * @param {HTMLElement} options.handle Drag handle (usually the header).
 * @param {string} options.storageKey localStorage key for position and size.
 * @param {number} [options.minWidth=280]
 * @param {number} [options.minHeight=140]
 * @param {boolean} [options.resizable=true] Adds handles on all four edges and corners.
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
  const edges = [];

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

  /**
   * Remember position, plus width/height only when they were set explicitly
   * (a drag or a resize). A collapsed panel's measured height must not be
   * frozen into storage, or it could never expand again.
   */
  function persist() {
    if (!storageKey) return;
    if (!isFloating()) return writeStorage(storageKey, null);
    const box = currentBox();
    writeStorage(storageKey, {
      left: box.left,
      top: box.top,
      width: panel.style.width ? box.width : undefined,
      height: panel.style.height ? box.height : undefined,
      v: 2,
    });
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
  if (
    stored?.v === 2 &&
    Number.isFinite(stored.left) &&
    Number.isFinite(stored.top)
  ) {
    apply(stored);
    onChange({ floating: true, resizing: false });
  } else if (stored) writeStorage(storageKey, null);

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
        apply({ left: box.left, top: box.top, width: box.width });
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

  // Resize from any edge or corner. The bottom-right corner keeps its
  // visible grip; the other handles are thin invisible strips.
  function startResize(event, dir) {
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
      apply(
        resizeBox(box, dir, move.clientX - startX, move.clientY - startY, {
          minWidth,
          minHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
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
  }

  if (resizable) {
    for (const dir of RESIZE_DIRECTIONS) {
      const handle = document.createElement('div');
      handle.className = dir === 'se' ? 'gev-resize-grip' : 'gev-resize-edge';
      handle.dataset.dir = dir;
      handle.setAttribute('aria-hidden', 'true');
      if (dir === 'se')
        handle.title = 'Drag to resize · double-click the header to snap back';
      panel.appendChild(handle);
      listen(handle, 'pointerdown', (event) => startResize(event, dir));
      if (dir === 'se') grip = handle;
      else edges.push(handle);
    }
  }

  // Keep a floating window on screen when the viewport shrinks.
  listen(window, 'resize', () => {
    if (!isFloating()) return;
    const { left, top } = currentBox();
    apply({ left, top });
  });

  return {
    isFloating,
    reset,
    destroy() {
      abort.abort();
      grip?.remove();
      for (const edge of edges) edge.remove();
      handle.classList.remove('gev-floating-handle');
    },
  };
}
