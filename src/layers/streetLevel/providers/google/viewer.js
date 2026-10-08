import {
  GOOGLE_PROVIDER_ID,
  KEY_REJECTED_MESSAGE,
  creatorFrom,
  imageDateMs,
  streetViewUrl,
} from './policy.js';

/** An open that sees no panorama by then has failed. */
const OPEN_TIMEOUT_MS = 20_000;

/** Google's own controls, minus those the Street Level panel already has. */
const PANORAMA_OPTIONS = Object.freeze({
  visible: false,
  // The address goes in the panel caption: Google's card covers half a
  // docked panorama.
  addressControl: false,
  linksControl: true,
  panControl: true,
  zoomControl: true,
  clickToGo: true,
  showRoadLabels: true,
  // The panel has EXPAND and ×; Google's fullscreen would leave the modal.
  fullscreenControl: false,
  enableCloseButton: false,
  motionTracking: false,
  motionTrackingControl: false,
});

/**
 * Viewer adapter over Google's StreetViewPanorama. It renders in its own
 * element inside the core's host, and emits a provider-neutral pose for every
 * panorama and view change, including steps along Google's own arrows.
 * @param {{loader: ReturnType<import('./mapsLoader.js').createMapsLoader>, render?: object}} options
 * @returns {import('../../registry.js').ViewerAdapter}
 */
export function createGoogleViewer({ loader, render } = {}) {
  let library = null;
  let panorama = null;
  let element = null;
  let host = null;
  let service = null;
  let pendingOpen = null;
  /** Bumped by `unmount`, so a construction it overtook builds nothing. */
  let generation = 0;
  let subscriptions = [];
  /** Panorama id → its {capturedAt, creator} lookup. */
  const metadata = new Map();
  const listeners = new Set();

  function requestRender() {
    render?.governorRequestRender?.('google-street-view');
  }

  async function ensureLibrary() {
    library ||= await loader.importLibrary('streetView');
    return library;
  }

  function emit(pose) {
    for (const listener of [...listeners]) {
      try {
        listener(pose);
      } catch {
        /* listener errors are the core's to log */
      }
    }
  }

  /**
   * Date and photographer of a panorama, looked up once: pano_changed and
   * position_changed arrive together, so the lookup itself is shared.
   */
  function describe(panoId) {
    if (!metadata.has(panoId)) metadata.set(panoId, lookUp(panoId));
    return metadata.get(panoId);
  }

  async function lookUp(panoId) {
    try {
      service ||= new library.StreetViewService();
      const { data } = await service.getPanorama({ pano: panoId });
      return {
        capturedAt: imageDateMs(data?.imageDate),
        creator: creatorFrom(data?.copyright),
        title: data?.location?.description || null,
      };
    } catch {
      // The pose still goes out, without a date.
      return { capturedAt: null, creator: null, title: null };
    }
  }

  async function publishPose() {
    const shown = panorama;
    const panoId = shown?.getPano?.();
    const position = shown?.getPosition?.();
    if (!panoId || !position || pendingOpen === null) return;
    const meta = await describe(panoId);
    // Closed, unmounted or moved on while the date was looked up.
    if (pendingOpen === null || shown !== panorama) return;
    if (panorama.getPano() !== panoId) return;
    const pov = panorama.getPov() || {};
    const latLng = panorama.getPosition() || position;
    emit({
      providerId: GOOGLE_PROVIDER_ID,
      imageId: panoId,
      position: { lon: latLng.lng(), lat: latLng.lat() },
      bearing: Number.isFinite(pov.heading) ? pov.heading : null,
      tilt: Number.isFinite(pov.pitch) ? pov.pitch : 0,
      altitude: null,
      isPano: true,
      capturedAt: meta.capturedAt,
      capturedAtPrecision: 'month',
      creator: meta.creator,
      title: meta.title,
      sequenceId: null,
      externalUrl: streetViewUrl(panoId, {
        heading: pov.heading || 0,
        pitch: pov.pitch || 0,
      }),
    });
    requestRender();
  }

  async function ensurePanorama(target) {
    if (panorama && host === target) return panorama;
    const built = generation;
    const { StreetViewPanorama } = await ensureLibrary();
    if (built !== generation) throw new Error('Street View was unmounted');
    if (panorama && host === target) return panorama;
    destroyPanorama();
    element = target.ownerDocument.createElement('div');
    element.className = 'sl-google-panorama';
    element.style.cssText = 'position:absolute;inset:0;';
    target.append(element);
    host = target;
    panorama = new StreetViewPanorama(element, PANORAMA_OPTIONS);
    subscriptions = ['pano_changed', 'position_changed', 'pov_changed'].map(
      (name) => panorama.addListener(name, () => publishPose()),
    );
    return panorama;
  }

  function destroyPanorama() {
    for (const subscription of subscriptions) subscription.remove();
    subscriptions = [];
    try {
      panorama?.setVisible(false);
    } catch {
      /* already gone */
    }
    element?.remove();
    panorama = null;
    element = null;
    host = null;
  }

  /**
   * Resolves once `panoId` shows; rejects when Google has no imagery for it,
   * or refuses the key (which it reports apart from the panorama's status).
   */
  function shown(instance, panoId) {
    if (instance.getPano() === panoId && instance.getStatus() === 'OK')
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        done();
        reject(new Error('Street View did not answer'));
      }, OPEN_TIMEOUT_MS);
      const stopAuthWatch = loader.onAuthFailure(() => {
        done();
        reject(new Error(KEY_REJECTED_MESSAGE));
      });
      const subscription = instance.addListener('status_changed', () => {
        if (pendingOpen !== panoId) {
          done();
          resolve();
          return;
        }
        // Google may answer with a newer id for the same place: any OK counts.
        const status = instance.getStatus();
        if (status === 'OK') {
          done();
          resolve();
        } else if (status && status !== 'OK') {
          done();
          reject(new Error('Street View has no imagery for this place'));
        }
      });
      function done() {
        clearTimeout(timer);
        subscription.remove();
        stopAuthWatch();
      }
    });
  }

  return {
    async mount(target) {
      if (!target) throw new Error('Street Level viewer has no host element');
      await ensurePanorama(target);
    },

    /** Resolves once the panorama is on screen and its first pose was emitted. */
    async open(imageId) {
      const panoId = String(imageId);
      if (!host) throw new Error('Street View is not mounted');
      if (loader.authFailed()) throw new Error(KEY_REJECTED_MESSAGE);
      pendingOpen = panoId;
      const instance = await ensurePanorama(host);
      if (pendingOpen !== panoId) return;
      const ready = shown(instance, panoId);
      instance.setPano(panoId);
      instance.setVisible(true);
      await ready;
      if (pendingOpen !== panoId) return;
      await publishPose();
    },

    close() {
      pendingOpen = null;
      try {
        panorama?.setVisible(false);
      } catch {
        /* torn down */
      }
    },

    unmount() {
      pendingOpen = null;
      generation++;
      destroyPanorama();
    },

    resize() {
      if (!panorama) return;
      try {
        globalThis.google?.maps?.event?.trigger(panorama, 'resize');
      } catch {
        /* no-op */
      }
    },

    /** Load the library ahead of the first panorama; a panorama is billed, so none is built. */
    async prewarm() {
      try {
        await ensureLibrary();
      } catch {
        /* the real open reports errors */
      }
    },

    onPose(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
