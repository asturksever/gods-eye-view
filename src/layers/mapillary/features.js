import * as Cesium from 'cesium';
import { featureDotGlyph, rasterizeSprite } from './glyphs.js';
import {
  FEATURE_ICON_LIMIT,
  FEATURE_ICON_SIZE_PX,
  FEATURE_POINT_SIZE_PX,
  PICK_PREFIX,
} from './policy.js';
import { colorForValue } from './values.js';

/** Query-result rendering: fast points while streaming, icons once complete. */
export function createFeatures({ state, source }) {
  const { render, sprites } = state.services;
  /** @type {Map<string, Promise<HTMLCanvasElement>>} */
  const spriteImages = new Map();

  function requestRender() {
    render?.governorRequestRender?.('mapillary-features');
  }

  function ensureCollections(viewer) {
    if (!state.features.points) {
      state.features.points = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(state.features.points);
      sprites?.registerSpriteCollection?.('mapillary', state.features.points);
    }
    if (!state.features.collection) {
      state.features.collection = new Cesium.BillboardCollection({
        scene: viewer.scene,
      });
      viewer.scene.primitives.add(state.features.collection);
      sprites?.registerSpriteCollection?.(
        'mapillary',
        state.features.collection,
      );
    }
  }

  function groundPosition(lon, lat) {
    const carto = Cesium.Cartographic.fromDegrees(lon, lat);
    const height = state.viewer?.scene?.globe?.getHeight?.(carto);
    return Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      Number.isFinite(height) ? height + 1 : 1,
    );
  }

  const colorCache = new Map();
  function cesiumColor(value) {
    let color = colorCache.get(value);
    if (!color) {
      color = Cesium.Color.fromCssColorString(colorForValue(value));
      colorCache.set(value, color);
    }
    return color;
  }

  /** Sprite canvas for a value, cached; falls back to a coloured dot. */
  function spriteImage(value) {
    let pending = spriteImages.get(value);
    if (!pending) {
      pending = fetch(source.spriteUrl(value))
        .then((response) => {
          if (!response.ok) throw new Error(`sprite ${response.status}`);
          return response.text();
        })
        .then((svg) => rasterizeSprite(svg, { size: 60 }))
        .catch(() =>
          featureDotGlyph({ size: 60, color: colorForValue(value) }),
        );
      spriteImages.set(value, pending);
    }
    return pending;
  }

  /** Reset the result set and its primitives. */
  function reset() {
    state.features.points?.removeAll();
    state.features.collection?.removeAll();
    Object.assign(state.features, {
      rows: [],
      byId: new Map(),
      counts: new Map(),
      earliest: null,
      latest: null,
      total: 0,
      truncated: false,
      failed: 0,
      progress: { done: 0, tiles: 0 },
      iconMode: false,
    });
    requestRender();
  }

  /** Append streamed rows: [lon, lat, id, value, first, last]. */
  function appendRows(rows) {
    const points = state.features.points;
    if (!points) return;
    const features = state.features;
    for (const row of rows) {
      const [lon, lat, id, value, first, last] = row;
      if (features.byId.has(id)) continue;
      features.byId.set(id, row);
      features.rows.push(row);
      features.counts.set(value, (features.counts.get(value) || 0) + 1);
      if (first)
        features.earliest = features.earliest
          ? Math.min(features.earliest, first)
          : first;
      if (last)
        features.latest = features.latest
          ? Math.max(features.latest, last)
          : last;
      points.add({
        id: `${PICK_PREFIX.feature}${id}`,
        position: groundPosition(lon, lat),
        color: cesiumColor(value),
        outlineColor: Cesium.Color.fromBytes(255, 255, 255, 200),
        outlineWidth: 1.5,
        pixelSize: FEATURE_POINT_SIZE_PX,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(500, 1.2, 40_000, 0.5),
      });
    }
    features.total = features.rows.length;
    requestRender();
  }

  /**
   * Once a query completes with a modest result, swap the dots for the real
   * Mapillary icons. Icons keep the points hidden underneath so picking is
   * consistent.
   */
  async function upgradeToIcons() {
    const features = state.features;
    if (!features.collection || features.rows.length > FEATURE_ICON_LIMIT)
      return;
    const values = [...features.counts.keys()];
    const images = new Map(
      await Promise.all(
        values.map(async (value) => [value, await spriteImage(value)]),
      ),
    );
    if (features.loading || !state.viewer) return;
    features.collection.removeAll();
    for (const [lon, lat, id, value] of features.rows) {
      features.collection.add({
        id: `${PICK_PREFIX.feature}${id}`,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        image: images.get(value),
        imageId: `mly-sprite:${value}`,
        width: FEATURE_ICON_SIZE_PX,
        height: FEATURE_ICON_SIZE_PX,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        scaleByDistance: new Cesium.NearFarScalar(300, 1.1, 12_000, 0.4),
      });
    }
    features.points.show = false;
    features.iconMode = true;
    requestRender();
  }

  function setVisible(visible) {
    if (state.features.points)
      state.features.points.show = visible && !state.features.iconMode;
    if (state.features.collection) state.features.collection.show = visible;
    requestRender();
  }

  /** Fly the camera to frame the query bbox. */
  function frame(bbox = state.features.bbox, { duration = 2.2 } = {}) {
    if (!bbox || !state.viewer) return;
    const [west, south, east, north] = bbox;
    state.viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
      duration,
    });
  }

  function findRow(id) {
    return state.features.byId.get(id) || null;
  }

  function destroy(viewer) {
    for (const key of ['points', 'collection']) {
      const collection = state.features[key];
      if (collection) {
        sprites?.unregisterSpriteCollection?.('mapillary', collection);
        viewer?.scene?.primitives?.remove(collection);
        state.features[key] = null;
      }
    }
  }

  return {
    ensureCollections,
    reset,
    appendRows,
    upgradeToIcons,
    setVisible,
    frame,
    findRow,
    destroy,
  };
}
