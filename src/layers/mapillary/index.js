import { createState } from './state.js';
import { createCoverage } from './coverage.js';
import { createSequences } from './sequences.js';
import { createFeatures } from './features.js';
import { createViewerBridge } from './viewerBridge.js';
import { createQuery } from './query.js';
import { createSelection } from './selection.js';
import * as Cesium from 'cesium';
import {
  COLORS,
  COVERAGE_RECENT_DAYS,
  MAPILLARY_CREDIT_HTML,
  MAPILLARY_KEY_ID,
  MAPILLARY_LAYER_ID,
} from './policy.js';
import { groupCountsByLabel, humanizeValue } from './values.js';

export { MAPILLARY_LAYER_ID } from './policy.js';

const SOURCE_METHODS = [
  'getStatus',
  'getTile',
  'queryFeatures',
  'plan',
  'geocode',
  'getImage',
  'getSequenceImages',
  'nearestImages',
  'getMapFeature',
  'spriteUrl',
];

/**
 * Construct the Mapillary street-level layer: camera-driven coverage,
 * per-sequence image cones, the embedded viewer, and the natural-language
 * feature query. Application services are injected; nothing here reads the
 * DOM except the viewer host the UI hands over.
 */
export function createMapillaryLayer({ source, services = {} }) {
  if (!SOURCE_METHODS.every((method) => typeof source?.[method] === 'function'))
    throw new TypeError('A Mapillary source is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, source, parts };
  parts.coverage = createCoverage(context);
  parts.sequences = createSequences(context);
  parts.features = createFeatures(context);
  parts.viewer = createViewerBridge(context);
  parts.query = createQuery(context);
  parts.selection = createSelection(context);

  // Street-level actions shared by clicks, the query engine and the UI.
  parts.street = {
    async openImage(imageId, { keepFeature = false } = {}) {
      const host = state.street.host;
      if (!host) {
        state.street.error = 'Open the Mapillary panel to view imagery';
        notify();
        return;
      }
      if (!keepFeature) {
        parts.features.clearSelection();
        state.street.feature = null;
      }
      await parts.viewer.open(imageId, host);
    },
    async openFeature(featureId) {
      const row = parts.features.findRow(featureId);
      parts.features.select(featureId);
      state.street.loading = true;
      state.street.error = null;
      state.street.feature = row
        ? {
            id: featureId,
            value: row[3],
            label: humanizeValue(row[3]),
            firstSeen: row[4],
            lastSeen: row[5],
          }
        : { id: featureId };
      notify();
      try {
        const detail = await source.getMapFeature(featureId);
        const images = detail?.images?.data || [];
        state.street.feature = {
          ...state.street.feature,
          value: detail.object_value,
          label: humanizeValue(detail.object_value),
          firstSeen:
            Date.parse(detail.first_seen_at) || state.street.feature.firstSeen,
          lastSeen:
            Date.parse(detail.last_seen_at) || state.street.feature.lastSeen,
          imageCount: images.length,
        };
        if (!images.length) throw new Error('No image detected this feature');
        await parts.street.openImage(images[0].id, { keepFeature: true });
        await parts.viewer.highlightDetections(
          images[0].id,
          detail.object_value,
          humanizeValue(detail.object_value),
        );
      } catch (error) {
        state.street.error = error?.message || 'Feature detail unavailable';
        state.street.loading = false;
        notify();
      }
    },
  };

  /** Run low-priority work when the browser is idle (or soon, headless). */
  function scheduleIdle(task) {
    if (typeof globalThis.requestIdleCallback === 'function')
      globalThis.requestIdleCallback(() => task(), { timeout: 1500 });
    else setTimeout(task, 200);
  }

  let notifyQueued = false;
  function notify() {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      const snapshot = getUIState();
      for (const listener of [...state.listeners]) {
        try {
          listener(snapshot);
        } catch (error) {
          console.warn('[Data:Mapillary] listener error:', error);
        }
      }
    });
  }
  state.notify = notify;

  async function refreshStatus() {
    try {
      state.status = await source.getStatus();
      state.statusError = null;
      state.keyRequired = state.status?.configured !== true;
    } catch (error) {
      state.statusError = error?.message || 'status unavailable';
      state.keyRequired = !source.hasToken();
    }
    notify();
  }

  /** Colour key for the coverage web, in the order the panel lists it. */
  function coverageLegend() {
    const years = Math.round(COVERAGE_RECENT_DAYS / 365);
    return [
      { key: 'recent', label: `Recent (≤${years} yr)`, color: COLORS.coverage },
      { key: 'older', label: 'Older', color: COLORS.coverageOld },
      { key: 'pano', label: '360°', color: COLORS.pano },
      { key: 'selected', label: 'Selected', color: COLORS.selected },
    ];
  }

  /** CC BY-SA attribution shown on the globe while the layer is on. */
  function presentCredit(viewer) {
    if (state.credit || !viewer?.creditDisplay) return;
    try {
      state.credit = new Cesium.Credit(MAPILLARY_CREDIT_HTML, true);
      viewer.creditDisplay.addStaticCredit(state.credit);
    } catch {
      state.credit = null;
    }
  }

  function hideCredit(viewer) {
    if (!state.credit) return;
    try {
      viewer?.creditDisplay?.removeStaticCredit?.(state.credit);
    } catch {
      /* credit display already torn down */
    }
    state.credit = null;
  }

  function getUIState() {
    return {
      enabled: state.enabled,
      keyRequired: state.keyRequired,
      planner: state.status?.planner === true,
      plannerModel: state.status?.plannerModel || null,
      coverage: {
        zoom: state.coverage.zoom,
        kind: state.coverage.kind,
        filter: { ...state.coverage.filter },
        legend: coverageLegend(),
        loading: state.coverage.loading > 0,
        sequences: parts.coverage.sequenceCount(),
        hint: state.coverage.hint,
        error: state.coverage.lastError,
      },
      sequence: {
        selectedId: state.sequence.selectedId,
        images: state.sequence.images.length,
        loading: state.sequence.loading,
      },
      features: {
        total: state.features.total,
        title: state.features.title,
        loading: state.features.loading,
        progress: { ...state.features.progress },
        counts: groupCountsByLabel(state.features.counts.entries()),
        truncated: state.features.truncated,
        failed: state.features.failed,
        iconMode: state.features.iconMode,
        hasBbox: Boolean(state.features.bbox),
        selectedId: state.features.selectedId,
        bbox: state.features.bbox ? [...state.features.bbox] : null,
      },
      street: {
        open: state.street.open,
        follow: state.street.follow,
        loading: state.street.loading,
        error: state.street.error,
        imageId: state.street.imageId,
        position: state.street.position ? { ...state.street.position } : null,
        bearing: state.street.bearing,
        isPano: state.street.isPano,
        capturedAt: state.street.capturedAt,
        sequenceId: state.street.sequenceId,
        creator: state.street.creator || null,
        renderMode: state.street.renderMode,
        feature: state.street.feature ? { ...state.street.feature } : null,
        highlight: state.street.highlight
          ? { ...state.street.highlight }
          : null,
      },
      query: {
        busy: state.query.busy,
        stage: state.query.stage,
        prompt: state.query.prompt,
        place: state.query.place,
        answer: state.query.answer,
        error: state.query.error,
        title: state.query.title || '',
        usage: state.query.usage,
        history: state.query.history.map(({ prompt, total }) => ({
          prompt,
          total,
        })),
      },
    };
  }

  const layer = {
    id: MAPILLARY_LAYER_ID,
    name: 'Street Level',
    icon: '📷',
    source: 'Mapillary',
    updateInterval: 0,
    statsRefreshInterval: 1000,
    requiresKeyId: MAPILLARY_KEY_ID,

    init(viewer) {
      if (state.initialized)
        throw new Error('Mapillary layer is already initialized');
      state.viewer = viewer;
      state.initialized = true;
      parts.sequences.ensureCollections(viewer);
      parts.features.ensureCollections(viewer);
      parts.sequences.setVisible(false);
      parts.features.setVisible(false);
      refreshStatus();
      console.log('[Data:Mapillary] Initialized');
    },

    enable(viewer) {
      state.enabled = true;
      presentCredit(viewer);
      parts.sequences.setVisible(true);
      parts.features.setVisible(true);
      parts.selection.install(viewer);
      parts.coverage.attach(viewer);
      if (!state.status) refreshStatus();
      scheduleIdle(() => parts.viewer.prewarm());
      notify();
    },

    disable() {
      state.enabled = false;
      hideCredit(state.viewer);
      parts.query.abort();
      parts.features.clearSelection();
      parts.coverage.setResting(false);
      parts.coverage.detach();
      parts.coverage.clear();
      parts.sequences.clearSelection();
      parts.selection.uninstall();
      parts.viewer.destroy();
      parts.sequences.setVisible(false);
      parts.features.setVisible(false);
      notify();
    },

    async update() {
      return state.enabled;
    },

    destroy(viewer = state.viewer) {
      layer.disable();
      parts.features.destroy(viewer);
      parts.sequences.destroy(viewer);
      state.listeners.clear();
      state.viewer = null;
      state.initialized = false;
      state.destroyed = true;
    },

    getStats() {
      const loading =
        state.coverage.loading > 0 ||
        state.features.loading ||
        state.query.busy;
      let loadingLabel = '';
      if (state.keyRequired) loadingLabel = 'KEY REQUIRED';
      else if (state.query.busy) loadingLabel = `AI · ${state.query.stage}`;
      else if (state.features.loading)
        loadingLabel = `tiles ${state.features.progress.done}/${state.features.progress.tiles}`;
      else if (state.coverage.loading > 0) loadingLabel = 'loading coverage...';
      else if (state.features.total)
        loadingLabel = `${state.features.total.toLocaleString()} features`;
      else if (state.coverage.hint && state.enabled)
        loadingLabel = state.coverage.hint;
      return {
        count: state.features.total || parts.coverage.sequenceCount(),
        sequences: parts.coverage.sequenceCount(),
        features: state.features.total,
        loading,
        keyRequired: state.keyRequired,
        error: state.keyRequired
          ? 'KEY REQUIRED'
          : state.coverage.lastError || state.query.error,
        loadingLabel,
      };
    },

    // ── Public surface used by the panel and the voice/analyst seams ─────
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    getUIState,
    /** The DOM element the MapillaryJS viewer renders into. */
    attachViewerHost(element) {
      state.street.host = element || null;
      if (element && state.street.open) parts.viewer.resize();
      if (element && state.enabled)
        scheduleIdle(() => parts.viewer.prewarm(element));
    },
    runQuery: (prompt) => parts.query.run(prompt),
    /** Stop a running query (planning, geocoding or streaming). */
    abortQuery: () => parts.query.abort(),
    /** Imagery filter for coverage, cones and nearest-image lookups. */
    setCoverageFilter(next) {
      parts.coverage.setFilter(next);
      parts.sequences.rerender();
    },
    getCoverageFilter: () => ({ ...state.coverage.filter }),
    selectFeature: (id) => parts.features.select(id),
    clearFeatureSelection: () => parts.features.clearSelection(),
    /** Execute a ready-made plan (voice agent, tests) without the planner. */
    runPlan: (plan, options) => parts.query.runPlan(plan, options),
    clearQuery: () => parts.query.clear(),
    frameResults: () => parts.features.frame(),
    openImage: (imageId) => parts.street.openImage(imageId),
    openFeature: (featureId) => parts.street.openFeature(featureId),
    async openNearest(point) {
      const view = point || parts.query.viewContext();
      if (!Number.isFinite(view?.lat) || !Number.isFinite(view?.lon))
        return false;
      state.street.loading = true;
      state.street.error = null;
      notify();
      try {
        const images = await source.nearestImages({
          lat: view.lat,
          lon: view.lon,
          radius: 50,
          limit: 5,
        });
        if (!images.length)
          throw new Error(
            'No Mapillary imagery within 50 m of the view centre',
          );
        await parts.street.openImage(images[0].id);
        return true;
      } catch (error) {
        state.street.error = error?.message || 'Nearest image unavailable';
        state.street.loading = false;
        notify();
        return false;
      }
    },
    /**
     * Close the image and deselect it everywhere on the map: position
     * marker, highlighted sequence and its cones, result ring and outline.
     */
    closeViewer() {
      parts.viewer.close();
      parts.features.clearSelection();
      parts.sequences.clearSelection();
    },
    setViewerRenderMode: (mode) => parts.viewer.setRenderMode(mode),
    setFollow: (enabled) => parts.viewer.setFollow(enabled),
    lookAtImage: () => parts.viewer.lookAtPosition(),
    resizeViewer: () => parts.viewer.resize(),
    selectSequence: (id) => parts.sequences.select(id),
    clearSequence: () => parts.sequences.clearSelection(),
    refreshCoverage: () => parts.coverage.refresh(),

    /** Result rows for the analyst query engine: plain JSON-safe objects. */
    getAnalystRecords(maxCount = 2000) {
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return state.features.rows
        .slice(0, limit)
        .map(([lon, lat, id, value, first, last]) => ({
          id,
          type: 'mapillary-feature',
          value,
          label: humanizeValue(value),
          lat,
          lon,
          firstSeen: first ? new Date(first).toISOString() : null,
          lastSeen: last ? new Date(last).toISOString() : null,
        }));
    },
  };
  return layer;
}
