import * as Cesium from 'cesium';
import { decodeDetectionPolygons } from './decode.js';

/** Eye height above the sampled ground when the globe camera follows the viewer. */
const FOLLOW_EYE_HEIGHT_M = 2.4;

/**
 * Own the embedded MapillaryJS viewer: lazy-load the library, open images,
 * mirror its pose onto the globe, and optionally drive the Cesium camera
 * from it ("street cockpit").
 */
export function createViewerBridge({ state, source, parts }) {
  const { render } = state.services;
  let viewer = null;
  let Library = null;
  let pendingOpen = null;

  function requestRender() {
    render?.governorRequestRender?.('mapillary-viewer');
  }

  async function ensureLibrary() {
    if (Library) return Library;
    // The viewer stylesheet is vendored into src/ui/styles/mapillary-js.css.
    Library = await import('mapillary-js');
    return Library;
  }

  function groundHeightAt(lon, lat, fallback) {
    const scene = state.viewer?.scene;
    const carto = Cesium.Cartographic.fromDegrees(lon, lat);
    let height = null;
    try {
      if (scene?.sampleHeightSupported) height = scene.sampleHeight(carto);
    } catch {
      /* not sampleable yet */
    }
    if (!Number.isFinite(height)) height = scene?.globe?.getHeight?.(carto);
    if (!Number.isFinite(height)) height = fallback;
    return Number.isFinite(height) ? height : 0;
  }

  /** Put the Cesium camera where the street-level camera is. */
  function followCamera() {
    const { position, bearing, tilt } = state.street;
    if (!state.street.follow || !position || !state.viewer) return;
    const ground = groundHeightAt(
      position.lon,
      position.lat,
      state.street.altitude,
    );
    state.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        position.lon,
        position.lat,
        ground + FOLLOW_EYE_HEIGHT_M,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(bearing || 0),
        pitch: Cesium.Math.toRadians(Number.isFinite(tilt) ? tilt : 0),
        roll: 0,
      },
    });
    requestRender();
  }

  /** Frame the current image from a short distance behind it. */
  function lookAtPosition() {
    const { position, bearing } = state.street;
    if (!position || !state.viewer) return;
    const ground = groundHeightAt(
      position.lon,
      position.lat,
      state.street.altitude,
    );
    state.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(position.lon, position.lat, ground + 2),
        4,
      ),
      {
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(bearing || 0),
          Cesium.Math.toRadians(-32),
          140,
        ),
        duration: 1.6,
      },
    );
  }

  async function publishPose(image) {
    if (!viewer) return;
    try {
      const [lngLat, pov] = await Promise.all([
        viewer.getPosition(),
        viewer.getPointOfView(),
      ]);
      state.street.position = { lon: lngLat.lng, lat: lngLat.lat };
      state.street.bearing = pov?.bearing ?? state.street.bearing;
      state.street.tilt = pov?.tilt ?? 0;
      if (image) {
        state.street.imageId = image.id;
        state.street.isPano = image.merged
          ? image.cameraType === 'spherical'
          : image.cameraType === 'spherical';
        state.street.capturedAt = image.capturedAt ?? null;
        state.street.sequenceId = image.sequenceId ?? null;
        state.street.altitude = Number.isFinite(image.computedAltitude)
          ? image.computedAltitude
          : Number.isFinite(image.originalAltitude)
            ? image.originalAltitude
            : null;
        state.street.creator = image.creatorUsername || null;
      }
      parts.sequences.setMarker(state.street.position, state.street.bearing);
      followCamera();
      state.notify?.();
    } catch {
      /* viewer torn down mid-flight */
    }
  }

  async function ensureViewer(container) {
    if (viewer && state.street.container === container) return viewer;
    destroyViewer();
    const { Viewer } = await ensureLibrary();
    viewer = new Viewer({
      accessToken: source.token,
      container,
      component: {
        cover: false,
        bearing: true,
        zoom: true,
        attribution: true,
        tag: true,
      },
      trackResize: true,
    });
    state.street.container = container;
    viewer.on('image', (event) => publishPose(event.image));
    viewer.on('pov', () => publishPose(null));
    viewer.on('position', () => publishPose(null));
    return viewer;
  }

  /**
   * Open an image in the viewer inside `container`. Returns once the first
   * image has loaded; the pose then streams through `state.street`.
   */
  async function open(imageId, container, { frame = true } = {}) {
    if (!imageId || !container) return;
    const id = String(imageId);
    state.street.loading = true;
    state.street.error = null;
    state.street.open = true;
    state.notify?.();
    pendingOpen = id;
    try {
      const instance = await ensureViewer(container);
      if (pendingOpen !== id) return;
      const image = await instance.moveTo(id);
      if (pendingOpen !== id) return;
      await publishPose(image);
      if (frame && !state.street.follow) lookAtPosition();
    } catch (error) {
      if (pendingOpen === id)
        state.street.error = error?.message || 'Image could not be opened';
    } finally {
      if (pendingOpen === id) state.street.loading = false;
      state.notify?.();
    }
  }

  /**
   * Outline every detection of `value` inside the current image using the
   * MapillaryJS tag component. Detections are per image on the Graph API;
   * their geometry is a small vector tile in image-normalized coordinates.
   */
  async function highlightDetections(imageId, value, label) {
    if (!viewer || !imageId) return 0;
    const { OutlineTag, PolygonGeometry } = Library || {};
    let component;
    try {
      component = viewer.getComponent('tag');
      component.removeAll();
    } catch {
      return 0;
    }
    state.street.highlight = { value, count: 0, loading: true };
    state.notify?.();
    let detections = [];
    try {
      detections = await source.getImageDetections(imageId);
    } catch {
      detections = [];
    }
    if (pendingOpen !== String(imageId) || !viewer) return 0;
    const tags = [];
    for (const detection of detections) {
      if (value && detection.value !== value) continue;
      decodeDetectionPolygons(detection.geometry).forEach((polygon, index) => {
        try {
          tags.push(
            new OutlineTag(
              `mly-det-${detection.id}-${index}`,
              new PolygonGeometry(polygon),
              {
                lineColor: 0x00d4ff,
                lineWidth: 3,
                fillColor: 0x00d4ff,
                fillOpacity: 0.22,
                text: tags.length === 0 ? label || undefined : undefined,
                textColor: 0xffffff,
              },
            ),
          );
        } catch {
          /* degenerate polygon */
        }
      });
    }
    if (tags.length) component.add(tags);
    state.street.highlight = { value, count: tags.length, loading: false };
    state.notify?.();
    return tags.length;
  }

  function setFollow(enabled) {
    state.street.follow = enabled === true;
    if (state.street.follow) followCamera();
    state.notify?.();
  }

  function resize() {
    try {
      viewer?.resize();
    } catch {
      /* no-op */
    }
  }

  function destroyViewer() {
    if (viewer) {
      try {
        viewer.remove();
      } catch {
        /* already removed */
      }
    }
    viewer = null;
    state.street.container = null;
  }

  function close() {
    pendingOpen = null;
    destroyViewer();
    Object.assign(state.street, {
      open: false,
      follow: false,
      imageId: null,
      position: null,
      bearing: null,
      tilt: null,
      loading: false,
      error: null,
      highlight: null,
    });
    parts.sequences.setMarker(null);
    state.notify?.();
  }

  return {
    open,
    close,
    setFollow,
    resize,
    lookAtPosition,
    highlightDetections,
    destroy: close,
  };
}
