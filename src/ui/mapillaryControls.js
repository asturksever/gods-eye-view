const DOCK_STORAGE_KEY = 'gev:mapillary-dock:collapsed';

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
      clearBtn: byId('mly-clear-btn'),
      lookBtn: byId('mly-look-btn'),
      followBtn: byId('mly-follow-btn'),
      closeBtn: byId('mly-viewer-close'),
      viewerWrap: byId('mly-viewer-wrap'),
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
    let collapsed = true;
    try {
      const stored = localStorage.getItem(DOCK_STORAGE_KEY);
      if (stored === '0') collapsed = false;
    } catch {
      /* storage unavailable */
    }
    this.setCollapsed(collapsed, { persist: false });
  }

  setCollapsed(collapsed, { persist = true } = {}) {
    if (!this.root) return;
    this.root.classList.toggle('collapsed', collapsed);
    this._elements.toggle?.setAttribute('aria-expanded', String(!collapsed));
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

    el.runBtn.disabled = state.query.busy;
    el.runBtn.textContent = state.query.busy ? '…' : 'ASK';
    el.input.disabled = false;
    el.input.placeholder = state.planner
      ? 'show me all fire hydrants in Sacramento'
      : 'Add an Anthropic key in POWER UP to enable Mapillary AI';

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
    el.closeBtn.hidden = !street.open;
    el.followBtn.setAttribute('aria-pressed', String(street.follow === true));
    el.followBtn.textContent = street.follow
      ? 'STREET COCKPIT ON'
      : 'STREET COCKPIT OFF';
    el.followBtn.disabled = !street.open;
    if (street.open) {
      const parts = [];
      if (street.loading) parts.push('LOADING…');
      if (street.capturedAt)
        parts.push(`captured ${formatDate(street.capturedAt)}`);
      if (Number.isFinite(street.bearing))
        parts.push(`hdg ${Math.round(street.bearing)}°`);
      if (street.isPano) parts.push('360°');
      if (street.creator) parts.push(`© ${street.creator}`);
      if (street.feature?.label)
        parts.unshift(
          `${street.feature.label}${street.feature.imageCount ? ` · ${street.feature.imageCount} sightings` : ''}`,
        );
      el.imageMeta.textContent = parts.join(' · ');
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
    this.listeners.abort();
    this._unsubscribe?.();
    this._unsubscribe = null;
    this.mapillary.attachViewerHost?.(null);
  }
}
