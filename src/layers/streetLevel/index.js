import { createState } from './state.js';
import { createCoverage, visibleBbox } from './providers/mapillary/coverage.js';
import { createSequences } from './providers/mapillary/sequences.js';
import { createViewerBridge } from './providers/mapillary/viewer.js';
import { createSelection } from './selection.js';
import * as Cesium from 'cesium';
import {
  COLORS,
  COVERAGE_RECENT_DAYS,
  MAPILLARY_CREDIT_HTML,
  MAPILLARY_KEY_ID,
  STREET_LEVEL_LAYER_ID,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
} from './providers/mapillary/policy.js';

export { STREET_LEVEL_LAYER_ID } from './providers/mapillary/policy.js';

const SOURCE_METHODS = [
  'getStatus',
  'getTile',
  'getImage',
  'getSequenceImages',
  'nearestImages',
];

/**
 * Construct the Mapillary street-level layer: camera-driven coverage,
 * per-sequence image cones and the embedded viewer. Application services
 * are injected; nothing here reads the DOM except the viewer host the UI
 * hands over.
 */
export function createStreetLevelLayer({ source, services = {} }) {
  if (!SOURCE_METHODS.every((method) => typeof source?.[method] === 'function'))
    throw new TypeError('A Mapillary source is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, source, parts };
  parts.coverage = createCoverage(context);
  parts.sequences = createSequences(context);
  parts.viewer = createViewerBridge(context);
  parts.selection = createSelection(context);

  // Street-level actions shared by clicks and the UI.
  parts.street = {
    async openImage(imageId) {
      const host = state.street.host;
      if (!host) {
        state.street.error = 'Open the Street Level panel to view imagery';
        notify();
        return;
      }
      await parts.viewer.open(imageId, host);
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
          console.warn('[Data:StreetLevel] listener error:', error);
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

  /** Centre of the visible ground, or the camera's own footprint. */
  function viewCentre() {
    const viewer = state.viewer;
    if (!viewer) return null;
    const bbox = visibleBbox(viewer);
    if (bbox)
      return { lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 };
    const carto = viewer.camera.positionCartographic;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  function getUIState() {
    return {
      enabled: state.enabled,
      keyRequired: state.keyRequired,
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
      },
    };
  }

  const layer = {
    id: STREET_LEVEL_LAYER_ID,
    name: 'Street Level',
    icon: '📷',
    source: 'Mapillary',
    updateInterval: 0,
    statsRefreshInterval: 1000,
    requiresKeyId: MAPILLARY_KEY_ID,

    init(viewer) {
      if (state.initialized)
        throw new Error('Street Level layer is already initialized');
      state.viewer = viewer;
      state.initialized = true;
      parts.sequences.ensureCollections(viewer);
      parts.sequences.setVisible(false);
      refreshStatus();
      console.log('[Data:StreetLevel] Initialized');
    },

    enable(viewer) {
      state.enabled = true;
      presentCredit(viewer);
      parts.sequences.setVisible(true);
      parts.selection.install(viewer);
      parts.coverage.attach(viewer);
      if (!state.status) refreshStatus();
      scheduleIdle(() => parts.viewer.prewarm());
      notify();
    },

    disable() {
      state.enabled = false;
      hideCredit(state.viewer);
      parts.coverage.detach();
      parts.coverage.clear();
      parts.sequences.clearSelection();
      parts.selection.uninstall();
      parts.viewer.destroy();
      parts.sequences.setVisible(false);
      notify();
    },

    async update() {
      return state.enabled;
    },

    destroy(viewer = state.viewer) {
      layer.disable();
      parts.sequences.destroy(viewer);
      state.listeners.clear();
      state.viewer = null;
      state.initialized = false;
      state.destroyed = true;
    },

    getStats() {
      let loadingLabel = '';
      if (state.keyRequired) loadingLabel = 'KEY REQUIRED';
      else if (state.coverage.loading > 0) loadingLabel = 'loading coverage...';
      else if (state.coverage.hint && state.enabled)
        loadingLabel = state.coverage.hint;
      return {
        count: parts.coverage.sequenceCount(),
        sequences: parts.coverage.sequenceCount(),
        loading: state.coverage.loading > 0,
        keyRequired: state.keyRequired,
        error: state.keyRequired ? 'KEY REQUIRED' : state.coverage.lastError,
        loadingLabel,
      };
    },

    // ── Public surface used by the panel ────────────────────────────────
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
    /** Imagery filter for coverage, cones and nearest-image lookups. */
    setCoverageFilter(next) {
      parts.coverage.setFilter(next);
      parts.sequences.rerender();
    },
    getCoverageFilter: () => ({ ...state.coverage.filter }),
    openImage: (imageId) => parts.street.openImage(imageId),
    async openNearest(point) {
      const view = point || viewCentre();
      if (!Number.isFinite(view?.lat) || !Number.isFinite(view?.lon))
        return false;
      state.street.loading = true;
      state.street.error = null;
      notify();
      try {
        const images = await source.nearestImages({
          lat: view.lat,
          lon: view.lon,
          radius: NEAREST_RADIUS_M,
          limit: NEAREST_LIMIT,
        });
        if (!images.length)
          throw new Error(
            `No Mapillary imagery within ${NEAREST_RADIUS_M} m of the view centre`,
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
     * marker, highlighted sequence and its cones.
     */
    closeViewer() {
      parts.viewer.close();
      parts.sequences.clearSelection();
    },
    setViewerRenderMode: (mode) => parts.viewer.setRenderMode(mode),
    setFollow: (enabled) => parts.viewer.setFollow(enabled),
    lookAtImage: () => parts.viewer.lookAtPosition(),
    resizeViewer: () => parts.viewer.resize(),
    selectSequence: (id) => parts.sequences.select(id),
    clearSequence: () => parts.sequences.clearSelection(),
    refreshCoverage: () => parts.coverage.refresh(),
  };
  return layer;
}
