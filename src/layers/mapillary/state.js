/** Mutable per-layer state, created once per layer instance. */
export function createState({ services }) {
  return {
    services,
    viewer: null,
    enabled: false,
    initialized: false,
    destroyed: false,
    status: null,
    statusError: null,
    keyRequired: false,
    listeners: new Set(),
    notifyScheduled: false,

    coverage: {
      zoom: null,
      /** @type {Map<string, {primitive: object|null, sequences: Map<string, object>, count: number}>} */
      tiles: new Map(),
      /** Tiles from the previous zoom, kept on screen until replacements land. */
      stale: new Map(),
      staleTimer: null,
      pending: new Map(),
      generation: 0,
      loading: 0,
      lastError: null,
      debounceTimer: null,
      removeCameraListener: null,
      terrainReady: null,
      hint: '',
      resting: false,
      kind: null,
      filter: { pano: 'all', sinceMs: null },
    },

    sequence: {
      selectedId: null,
      images: [],
      /** @type {Map<string, Array<object>>} recent sequences' thinned images */
      cache: new Map(),
      collection: null,
      loading: false,
      abort: null,
    },

    features: {
      collection: null,
      points: null,
      rows: [],
      byId: new Map(),
      counts: new Map(),
      earliest: null,
      latest: null,
      bbox: null,
      title: '',
      layer: null,
      values: [],
      total: 0,
      truncated: false,
      failed: 0,
      loading: false,
      progress: { done: 0, tiles: 0 },
      abort: null,
      iconMode: false,
      iconsHidden: false,
      selectedId: null,
      billboardById: new Map(),
      highlight: null,
    },

    street: {
      bridge: null,
      container: null,
      open: false,
      follow: false,
      imageId: null,
      position: null,
      bearing: null,
      tilt: null,
      isPano: false,
      capturedAt: null,
      sequenceId: null,
      loading: false,
      error: null,
      marker: null,
      markerCollection: null,
      /** 'letterbox' shows the whole image; 'fill' crops it to the frame. */
      renderMode: 'letterbox',
    },

    objects3d: {
      enabled: false,
      active: false,
      building: false,
      count: 0,
      error: null,
      abort: null,
    },

    query: {
      busy: false,
      stage: 'idle',
      prompt: '',
      answer: '',
      error: null,
      lastPlan: null,
      history: [],
      abort: null,
      usage: null,
    },

    clickHandler: null,
  };
}
