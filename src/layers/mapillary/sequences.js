import * as Cesium from 'cesium';
import { imageConeGlyph } from './glyphs.js';
import { passesImageryFilter } from './coverage.js';
import {
  COLORS,
  IMAGE_CONE_MIN_SPACING_M,
  IMAGE_CONE_SIZE_PX,
  PICK_PREFIX,
} from './policy.js';

/** How many recently viewed sequences keep their image list in memory. */
const SEQUENCE_CACHE_SIZE = 40;

/** Approximate metres between two lon/lat points (small distances). */
function metresBetween(a, b) {
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lon - a.lon) * 111_320 * Math.cos(lat);
  const dy = (b.lat - a.lat) * 110_540;
  return Math.hypot(dx, dy);
}

/** Normalize a graph image record into the shape the cones use. */
function normalizeSequenceImage(record) {
  const coordinates = record?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  return {
    id: String(record.id),
    lon: Number(coordinates[0]),
    lat: Number(coordinates[1]),
    compassAngle: Number(record.compass_angle) || 0,
    capturedAt: Number(record.captured_at) || 0,
    isPano: record.is_pano === true,
    altitude: Number.isFinite(record.computed_altitude)
      ? record.computed_altitude
      : null,
  };
}

/** Drop images closer than the spacing to the previous kept one. */
function thinImages(images, spacingM = IMAGE_CONE_MIN_SPACING_M) {
  const kept = [];
  let last = null;
  for (const image of images) {
    if (!last || metresBetween(last, image) >= spacingM) {
      kept.push(image);
      last = image;
    }
  }
  return kept;
}

/** Image cones for one selected sequence, plus the viewer position marker. */
export function createSequences({ state, source, parts }) {
  const { render, sprites } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('mapillary-sequence');
  }

  function ensureCollections(viewer) {
    if (!state.sequence.collection) {
      state.sequence.collection = new Cesium.BillboardCollection({
        scene: viewer.scene,
      });
      viewer.scene.primitives.add(state.sequence.collection);
      sprites?.registerSpriteCollection?.(
        'mapillary',
        state.sequence.collection,
      );
    }
    if (!state.street.markerCollection) {
      state.street.markerCollection = new Cesium.BillboardCollection({
        scene: viewer.scene,
      });
      viewer.scene.primitives.add(state.street.markerCollection);
      sprites?.registerSpriteCollection?.(
        'mapillary',
        state.street.markerCollection,
      );
    }
  }

  function clearCones() {
    state.sequence.collection?.removeAll();
    state.sequence.images = [];
  }

  function renderCones(images) {
    const collection = state.sequence.collection;
    if (!collection) return;
    collection.removeAll();
    const cone = imageConeGlyph({ size: 32, color: COLORS.image });
    const ring = imageConeGlyph({ size: 32, color: COLORS.pano, pano: true });
    for (const image of images) {
      if (!passesImageryFilter(image, state.coverage.filter)) continue;
      collection.add({
        id: `${PICK_PREFIX.image}${image.id}`,
        position: Cesium.Cartesian3.fromDegrees(image.lon, image.lat),
        image: image.isPano ? ring : cone,
        imageId: image.isPano ? 'mly-cone-pano' : 'mly-cone',
        width: IMAGE_CONE_SIZE_PX,
        height: IMAGE_CONE_SIZE_PX,
        rotation: -Cesium.Math.toRadians(image.compassAngle),
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        scaleByDistance: new Cesium.NearFarScalar(200, 1.1, 6000, 0.35),
      });
    }
    requestRender();
  }

  function remember(sequenceId, images) {
    const { cache } = state.sequence;
    cache.delete(sequenceId);
    cache.set(sequenceId, images);
    while (cache.size > SEQUENCE_CACHE_SIZE)
      cache.delete(cache.keys().next().value);
  }

  /** Select a sequence: highlight its line and load its image cones. */
  async function select(sequenceId) {
    if (!sequenceId || !state.viewer) return;
    if (
      state.sequence.selectedId === sequenceId &&
      state.sequence.images.length
    )
      return;
    if (state.sequence.selectedId && state.sequence.selectedId !== sequenceId)
      parts.coverage.recolorSequence(state.sequence.selectedId, false);
    state.sequence.abort?.abort();
    state.sequence.selectedId = sequenceId;
    parts.coverage.recolorSequence(sequenceId, true);
    const cached = state.sequence.cache.get(sequenceId);
    if (cached) {
      state.sequence.abort = null;
      state.sequence.loading = false;
      state.sequence.images = cached;
      renderCones(cached);
      state.notify?.();
      return;
    }
    const controller = new AbortController();
    state.sequence.abort = controller;
    state.sequence.loading = true;
    state.notify?.();
    try {
      const records = await source.getSequenceImages(sequenceId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const images = thinImages(
        records
          .map(normalizeSequenceImage)
          .filter(Boolean)
          .sort((a, b) => a.capturedAt - b.capturedAt),
      );
      remember(sequenceId, images);
      state.sequence.images = images;
      renderCones(images);
    } catch (error) {
      if (!controller.signal.aborted)
        state.street.error = error?.message || 'Sequence images unavailable';
    } finally {
      if (state.sequence.abort === controller) {
        state.sequence.loading = false;
        state.sequence.abort = null;
      }
      state.notify?.();
    }
  }

  function clearSelection() {
    state.sequence.abort?.abort();
    state.sequence.abort = null;
    if (state.sequence.selectedId)
      parts.coverage.recolorSequence(state.sequence.selectedId, false);
    state.sequence.selectedId = null;
    state.sequence.loading = false;
    clearCones();
    requestRender();
    state.notify?.();
  }

  /** Move (or create) the viewer position marker. */
  function setMarker(position, bearing) {
    const collection = state.street.markerCollection;
    if (!collection) return;
    if (!position) {
      collection.removeAll();
      state.street.marker = null;
      requestRender();
      return;
    }
    const cartesian = Cesium.Cartesian3.fromDegrees(position.lon, position.lat);
    if (!state.street.marker) {
      state.street.marker = collection.add({
        id: PICK_PREFIX.position,
        position: cartesian,
        image: (id) =>
          import('./glyphs.js').then((m) =>
            m.positionMarkerGlyph({ color: COLORS.position }),
          ),
        imageId: 'mly-position',
        width: 40,
        height: 40,
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
      });
    } else state.street.marker.position = cartesian;
    state.street.marker.rotation = -Cesium.Math.toRadians(bearing || 0);
    requestRender();
  }

  /** Re-draw the current sequence's cones (after an imagery filter change). */
  function rerender() {
    if (state.sequence.images.length) renderCones(state.sequence.images);
  }

  function hide(visible) {
    if (state.sequence.collection) state.sequence.collection.show = visible;
    if (state.street.markerCollection)
      state.street.markerCollection.show = visible;
    requestRender();
  }

  function destroy(viewer) {
    state.sequence.abort?.abort();
    for (const key of ['collection']) {
      const collection = state.sequence[key];
      if (collection) {
        sprites?.unregisterSpriteCollection?.('mapillary', collection);
        viewer?.scene?.primitives?.remove(collection);
        state.sequence[key] = null;
      }
    }
    if (state.street.markerCollection) {
      sprites?.unregisterSpriteCollection?.(
        'mapillary',
        state.street.markerCollection,
      );
      viewer?.scene?.primitives?.remove(state.street.markerCollection);
      state.street.markerCollection = null;
      state.street.marker = null;
    }
    state.sequence.images = [];
    state.sequence.selectedId = null;
  }

  return {
    ensureCollections,
    select,
    clearSelection,
    setMarker,
    rerender,
    setVisible: hide,
    destroy,
  };
}
