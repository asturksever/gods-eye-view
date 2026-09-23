import { presentMapillaryPanel } from './mapillaryPresentation.js';

export { mapillaryImageUrl } from './mapillaryPresentation.js';

const RENDER_MODE_KEY = 'gev:mapillary:render-mode';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Own the Street Level panel: the query box, result chips, progress, the
 * imagery filters and the embedded MapillaryJS viewer. The panel itself is
 * ordinary GEV chrome (collapse button, rail layout, persistence) driven by
 * the application shell; this class only fills the body and asks the shell
 * to open the panel when something worth seeing arrives.
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
    this._view = null;
    this._wasEnabled = null;
    this._wasStreetOpen = false;
    this._lastStage = null;
    this._wrapHome = null;
    this._expandReturnFocus = null;
    this._elements = this._collect();
    this._bind();
  }

  _collect() {
    const byId = (id) => this.root?.querySelector(`#${id}`) || null;
    return {
      status: byId('mly-status'),
      keyless: byId('mly-keyless'),
      keylessBtn: byId('mly-keyless-btn'),
      controls: byId('mly-controls'),
      enableBtn: byId('mly-enable-btn'),
      lookBtn: byId('mly-look-btn'),
      form: byId('mly-query-form'),
      input: byId('mly-query-input'),
      runBtn: byId('mly-query-run'),
      hint: byId('mly-ai-hint'),
      answer: byId('mly-answer'),
      error: byId('mly-error'),
      errorText: byId('mly-error-text'),
      progress: byId('mly-progress'),
      progressFill: byId('mly-progress-fill'),
      progressLabel: byId('mly-progress-label'),
      results: byId('mly-results'),
      chips: byId('mly-result-chips'),
      frameBtn: byId('mly-frame-btn'),
      clearBtn: byId('mly-clear-btn'),
      sinceSelect: byId('mly-since'),
      legend: byId('mly-legend'),
      followBtn: byId('mly-follow-btn'),
      viewerWrap: byId('mly-viewer-wrap'),
      viewerExpand: byId('mly-viewer-expand'),
      viewerClose: byId('mly-viewer-close'),
      viewerPlaceholder: byId('mly-viewer-placeholder'),
      viewer: byId('mly-viewer'),
      imageBy: byId('mly-image-by'),
      imageWhen: byId('mly-image-when'),
      imageLink: byId('mly-image-link'),
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

    this.listen(el.keylessBtn, 'click', () => this.actions.openKeySetup?.());
    this.listen(el.enableBtn, 'click', () => this._toggleEnabled());
    this.listen(el.lookBtn, 'click', async () => {
      if (!(await this._ensureEnabled())) return;
      this.mapillary.openNearest?.();
    });
    this.listen(el.form, 'submit', (event) => {
      event.preventDefault();
      if (this._view?.query.submitIsStop) this.mapillary.abortQuery?.();
      else this._run(el.input?.value);
    });
    for (const button of this.root.querySelectorAll('[data-mly-suggestion]')) {
      this.listen(button, 'click', () => {
        if (el.input) el.input.value = button.dataset.mlySuggestion || '';
        this._run(button.dataset.mlySuggestion);
      });
    }
    this.listen(el.frameBtn, 'click', () => this.mapillary.frameResults?.());
    this.listen(el.clearBtn, 'click', () => this.mapillary.clearQuery?.());
    this.listen(el.chips, 'click', (event) => {
      const more = event.target.closest?.('[data-mly-more]');
      if (!more) return;
      const expanded = el.chips.classList.toggle('is-expanded');
      more.setAttribute('aria-expanded', String(expanded));
      more.textContent = expanded
        ? 'FEWER'
        : `+${more.dataset.mlyMore} CLASSES`;
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
    this.listen(el.followBtn, 'click', () => {
      this.mapillary.setFollow?.(!(this._state?.street?.follow === true));
    });
    this.listen(el.viewerClose, 'click', () => this.mapillary.closeViewer?.());
    this.listen(el.viewerExpand, 'click', () =>
      this.setViewerExpanded(!this.isViewerExpanded()),
    );
    for (const button of this.root.querySelectorAll('[data-mly-render]')) {
      this.listen(button, 'click', () => {
        const mode = button.dataset.mlyRender;
        this.mapillary.setViewerRenderMode?.(mode);
        try {
          localStorage.setItem(RENDER_MODE_KEY, mode);
        } catch {
          /* storage unavailable */
        }
      });
    }
    try {
      const stored = localStorage.getItem(RENDER_MODE_KEY);
      if (stored === 'fill' || stored === 'letterbox')
        this.mapillary.setViewerRenderMode?.(stored);
    } catch {
      /* storage unavailable */
    }
    // The expanded viewer is a dialog: Esc closes it, Tab stays inside.
    this.listen(el.viewerWrap, 'keydown', (event) => this._onDialogKey(event));
    // Keep the app's keyboard shortcuts from firing while typing a query,
    // but let Escape through so GEV's panel disclosure can collapse the panel.
    const shield = (event) => {
      if (event.key !== 'Escape') event.stopPropagation();
    };
    this.listen(el.input, 'keydown', shield);
    this.listen(el.input, 'keyup', shield);
    // MapillaryJS only tracks window resizes; the panel resizes on its own.
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
  }

  async _run(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return;
    if (!(await this._ensureEnabled())) return;
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

  /** Ask the shell to open (or close) the rail panel. */
  setCollapsed(collapsed, options = {}) {
    this.actions.setPanelCollapsed?.(collapsed, options);
    if (!collapsed)
      requestAnimationFrame(() => this.mapillary.resizeViewer?.());
  }

  isViewerExpanded() {
    return (
      this._elements.viewerWrap?.classList.contains(
        'mly-viewer-wrap-expanded',
      ) === true
    );
  }

  /** Grow the street-level viewer to most of the screen, or shrink it back. */
  setViewerExpanded(expanded) {
    const wrap = this._elements.viewerWrap;
    if (!wrap) return;
    const on = expanded === true;
    if (on === this.isViewerExpanded()) return;
    if (on) {
      // Lift the viewer out of the panel: the panel's backdrop-filter would
      // otherwise pin a fixed-position child inside it.
      this._wrapHome = { parent: wrap.parentNode, next: wrap.nextSibling };
      this._expandReturnFocus = document.activeElement;
      document.body.appendChild(wrap);
      wrap.classList.add('mly-viewer-wrap-expanded');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', 'Street-level image');
      wrap.tabIndex = -1;
      wrap.focus({ preventScroll: true });
    } else {
      wrap.classList.remove('mly-viewer-wrap-expanded');
      wrap.removeAttribute('role');
      wrap.removeAttribute('aria-modal');
      wrap.removeAttribute('aria-label');
      wrap.removeAttribute('tabindex');
      if (this._wrapHome?.parent)
        this._wrapHome.parent.insertBefore(wrap, this._wrapHome.next);
      this._wrapHome = null;
      const target = this._expandReturnFocus;
      this._expandReturnFocus = null;
      if (target?.isConnected && typeof target.focus === 'function')
        target.focus({ preventScroll: true });
      else this._elements.viewerExpand?.focus?.({ preventScroll: true });
    }
    const button = this._elements.viewerExpand;
    if (button) {
      const icon = button.querySelector('.mly-btn-icon');
      const text = button.querySelector('.mly-btn-text');
      if (icon) icon.textContent = on ? '⤡' : '⤢';
      if (text) text.textContent = on ? 'SHRINK' : 'EXPAND';
      button.setAttribute('aria-pressed', String(on));
      button.setAttribute('aria-label', on ? 'Shrink' : 'Expand');
    }
    requestAnimationFrame(() => this.mapillary.resizeViewer?.());
  }

  _onDialogKey(event) {
    if (!this.isViewerExpanded()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.setViewerExpanded(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const wrap = this._elements.viewerWrap;
    const focusable = [...wrap.querySelectorAll(FOCUSABLE)].filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!wrap.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }

  render(state) {
    if (this.destroyed || !state || !this.root) return;
    this._state = state;
    const view = presentMapillaryPanel(state);
    this._view = view;
    this._renderHeader(view);
    this._renderEmptyState(view);
    this._renderQuery(view);
    this._renderResults(view);
    this._renderFilters(view);
    this._renderViewer(view, state);
    this._renderMeta(view);
    this._reactToTransitions(view, state);
  }

  _renderHeader(view) {
    const el = this._elements;
    this.root.dataset.mlyEnabled = String(view.enabled);
    if (el.status) {
      el.status.textContent = view.status.text;
      el.status.className = `mly-status${view.status.tone ? ` is-${view.status.tone}` : ''}`;
    }
    if (el.enableBtn) {
      el.enableBtn.textContent = view.enableButton.text;
      el.enableBtn.setAttribute(
        'aria-pressed',
        String(view.enableButton.pressed),
      );
    }
  }

  _renderEmptyState(view) {
    const el = this._elements;
    if (el.keyless) el.keyless.hidden = !view.keyless.visible;
    if (el.controls) el.controls.disabled = view.controlsDisabled;
  }

  _renderQuery(view) {
    const el = this._elements;
    const { query } = view;
    if (el.input) {
      el.input.placeholder = query.placeholder;
      el.input.disabled = query.inputDisabled;
    }
    if (el.runBtn) {
      el.runBtn.textContent = query.submitLabel;
      el.runBtn.classList.toggle('is-stop', query.submitIsStop);
      el.runBtn.disabled = query.inputDisabled && !query.submitIsStop;
      el.runBtn.setAttribute(
        'aria-label',
        query.submitIsStop ? 'Stop the query' : 'Ask',
      );
    }
    for (const button of this.root.querySelectorAll('[data-mly-suggestion]'))
      button.disabled = query.suggestionsDisabled;
    if (el.hint) {
      el.hint.textContent = query.hint;
      el.hint.classList.toggle('is-warn', query.hintWarn);
    }
    if (el.answer) el.answer.textContent = view.answer;
    if (el.error) {
      el.error.hidden = !view.error;
      if (el.errorText) el.errorText.textContent = view.error || '';
    }
    if (el.progress) {
      el.progress.hidden = !view.progress.visible;
      el.progress.classList.toggle(
        'is-indeterminate',
        view.progress.indeterminate,
      );
      if (el.progressFill && !view.progress.indeterminate)
        el.progressFill.style.width = `${view.progress.percent}%`;
      if (el.progressFill && view.progress.indeterminate)
        el.progressFill.style.removeProperty('width');
      if (el.progressLabel) el.progressLabel.textContent = view.progress.label;
    }
  }

  _renderResults(view) {
    const el = this._elements;
    if (!el.results) return;
    el.results.hidden = !view.results.visible;
    if (!view.results.visible || !el.chips) return;
    const expanded = el.chips.classList.contains('is-expanded');
    const chip = (entry, overflow) => {
      const node = document.createElement('span');
      node.className = `mly-value-chip${overflow ? ' is-overflow' : ''}`;
      node.title = entry.value;
      const dot = document.createElement('i');
      dot.style.background = entry.color;
      const text = document.createElement('span');
      text.textContent = entry.label;
      const num = document.createElement('b');
      num.textContent = entry.count;
      node.append(dot, text, num);
      return node;
    };
    const nodes = view.results.all.map((entry, index) =>
      chip(entry, index >= view.results.chips.length),
    );
    if (view.results.more) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'mly-value-chip';
      more.dataset.mlyMore = String(view.results.more.count);
      more.title = view.results.more.title;
      more.setAttribute('aria-expanded', String(expanded));
      more.textContent = expanded
        ? 'FEWER'
        : `+${view.results.more.count} CLASSES`;
      nodes.push(more);
    } else el.chips.classList.remove('is-expanded');
    el.chips.replaceChildren(...nodes);
  }

  _renderFilters(view) {
    const el = this._elements;
    for (const button of this.root.querySelectorAll('[data-mly-pano]')) {
      const active = button.dataset.mlyPano === view.filter.pano;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    }
    if (el.legend && el.legend.childElementCount !== view.legend.length) {
      el.legend.replaceChildren(
        ...view.legend.map((entry) => {
          const item = document.createElement('li');
          const swatch = document.createElement('i');
          swatch.className = 'mly-legend-swatch';
          swatch.style.background = entry.color;
          const label = document.createElement('span');
          label.textContent = entry.label;
          item.append(swatch, label);
          return item;
        }),
      );
    }
  }

  _renderViewer(view, state) {
    const el = this._elements;
    const { viewer } = view;
    if (el.viewerWrap) el.viewerWrap.hidden = !viewer.open;
    if (!viewer.open && this.isViewerExpanded()) this.setViewerExpanded(false);
    if (el.viewerPlaceholder) el.viewerPlaceholder.hidden = !viewer.loading;
    if (el.followBtn) {
      el.followBtn.setAttribute('aria-pressed', String(viewer.follow.pressed));
      el.followBtn.disabled = viewer.follow.disabled;
    }
    for (const button of this.root.querySelectorAll('[data-mly-render]')) {
      const active = button.dataset.mlyRender === viewer.renderMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    }
    if (!viewer.open) return;
    if (el.imageBy) el.imageBy.textContent = viewer.captionLeft;
    if (el.imageWhen) el.imageWhen.textContent = viewer.captionRight;
    if (el.imageLink) {
      el.imageLink.hidden = !viewer.link;
      if (viewer.link) el.imageLink.href = viewer.link;
    }
    if (state.street.open) this.mapillary.resizeViewer?.();
  }

  _renderMeta(view) {
    const el = this._elements;
    if (el.coverageMeta) el.coverageMeta.textContent = view.meta;
  }

  /** Open the panel at the moments a user would look for it. */
  _reactToTransitions(view, state) {
    const enabled = view.enabled;
    if (enabled && this._wasEnabled === false) this.setCollapsed(false);
    this._wasEnabled = enabled;
    if (state.street.open && !this._wasStreetOpen) this.setCollapsed(false);
    this._wasStreetOpen = state.street.open === true;
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
    this._unsubscribe?.();
    this._unsubscribe = null;
    this.mapillary.attachViewerHost?.(null);
  }
}
