import { makeFloating } from './floatingWindow.js';

const DOCK_STORAGE_KEY = 'gev:mapillary-dock:collapsed';
const DOCK_WINDOW_KEY = 'gev:mapillary-dock:window:v1';
const RENDER_MODE_KEY = 'gev:mapillary:render-mode';
const MAPILLARY_APP_URL = 'https://www.mapillary.com/app/';

/** Deep link to an image on mapillary.com, as the web app shares them. */
export function mapillaryImageUrl(imageId) {
  const id = String(imageId || '').trim();
  if (!id) return MAPILLARY_APP_URL;
  return `${MAPILLARY_APP_URL}?pKey=${encodeURIComponent(id)}&focus=photo`;
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

/**
 * Own the Mapillary dock: the AI query box, result chips, progress, the
 * street-level viewer host and its controls. Receives the layer instance and
 * application actions; never reaches into the layer's internals.
 */
export class MapillaryControls {
  constructor({ root, mapillary, actions }) {
    this.root = root;
    this.mapillary = mapillary;
    this.actions = actions;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._unsubscribe = null;
    this._state = null;
    this._lastStage = null;
    this._elements = this._collect();
    this._bind();
    this._restoreCollapsed();
  }

  _collect() {
    const byId = (id) => this.root?.querySelector(`#${id}`) || null;
    return {
      toggle: byId('mly-dock-toggle'),
      body: byId('mly-body'),
      statusChip: byId('mly-status-chip'),
      enableBtn: byId('mly-enable-btn'),
      form: byId('mly-query-form'),
      input: byId('mly-query-input'),
      runBtn: byId('mly-query-run'),
      answer: byId('mly-answer'),
      progress: byId('mly-progress'),
      progressFill: byId('mly-progress-fill'),
      progressLabel: byId('mly-progress-label'),
      results: byId('mly-results'),
      chips: byId('mly-result-chips'),
      frameBtn: byId('mly-frame-btn'),
      threeDBtn: byId('mly-3d-btn'),
      threeDNote: byId('mly-3d-note'),
      photorealBtn: byId('mly-photoreal-btn'),
      sinceSelect: byId('mly-since'),
      aiHint: byId('mly-ai-hint'),
      aiModel: byId('mly-ai-model'),
      clearBtn: byId('mly-clear-btn'),
      lookBtn: byId('mly-look-btn'),
      followBtn: byId('mly-follow-btn'),
      closeBtn: byId('mly-viewer-close'),
      viewerWrap: byId('mly-viewer-wrap'),
      viewerExpand: byId('mly-viewer-expand'),
      viewerFit: byId('mly-viewer-fit'),
      imageBy: byId('mly-image-by'),
      imageWhen: byId('mly-image-when'),
      imageLink: byId('mly-image-link'),
      header: this.root?.querySelector('.mly-header') || null,
      viewer: byId('mly-viewer'),
      imageMeta: byId('mly-image-meta'),
      coverageMeta: byId('mly-coverage-meta'),
    };
  }

  listen(target, type, handler, options = {}) {
    target?.addEventListener(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }

  _bind() {
    const el = this._elements;
    if (!this.root) return;
    this.mapillary.attachViewerHost?.(el.viewer);
    this.listen(el.toggle, 'click', () =>
      this.setCollapsed(!this.root.classList.contains('collapsed')),
    );
    // Portable, resizable window: drag the header, resize from the grip.
    this._floating = makeFloating(this.root, {
      handle: el.header,
      storageKey: DOCK_WINDOW_KEY,
      dragThrough: '.mly-title-btn',
      minWidth: 320,
      minHeight: 220,
      onChange: () => this.mapillary.resizeViewer?.(),
    });
    this.listen(el.viewerExpand, 'click', () =>
      this.setViewerExpanded(
        !this.root.classList.contains('mly-viewer-expanded'),
      ),
    );
    this.listen(document, 'keydown', (event) => {
      if (
        event.key === 'Escape' &&
        this.root.classList.contains('mly-viewer-expanded')
      )
        this.setViewerExpanded(false);
    });
    this.listen(el.viewerFit, 'click', () => {
      const next =
        this._state?.street?.renderMode === 'fill' ? 'letterbox' : 'fill';
      this.mapillary.setViewerRenderMode?.(next);
      try {
        localStorage.setItem(RENDER_MODE_KEY, next);
      } catch {
        /* storage unavailable */
      }
    });
    try {
      const stored = localStorage.getItem(RENDER_MODE_KEY);
      if (stored === 'fill' || stored === 'letterbox')
        this.mapillary.setViewerRenderMode?.(stored);
    } catch {
      /* storage unavailable */
    }
    // MapillaryJS only tracks window resizes; the dock resizes on its own
    // (drag grip, expand, reflow), so watch the host element directly.
    if (typeof ResizeObserver === 'function' && el.viewer) {
      let queued = false;
      this._resizeObserver = new ResizeObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          this.mapillary.resizeViewer?.();
        });
      });
      this._resizeObserver.observe(el.viewer);
    }
    this.listen(el.enableBtn, 'click', () => this._toggleEnabled());
    this.listen(el.form, 'submit', (event) => {
      event.preventDefault();
      this._run(el.input?.value);
    });
    for (const button of this.root.querySelectorAll('[data-mly-suggestion]')) {
      this.listen(button, 'click', () => {
        if (el.input) el.input.value = button.dataset.mlySuggestion || '';
        this._run(button.dataset.mlySuggestion);
      });
    }
    this.listen(el.frameBtn, 'click', () => this.mapillary.frameResults?.());
    this.listen(el.clearBtn, 'click', () => this.mapillary.clearQuery?.());
    this.listen(el.lookBtn, 'click', async () => {
      if (!(await this._ensureEnabled())) return;
      this.setCollapsed(false);
      this.mapillary.openNearest?.();
    });
    this.listen(el.followBtn, 'click', () => {
      const next = !(this._state?.street?.follow === true);
      this.mapillary.setFollow?.(next);
    });
    this.listen(el.closeBtn, 'click', () => this.mapillary.closeViewer?.());
    this.listen(el.threeDBtn, 'click', () => {
      const next = !(this._state?.objects3d?.enabled === true);
      this.mapillary.setObjects3d?.(next);
    });
    for (const button of this.root.querySelectorAll('[data-mly-pano]')) {
      this.listen(button, 'click', () =>
        this.mapillary.setCoverageFilter?.({ pano: button.dataset.mlyPano }),
      );
    }
    this.listen(el.sinceSelect, 'change', () => {
      const value = String(el.sinceSelect.value || '0');
      let sinceMs = null;
      if (value.startsWith('year:'))
        sinceMs = Date.UTC(Number(value.slice(5)), 0, 1);
      else if (Number(value) > 0)
        sinceMs = Date.now() - Number(value) * 86_400_000;
      this.mapillary.setCoverageFilter?.({ sinceMs });
    });
    this.listen(el.photorealBtn, 'click', async () => {
      const result = await this.actions.setMapStack?.('photoreal');
      if (result?.error) this.actions.showToast?.(result.error);
    });
    // Keep the app's keyboard shortcuts from firing while typing a query.
    this.listen(el.input, 'keydown', (event) => event.stopPropagation());
    this.listen(el.input, 'keyup', (event) => event.stopPropagation());
  }

  async _ensureEnabled() {
    if (this.actions.isEnabled?.()) return true;
    try {
      await this.actions.setEnabled?.(true);
    } catch (error) {
      this.actions.showToast?.(
        error?.message || 'Street Level could not start',
      );
      return false;
    }
    return this.actions.isEnabled?.() === true;
  }

  async _toggleEnabled() {
    const enabled = this.actions.isEnabled?.() === true;
    try {
      await this.actions.setEnabled?.(!enabled);
    } catch (error) {
      this.actions.showToast?.(error?.message || 'Street Level toggle failed');
    }
    if (!enabled) this.setCollapsed(false);
  }

  async _run(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return;
    if (!(await this._ensureEnabled())) return;
    this.setCollapsed(false);
    this.mapillary.runQuery?.(text);
  }

  connect() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this.destroyed || !this.root) return;
    this._unsubscribe = this.mapillary.subscribe?.((state) =>
      this.render(state),
    );
    if (this.mapillary.getUIState) this.render(this.mapillary.getUIState());
  }

  _restoreCollapsed() {
    // Open by default: the typed Mapillary AI box is the front door.
    let collapsed = false;
    try {
      const stored = localStorage.getItem(DOCK_STORAGE_KEY);
      if (stored === '1') collapsed = true;
    } catch {
      /* storage unavailable */
    }
    this.setCollapsed(collapsed, { persist: false });
  }

  /** Grow the street-level viewer to most of the screen, or shrink it back. */
  setViewerExpanded(expanded) {
    if (!this.root) return;
    const on = expanded === true;
    const wrap = this._elements.viewerWrap;
    if (on === this.root.classList.contains('mly-viewer-expanded')) return;
    this.root.classList.toggle('mly-viewer-expanded', on);
    if (wrap) {
      if (on) {
        // Lift the viewer out of the dock: the dock's backdrop-filter would
        // otherwise pin a fixed-position child inside the panel.
        this._wrapHome = { parent: wrap.parentNode, next: wrap.nextSibling };
        document.body.appendChild(wrap);
        wrap.classList.add('mly-viewer-wrap-expanded');
      } else if (this._wrapHome?.parent) {
        wrap.classList.remove('mly-viewer-wrap-expanded');
        this._wrapHome.parent.insertBefore(wrap, this._wrapHome.next);
        this._wrapHome = null;
      }
    }
    const button = this._elements.viewerExpand;
    if (button) {
      button.textContent = on ? '⤡ SHRINK' : '⤢ EXPAND';
      button.setAttribute('aria-pressed', String(on));
    }
    requestAnimationFrame(() => this.mapillary.resizeViewer?.());
  }

  setCollapsed(collapsed, { persist = true } = {}) {
    if (!this.root) return;
    this.root.classList.toggle('collapsed', collapsed);
    this._elements.toggle?.setAttribute('aria-expanded', String(!collapsed));
    this._elements.toggle?.setAttribute(
      'title',
      collapsed ? 'Expand Mapillary' : 'Collapse Mapillary',
    );
    if (!collapsed) this.mapillary.resizeViewer?.();
    if (persist) {
      try {
        localStorage.setItem(DOCK_STORAGE_KEY, collapsed ? '1' : '0');
      } catch {
        /* storage unavailable */
      }
    }
  }

  render(state) {
    if (this.destroyed || !state || !this.root) return;
    this._state = state;
    const el = this._elements;
    const enabled = state.enabled === true;

    el.enableBtn.textContent = enabled ? 'STREET LEVEL ON' : 'STREET LEVEL OFF';
    el.enableBtn.setAttribute('aria-pressed', String(enabled));

    let chip = enabled ? 'ON' : 'OFF';
    let chipClass = enabled ? 'is-on' : '';
    if (state.keyRequired) {
      chip = 'KEY REQUIRED';
      chipClass = 'is-warn';
    } else if (state.query.busy) {
      chip = `AI · ${state.query.stage.toUpperCase()}`;
      chipClass = 'is-busy';
    } else if (state.coverage.loading || state.features.loading) {
      chip = 'LOADING';
      chipClass = 'is-busy';
    }
    el.statusChip.textContent = chip;
    el.statusChip.className = `mly-chip ${chipClass}`.trim();

    if (enabled && this._wasEnabled === false) this.setCollapsed(false);
    this._wasEnabled = enabled;

    el.runBtn.disabled = state.query.busy;
    el.runBtn.textContent = state.query.busy ? '…' : 'ASK';
    el.input.disabled = false;
    el.input.placeholder = state.planner
      ? 'Type a question, e.g. show me all fire hydrants in Sacramento'
      : 'Add an Anthropic key in POWER UP to enable Mapillary AI';
    if (el.aiModel)
      el.aiModel.textContent = state.plannerModel
        ? `· ${state.plannerModel}`
        : '';
    if (el.aiHint) {
      el.aiHint.classList.toggle('is-warn', !state.planner);
      el.aiHint.textContent = state.planner
        ? 'Type what you want to see in plain English — objects, traffic signs, coverage or a street view of any place — and press Enter. Follow-ups refine the last answer.'
        : 'Mapillary AI is off until an Anthropic key is added in POWER UP. Coverage, sequences and the viewer work without it.';
    }

    // Imagery filters.
    const filter = state.coverage.filter || { pano: 'all', sinceMs: null };
    for (const button of this.root.querySelectorAll('[data-mly-pano]')) {
      const active = button.dataset.mlyPano === filter.pano;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    }

    // 3D objects.
    const objects = state.objects3d || {};
    el.threeDBtn.setAttribute('aria-pressed', String(objects.enabled === true));
    el.threeDBtn.textContent = objects.building
      ? '3D OBJECTS …'
      : objects.enabled
        ? '3D OBJECTS ON'
        : '3D OBJECTS OFF';
    el.threeDNote.hidden = !(
      objects.enabled &&
      (objects.error || objects.active)
    );
    el.threeDNote.textContent = objects.error
      ? objects.error
      : objects.active
        ? `${objects.count.toLocaleString()} objects standing in 3D · click one to open its image`
        : '';

    el.photorealBtn.setAttribute(
      'aria-pressed',
      String(this.actions.isMapStackActive?.('photoreal') === true),
    );

    // Answer / error line.
    const error = state.query.error || state.street.error;
    if (error) {
      el.answer.textContent = error;
      el.answer.classList.add('is-error');
    } else {
      el.answer.classList.remove('is-error');
      if (state.query.answer) el.answer.textContent = state.query.answer;
      else if (state.query.busy) el.answer.textContent = 'Planning…';
      else if (!enabled)
        el.answer.textContent =
          'Turn on Street Level to see Mapillary coverage, then ask for anything that appears in street imagery.';
      else if (state.coverage.hint) el.answer.textContent = state.coverage.hint;
      else
        el.answer.textContent =
          'Click a green sequence to see its images, or ask Mapillary AI for objects and signs.';
    }

    // Progress bar while tiles stream.
    const { progress } = state.features;
    const showProgress = state.features.loading && progress.tiles > 0;
    el.progress.hidden = !showProgress;
    if (showProgress) {
      const pct = Math.round((progress.done / progress.tiles) * 100);
      el.progressFill.style.width = `${pct}%`;
      el.progressLabel.textContent = `${progress.done}/${progress.tiles} tiles · ${state.features.total.toLocaleString()} found`;
    }

    // Result chips.
    const hasResults = state.features.total > 0 || state.features.hasBbox;
    el.results.hidden = !hasResults;
    if (hasResults) {
      el.chips.replaceChildren(
        ...state.features.counts
          .slice(0, 8)
          .map(({ value, count, label, color }) => {
            const chipEl = document.createElement('span');
            chipEl.className = 'mly-value-chip';
            chipEl.title = value;
            const dot = document.createElement('i');
            dot.style.background = color;
            const text = document.createElement('span');
            text.textContent = label;
            const num = document.createElement('b');
            num.textContent = count.toLocaleString();
            chipEl.append(dot, text, num);
            return chipEl;
          }),
      );
      if (state.features.counts.length > 8) {
        const more = document.createElement('span');
        more.className = 'mly-value-chip';
        more.textContent = `+${state.features.counts.length - 8} classes`;
        el.chips.append(more);
      }
    }

    // Street-level viewer.
    const { street } = state;
    el.viewerWrap.hidden = !street.open;
    this.root.classList.toggle('mly-has-viewer', street.open === true);
    if (!street.open && this.root.classList.contains('mly-viewer-expanded'))
      this.setViewerExpanded(false);
    el.followBtn.setAttribute('aria-pressed', String(street.follow === true));
    el.followBtn.textContent = street.follow
      ? 'STREET COCKPIT ON'
      : 'STREET COCKPIT OFF';
    el.followBtn.disabled = !street.open;
    if (el.viewerFit) {
      const fill = street.renderMode === 'fill';
      el.viewerFit.textContent = fill ? 'FILL' : 'FIT';
      el.viewerFit.title = fill
        ? 'Filling the frame (cropped) · click to show the whole image'
        : 'Showing the whole image · click to fill the frame';
    }
    if (street.open) {
      // Caption bar as on mapillary.com: "Image by …" left, date right.
      const left = [];
      if (street.loading) left.push('LOADING…');
      if (street.feature?.label)
        left.push(
          `${street.feature.label}${street.feature.imageCount ? ` · ${street.feature.imageCount} sightings` : ''}`,
        );
      if (street.highlight?.count)
        left.push(
          `${street.highlight.count} detection${street.highlight.count === 1 ? '' : 's'} outlined`,
        );
      if (street.creator) left.push(`Image by ${street.creator}`);
      const right = [];
      if (street.isPano) right.push('360°');
      if (Number.isFinite(street.bearing))
        right.push(`${Math.round(street.bearing)}°`);
      if (street.capturedAt) right.push(formatDate(street.capturedAt));
      if (el.imageBy) el.imageBy.textContent = left.join(' · ');
      if (el.imageWhen) el.imageWhen.textContent = right.join(' · ');
      if (el.imageLink) {
        el.imageLink.href = mapillaryImageUrl(street.imageId);
        el.imageLink.hidden = !street.imageId;
      }
      this.mapillary.resizeViewer?.();
    }

    // Coverage meta line.
    const coverageBits = [];
    if (enabled && state.coverage.zoom)
      coverageBits.push(
        `coverage z${state.coverage.zoom} · ${state.coverage.sequences.toLocaleString()} sequences`,
      );
    if (state.sequence.selectedId)
      coverageBits.push(
        state.sequence.loading
          ? 'loading sequence…'
          : `${state.sequence.images} images in sequence · Esc clears`,
      );
    if (state.query.usage?.model)
      coverageBits.push(
        `${state.query.usage.model} · ${state.query.usage.input_tokens ?? '?'}→${state.query.usage.output_tokens ?? '?'} tok`,
      );
    el.coverageMeta.textContent = coverageBits.join(' · ');

    if (state.query.stage !== this._lastStage) {
      this._lastStage = state.query.stage;
      if (state.query.stage === 'done' || state.query.stage === 'error')
        this.setCollapsed(false);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setViewerExpanded(false);
    this.listeners.abort();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._floating?.destroy();
    this._unsubscribe?.();
    this._unsubscribe = null;
    this.mapillary.attachViewerHost?.(null);
  }
}
