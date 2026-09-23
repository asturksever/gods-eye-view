import * as Cesium from 'cesium';
import {
  featureDotGlyph,
  rasterizeSprite,
  selectionRingGlyph,
} from './glyphs.js';
import {
  COLORS,
  FEATURE_ICON_LIMIT,
  FEATURE_ICON_MAX,
  FEATURE_ICON_SIZE_PX,
  FEATURE_POINT_SIZE_PX,
  PICK_PREFIX,
} from './policy.js';
import { colorForValue } from './values.js';

/**
 * Query-result rendering: fast points while a query streams, Mapillary
 * sprite icons once it completes (clamped to the ground for modest sets,
 * height-sampled for city-sized ones), plus a selection ring.
 */
export function createFeatures({ state, source }) {
  const { render, sprites } = state.services;
  /** @type {Map<string, Promise<HTMLCanvasElement>>} */
  const spriteImages = new Map();

  function requestRender() {
    render?.governorRequestRender?.('mapillary-features');
  }

  function ensureCollections(viewer) {
    const scene = viewer.scene;
    if (!state.features.points) {
      state.features.points = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      scene.primitives.add(state.features.points);
      sprites?.registerSpriteCollection?.('mapillary', state.features.points);
    }
    if (!state.features.collection) {
      state.features.collection = new Cesium.BillboardCollection({ scene });
      scene.primitives.add(state.features.collection);
      sprites?.registerSpriteCollection?.(
        'mapillary',
        state.features.collection,
      );
    }
    if (!state.features.highlight) {
      state.features.highlight = new Cesium.BillboardCollection({ scene });
      scene.primitives.add(state.features.highlight);
      sprites?.registerSpriteCollection?.(
        'mapillary',
        state.features.highlight,
      );
    }
  }

  function groundPosition(lon, lat, lift = 1) {
    const carto = Cesium.Cartographic.fromDegrees(lon, lat);
    const height = state.viewer?.scene?.globe?.getHeight?.(carto);
    return Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      Number.isFinite(height) ? height + lift : lift,
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

  /** Raw sprite SVG text for a value (3D sign faces), or null. */
  async function spriteSvg(value) {
    try {
      const response = await fetch(source.spriteUrl(value));
      return response.ok ? await response.text() : null;
    } catch {
      return null;
    }
  }

  /** Reset the result set and its primitives. */
  function reset() {
    state.features.points?.removeAll();
    state.features.collection?.removeAll();
    state.features.highlight?.removeAll();
    Object.assign(state.features, {
      rows: [],
      byId: new Map(),
      billboardById: new Map(),
      counts: new Map(),
      earliest: null,
      latest: null,
      total: 0,
      truncated: false,
      failed: 0,
      progress: { done: 0, tiles: 0 },
      iconMode: false,
      selectedId: null,
      iconsHidden: false,
    });
    if (state.features.points) state.features.points.show = true;
    if (state.features.collection) state.features.collection.show = true;
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
   * Once a query completes, swap the dots for Mapillary icons. Sets up to
   * FEATURE_ICON_LIMIT clamp to terrain and 3D tiles; larger sets sit on the
   * sampled globe height (clamping tens of thousands of billboards stalls the
   * frame). Beyond FEATURE_ICON_MAX the points stay.
   */
  async function upgradeToIcons() {
    const features = state.features;
    if (!features.collection || features.rows.length > FEATURE_ICON_MAX) return;
    const values = [...features.counts.keys()];
    const images = new Map(
      await Promise.all(
        values.map(async (value) => [value, await spriteImage(value)]),
      ),
    );
    if (features.loading || !state.viewer) return;
    const clamp = features.rows.length <= FEATURE_ICON_LIMIT;
    features.collection.removeAll();
    features.billboardById = new Map();
    for (const [lon, lat, id, value] of features.rows) {
      const billboard = features.collection.add({
        id: `${PICK_PREFIX.feature}${id}`,
        position: clamp
          ? Cesium.Cartesian3.fromDegrees(lon, lat)
          : groundPosition(lon, lat, 0.5),
        image: images.get(value),
        imageId: `mly-sprite:${value}`,
        width: FEATURE_ICON_SIZE_PX,
        height: FEATURE_ICON_SIZE_PX,
        ...(clamp
          ? { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }
          : {}),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        scaleByDistance: new Cesium.NearFarScalar(300, 1.1, 20_000, 0.35),
      });
      features.billboardById.set(id, billboard);
    }
    features.points.show = false;
    features.collection.show = !features.iconsHidden;
    features.iconMode = true;
    if (features.selectedId) select(features.selectedId);
    requestRender();
  }

  /** Highlight one result: scale its icon and draw a ring behind it. */
  function select(id) {
    const features = state.features;
    clearSelection({ keepId: true });
    const row = features.byId.get(id);
    if (!row) {
      features.selectedId = null;
      return null;
    }
    features.selectedId = id;
    const billboard = features.billboardById?.get(id);
    if (billboard) billboard.scale = 1.45;
    const [lon, lat] = row;
    const clamp = features.rows.length <= FEATURE_ICON_LIMIT;
    features.highlight?.add({
      id: `${PICK_PREFIX.feature}${id}`,
      position: clamp
        ? Cesium.Cartesian3.fromDegrees(lon, lat)
        : groundPosition(lon, lat, 0.5),
      image: selectionRingGlyph({ size: 64, color: COLORS.selected }),
      imageId: 'mly-selection-ring',
      width: 58,
      height: 58,
      ...(clamp
        ? { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND }
        : {}),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
    });
    requestRender();
    return row;
  }

  function clearSelection({ keepId = false } = {}) {
    const features = state.features;
    if (features.selectedId) {
      const previous = features.billboardById?.get(features.selectedId);
      if (previous) previous.scale = 1;
    }
    features.highlight?.removeAll();
    if (!keepId) features.selectedId = null;
    requestRender();
  }

  function setVisible(visible) {
    const features = state.features;
    if (features.points) features.points.show = visible && !features.iconMode;
    if (features.collection)
      features.collection.show =
        visible && features.iconMode && !features.iconsHidden;
    if (features.highlight) features.highlight.show = visible;
    requestRender();
  }

  /** Hide the flat icons while 3D objects stand in for them. */
  function setIconsHidden(hidden) {
    state.features.iconsHidden = hidden === true;
    if (state.features.collection)
      state.features.collection.show =
        state.features.iconMode && !state.features.iconsHidden;
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
    for (const key of ['points', 'collection', 'highlight']) {
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
    setIconsHidden,
    frame,
    findRow,
    select,
    clearSelection,
    spriteImage,
    spriteSvg,
    destroy,
  };
}
