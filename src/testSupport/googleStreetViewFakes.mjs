/**
 * Stand-ins for the Google Maps JavaScript API's Street View library and the
 * loader that hands it out. Panoramas are {id: {lat, lng, imageDate, copyright}};
 * `nearest(location, radius)` answers location lookups with an id or null.
 */

function latLng(lat, lng) {
  return { lat: () => lat, lng: () => lng };
}

export function fakeStreetViewLibrary({
  panoramas = {},
  nearest = () => null,
} = {}) {
  const built = [];
  const lookups = [];

  class StreetViewPanorama {
    constructor(element, options) {
      this.element = element;
      this.options = options;
      this.visible = options?.visible ?? true;
      this.pano = null;
      this.status = null;
      this.pov = { heading: 0, pitch: 0 };
      this.listeners = new Map();
      built.push(this);
    }

    addListener(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(listener);
      return { remove: () => this.listeners.get(name)?.delete(listener) };
    }

    fire(name) {
      for (const listener of [...(this.listeners.get(name) || [])]) listener();
    }

    listenerCount() {
      let count = 0;
      for (const set of this.listeners.values()) count += set.size;
      return count;
    }

    /** Like Google: the panorama loads asynchronously, then reports. */
    setPano(id) {
      this.pano = id;
      queueMicrotask(() => {
        if (this.pano !== id) return;
        const known = panoramas[id];
        this.status = known ? 'OK' : 'ZERO_RESULTS';
        if (known) {
          this.fire('pano_changed');
          this.fire('position_changed');
        }
        this.fire('status_changed');
      });
    }

    getPano() {
      return this.pano;
    }

    getStatus() {
      return this.status;
    }

    getPosition() {
      const known = panoramas[this.pano];
      return known ? latLng(known.lat, known.lng) : null;
    }

    getPov() {
      return { ...this.pov };
    }

    /** The user drags the view. */
    setPov(pov) {
      this.pov = { ...pov };
      this.fire('pov_changed');
    }

    setVisible(visible) {
      this.visible = visible;
    }
  }

  class StreetViewService {
    async getPanorama(request) {
      lookups.push(request);
      const id = request.pano ?? nearest(request.location, request.radius);
      const known = id && panoramas[id];
      if (!known)
        throw Object.assign(new Error('ZERO_RESULTS'), {
          code: 'ZERO_RESULTS',
        });
      return {
        data: {
          location: {
            pano: id,
            latLng: latLng(known.lat, known.lng),
            description: known.description,
          },
          imageDate: known.imageDate,
          copyright: known.copyright,
        },
      };
    }
  }

  return {
    library: {
      StreetViewPanorama,
      StreetViewService,
      StreetViewSource: { GOOGLE: 'google', OUTDOOR: 'outdoor' },
      StreetViewPreference: { NEAREST: 'nearest', BEST: 'best' },
    },
    built,
    lookups,
  };
}

/** A loader over `library`; `refuseKey()` plays Google's gm_authFailure. */
export function fakeMapsLoader(library) {
  let failed = false;
  const listeners = new Set();
  const imports = [];
  return {
    imports,
    async importLibrary(name) {
      imports.push(name);
      return library;
    },
    authFailed: () => failed,
    onAuthFailure(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refuseKey() {
      failed = true;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

/** A host element with just what the viewer adapter touches. */
export function fakeHost() {
  const children = [];
  const host = {
    children,
    ownerDocument: {
      createElement: () => {
        const element = {
          style: {},
          className: '',
          remove() {
            const index = children.indexOf(element);
            if (index !== -1) children.splice(index, 1);
          },
        };
        return element;
      },
    },
    append: (element) => children.push(element),
  };
  return host;
}
