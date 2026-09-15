import * as Cesium from 'cesium';
import { decodeCoverageTile } from './decode.js';
import { coverageZoomForHeight, tilesForBbox } from './tileMath.js';
import {
  COLORS,
  COVERAGE_LINE_WIDTH_PX,
  COVERAGE_MAX_SEQUENCES,
  COVERAGE_MAX_TILES,
  COVERAGE_MOVE_DEBOUNCE_MS,
  COVERAGE_RECENT_DAYS,
  PICK_PREFIX,
} from './policy.js';

const PER_TILE_SEQUENCE_CAP = Math.floor(
  COVERAGE_MAX_SEQUENCES / COVERAGE_MAX_TILES,
);

/** Colour for a sequence: brand green, dimmer with age, magenta for panoramas. */
export function sequenceColor(
  sequence,
  { selected = false, now = Date.now() } = {},
) {
  if (selected) return Cesium.Color.fromCssColorString(COLORS.selected);
  if (sequence.isPano)
    return Cesium.Color.fromCssColorString(COLORS.pano).withAlpha(0.9);
  const ageDays = (now - (sequence.capturedAt || 0)) / 86_400_000;
  return ageDays <= COVERAGE_RECENT_DAYS
    ? Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(0.92)
    : Cesium.Color.fromCssColorString(COLORS.coverageOld).withAlpha(0.7);
}

/**
 * Camera height above the surface under the camera, in metres. Falls back to
 * the ellipsoidal height when the globe has no height sample yet.
 */
export function cameraHeightAboveGround(viewer) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto) return null;
  const ground = viewer.scene?.globe?.getHeight?.(carto);
  return carto.height - (Number.isFinite(ground) ? ground : 0);
}

/**
 * Visible bbox as [west, south, east, north] degrees, or null when the camera
 * does not see the ground. A grid of screen rays is cast onto the ellipsoid
 * and only the rays that hit count, so a view that includes the horizon (or a
 * canvas whose frustum is stale) cannot inflate the box to the whole world;
 * `computeViewRectangle` is the fallback when too few rays land.
 */
export function visibleBbox(viewer, { grid = 5 } = {}) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  if (!scene || !camera) return null;
  const width = scene.canvas?.clientWidth || scene.canvas?.width || 0;
  const height = scene.canvas?.clientHeight || scene.canvas?.height || 0;
  const hits = [];
  if (width > 0 && height > 0) {
    const ellipsoid = scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
    const point = new Cesium.Cartesian2();
    for (let i = 0; i <= grid; i++) {
      for (let j = 0; j <= grid; j++) {
        point.x = (width * i) / grid;
        point.y = (height * j) / grid;
        let cartesian = null;
        try {
          cartesian = camera.pickEllipsoid(point, ellipsoid);
        } catch {
          cartesian = null;
        }
        if (!cartesian) continue;
        const carto = Cesium.Cartographic.fromCartesian(cartesian, ellipsoid);
        if (carto) hits.push(carto);
      }
    }
  }
  if (hits.length >= 4) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const carto of hits) {
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    if (east - west > 0 && north - south > 0) return [west, south, east, north];
  }
  const rectangle = camera.computeViewRectangle?.(scene.globe?.ellipsoid);
  if (!rectangle) return null;
  return [
    Cesium.Math.toDegrees(rectangle.west),
    Cesium.Math.toDegrees(rectangle.south),
    Cesium.Math.toDegrees(rectangle.east),
    Cesium.Math.toDegrees(rectangle.north),
  ];
}

/** Camera-driven coverage tiles rendered as terrain/mesh-clamped polylines. */
export function createCoverage({ state, source }) {
  const { render } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('mapillary-coverage');
  }

  function ensureTerrainReady() {
    return (state.coverage.terrainReady ||=
      Cesium.GroundPolylinePrimitive.initializeTerrainHeights());
  }

  function tileKey({ x, y, z }) {
    return `${z}/${x}/${y}`;
  }

  function buildPrimitive(sequences) {
    const now = Date.now();
    const instances = [];
    for (const sequence of sequences) {
      const flat = [];
      for (const [lon, lat] of sequence.coordinates) flat.push(lon, lat);
      let positions;
      try {
        positions = Cesium.Cartesian3.fromDegreesArray(flat);
      } catch {
        continue;
      }
      if (positions.length < 2) continue;
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions,
            width: COVERAGE_LINE_WIDTH_PX,
          }),
          id: `${PICK_PREFIX.sequence}${sequence.id}`,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              sequenceColor(sequence, {
                now,
                selected: sequence.id === state.sequence.selectedId,
              }),
            ),
          },
        }),
      );
    }
    if (!instances.length) return null;
    return new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineColorAppearance(),
      classificationType: Cesium.ClassificationType.BOTH,
      asynchronous: true,
      allowPicking: true,
    });
  }

  function removeTile(key) {
    const entry = state.coverage.tiles.get(key);
    if (!entry) return;
    if (entry.primitive) {
      try {
        state.viewer?.scene?.groundPrimitives?.remove(entry.primitive);
      } catch {
        /* already gone */
      }
    }
    state.coverage.tiles.delete(key);
  }

  async function loadTile(tile, generation) {
    const key = tileKey(tile);
    if (state.coverage.tiles.has(key) || state.coverage.pending.has(key))
      return;
    const controller = new AbortController();
    state.coverage.pending.set(key, controller);
    state.coverage.loading++;
    notify();
    try {
      await ensureTerrainReady();
      const bytes = await source.getTile('coverage', tile.z, tile.x, tile.y, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== state.coverage.generation)
        return;
      const decoded = decodeCoverageTile(bytes, tile);
      // Newest first, capped per tile so a dense city stays within budget.
      const sequences = decoded.sequences
        .sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))
        .slice(0, PER_TILE_SEQUENCE_CAP);
      const primitive = buildPrimitive(sequences);
      if (primitive) {
        primitive.show = !state.coverage.resting;
        state.viewer.scene.groundPrimitives.add(primitive);
      }
      state.coverage.tiles.set(key, {
        primitive,
        sequences: new Map(
          sequences.map((sequence) => [sequence.id, sequence]),
        ),
        count: sequences.length,
        total: decoded.sequences.length,
      });
      state.coverage.lastError = null;
      requestRender();
    } catch (error) {
      if (controller.signal.aborted) return;
      state.coverage.lastError = error?.message || 'Coverage tile failed';
      if (error?.keyRequired) state.keyRequired = true;
    } finally {
      state.coverage.pending.delete(key);
      state.coverage.loading = Math.max(0, state.coverage.loading - 1);
      notify();
    }
  }

  function notify() {
    state.notify?.();
  }

  /** Recompute the tile set for the current camera and reconcile primitives. */
  function refresh() {
    const viewer = state.viewer;
    if (!viewer || !state.enabled || state.keyRequired) return;
    const height = cameraHeightAboveGround(viewer);
    const zoom = coverageZoomForHeight(height);
    const bbox = zoom ? visibleBbox(viewer) : null;
    if (!zoom || !bbox) {
      state.coverage.hint = 'Zoom in below 60 km for Mapillary coverage';
      clear();
      notify();
      return;
    }
    state.coverage.hint = '';
    if (zoom !== state.coverage.zoom) {
      clear();
      state.coverage.zoom = zoom;
    }
    state.coverage.generation++;
    const generation = state.coverage.generation;
    const { tiles } = tilesForBbox(bbox, zoom, { limit: COVERAGE_MAX_TILES });
    const wanted = new Set(tiles.map(tileKey));
    for (const key of [...state.coverage.tiles.keys()])
      if (!wanted.has(key)) removeTile(key);
    for (const [key, controller] of [...state.coverage.pending])
      if (!wanted.has(key)) {
        controller.abort();
        state.coverage.pending.delete(key);
      }
    for (const tile of tiles) loadTile(tile, generation);
    notify();
  }

  function scheduleRefresh() {
    clearTimeout(state.coverage.debounceTimer);
    state.coverage.debounceTimer = setTimeout(
      refresh,
      COVERAGE_MOVE_DEBOUNCE_MS,
    );
  }

  function attach(viewer) {
    detach();
    const remove = viewer.camera.changed.addEventListener(scheduleRefresh);
    const removeEnd = viewer.camera.moveEnd.addEventListener(scheduleRefresh);
    state.coverage.removeCameraListener = () => {
      remove();
      removeEnd();
    };
    refresh();
  }

  function detach() {
    clearTimeout(state.coverage.debounceTimer);
    state.coverage.debounceTimer = null;
    state.coverage.removeCameraListener?.();
    state.coverage.removeCameraListener = null;
  }

  function clear() {
    state.coverage.generation++;
    for (const controller of state.coverage.pending.values())
      controller.abort();
    state.coverage.pending.clear();
    state.coverage.loading = 0;
    for (const key of [...state.coverage.tiles.keys()]) removeTile(key);
    state.coverage.zoom = null;
    requestRender();
  }

  /** Look a sequence up across loaded tiles. */
  function findSequence(id) {
    for (const entry of state.coverage.tiles.values()) {
      const hit = entry.sequences.get(id);
      if (hit) return hit;
    }
    return null;
  }

  /** Recolour one sequence in place (selection highlight). */
  function recolorSequence(id, selected) {
    const instanceId = `${PICK_PREFIX.sequence}${id}`;
    for (const entry of state.coverage.tiles.values()) {
      const sequence = entry.sequences.get(id);
      if (!sequence || !entry.primitive?.ready) continue;
      try {
        const attributes =
          entry.primitive.getGeometryInstanceAttributes(instanceId);
        if (attributes)
          attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
            sequenceColor(sequence, { selected }),
            attributes.color,
          );
      } catch {
        /* instance not in this primitive */
      }
    }
    requestRender();
  }

  /** Hide (rest) or show every loaded coverage primitive without dropping tiles. */
  function setResting(resting) {
    state.coverage.resting = resting === true;
    for (const entry of state.coverage.tiles.values())
      if (entry.primitive) entry.primitive.show = !state.coverage.resting;
    requestRender();
  }

  function sequenceCount() {
    let count = 0;
    for (const entry of state.coverage.tiles.values()) count += entry.count;
    return count;
  }

  return {
    attach,
    detach,
    refresh,
    clear,
    findSequence,
    recolorSequence,
    sequenceCount,
    setResting,
  };
}
