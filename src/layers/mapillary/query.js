import * as Cesium from 'cesium';
import { visibleBbox } from './coverage.js';
import { countTilesForBbox, normalizeBbox } from './tileMath.js';
import { groupCountsByLabel } from './values.js';

/** Fallback half-size (degrees) around a geocoded point with no bounds. */
const POINT_PLACE_HALF_DEG = 0.02;
/**
 * Smallest place box worth querying (degrees, ~1.1 km). Nominatim returns a
 * node-sized box for many neighbourhoods and landmarks; a query on that would
 * cover one intersection and read as "nothing here".
 */
const MIN_PLACE_SPAN_DEG = 0.01;
/** Radii (metres) of the probe rings used when nothing sits within 50 m. */
const NEAREST_RING_M = [90, 180, 300];
/** Cap for a "current view" query when the server does not report one. */
const DEFAULT_MAX_TILES = 600;
const FEATURE_ZOOM = 14;
/** A current-view query wider than this is the horizon, not an area. */
const MAX_VIEW_SPAN_DEG = 4;

/** Shrink a bbox around its centre until it fits the tile budget. */
export function fitBboxToTileBudget(bbox, maxTiles, zoom = FEATURE_ZOOM) {
  let box = normalizeBbox(bbox);
  if (!box) return null;
  let guard = 0;
  while (
    countTilesForBbox([box.west, box.south, box.east, box.north], zoom) >
      maxTiles &&
    guard++ < 40
  ) {
    const cx = (box.west + box.east) / 2;
    const cy = (box.south + box.north) / 2;
    const hw = ((box.east - box.west) / 2) * 0.85;
    const hh = ((box.north - box.south) / 2) * 0.85;
    box = { west: cx - hw, east: cx + hw, south: cy - hh, north: cy + hh };
  }
  return [box.west, box.south, box.east, box.north];
}

/** Approximate metres between two lon/lat points (small distances). */
function metresBetween(a, b) {
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lon - a.lon) * 111_320 * Math.cos(lat);
  const dy = (b.lat - a.lat) * 110_540;
  return Math.hypot(dx, dy);
}

/** Grow a bbox symmetrically until both sides reach `minSpan` degrees. */
export function enforceMinimumSpan(bbox, minSpan) {
  const [west, south, east, north] = bbox;
  if (east - west >= minSpan && north - south >= minSpan) return bbox;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const hw = Math.max((east - west) / 2, minSpan / 2);
  const hh = Math.max((north - south) / 2, minSpan / 2);
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

/** Turn a geocode result into a bbox, label and centre. */
export function bboxFromGeocode(result) {
  const geometry = result?.geometry;
  const location = geometry?.location;
  if (
    !location ||
    !Number.isFinite(location.lat) ||
    !Number.isFinite(location.lng)
  )
    return null;
  const bounds = geometry.bounds || geometry.viewport;
  const bbox = bounds
    ? [
        bounds.southwest.lng,
        bounds.southwest.lat,
        bounds.northeast.lng,
        bounds.northeast.lat,
      ]
    : [
        location.lng - POINT_PLACE_HALF_DEG,
        location.lat - POINT_PLACE_HALF_DEG,
        location.lng + POINT_PLACE_HALF_DEG,
        location.lat + POINT_PLACE_HALF_DEG,
      ];
  return {
    bbox: enforceMinimumSpan(bbox, MIN_PLACE_SPAN_DEG),
    label: result.formatted_address || '',
    center: { lat: location.lat, lon: location.lng },
  };
}

/** Compose the one-line result summary shown under the query box. */
export function summarizeResults(features) {
  const total = features.total || 0;
  const values = groupCountsByLabel(features.counts.entries());
  const head = values
    .slice(0, 3)
    .map(
      ({ label, count }) => `${count.toLocaleString()} ${label.toLowerCase()}`,
    )
    .join(', ');
  const more =
    values.length > 3 ? ` and ${values.length - 3} more classes` : '';
  const years =
    features.earliest && features.latest
      ? ` · seen ${new Date(features.earliest).getFullYear()}–${new Date(features.latest).getFullYear()}`
      : '';
  const truncated = features.truncated ? ' · capped' : '';
  const failed = features.failed ? ` · ${features.failed} tiles failed` : '';
  if (!total) return 'No matching features in this area.';
  return `${total.toLocaleString()} features: ${head}${more}${years}${truncated}${failed}`;
}

/** Natural-language query orchestration: plan → resolve area → stream → draw. */
export function createQuery({ state, source, parts }) {
  function notify() {
    state.notify?.();
  }

  function viewContext() {
    const viewer = state.viewer;
    if (!viewer) return {};
    const carto = viewer.camera.positionCartographic;
    const bbox = visibleBbox(viewer);
    const center = bbox
      ? { lat: (bbox[1] + bbox[3]) / 2, lon: (bbox[0] + bbox[2]) / 2 }
      : {
          lat: Cesium.Math.toDegrees(carto.latitude),
          lon: Cesium.Math.toDegrees(carto.longitude),
        };
    const ground = viewer.scene.globe?.getHeight?.(carto);
    return {
      lat: center.lat,
      lon: center.lon,
      heightM: carto.height - (Number.isFinite(ground) ? ground : 0),
    };
  }

  function maxTiles() {
    return state.status?.limits?.maxTiles || DEFAULT_MAX_TILES;
  }

  async function resolveArea(plan, signal) {
    if (plan.place) {
      const results = await source.geocode(plan.place, { signal });
      const resolved = bboxFromGeocode(results[0]);
      if (!resolved)
        throw new Error(`Could not find "${plan.place}" on the map`);
      return {
        ...resolved,
        bbox: fitBboxToTileBudget(resolved.bbox, maxTiles()),
        fromPlace: true,
      };
    }
    const bbox = visibleBbox(state.viewer);
    // The horizon (or a camera still in flight) yields a continent-sized
    // rectangle; querying that would silently pick a box in the middle of it.
    if (
      !bbox ||
      bbox[2] - bbox[0] > MAX_VIEW_SPAN_DEG ||
      bbox[3] - bbox[1] > MAX_VIEW_SPAN_DEG
    )
      throw new Error('Zoom in closer to the ground, or name a place');
    const view = viewContext();
    return {
      bbox: fitBboxToTileBudget(bbox, maxTiles()),
      label: 'current view',
      center: { lat: view.lat, lon: view.lon },
      fromPlace: false,
    };
  }

  async function runFeatures(plan, area, signal) {
    const features = state.features;
    parts.features.reset();
    Object.assign(features, {
      bbox: area.bbox,
      title: plan.title,
      layer: plan.layer,
      values: plan.values,
      loading: true,
    });
    state.query.stage = 'fetching';
    notify();
    // Results are the subject now: rest the coverage web until CLEAR so tens
    // of thousands of markers are not read against a web of green lines.
    parts.coverage.setResting(true);
    // A named place is somewhere else: fly there. The current view already
    // shows the area, so leave the camera where the user put it.
    if (area.fromPlace) parts.features.frame(area.bbox);
    let lastNotify = 0;
    await source.queryFeatures(
      {
        bbox: area.bbox,
        layer: plan.layer,
        values: plan.values,
        seenAfter: plan.seen_after,
        seenBefore: plan.seen_before,
      },
      (record) => {
        if (record.type === 'start')
          features.progress = { done: 0, tiles: record.tiles };
        else if (record.type === 'tile') {
          features.progress.done++;
          if (record.rows?.length) parts.features.appendRows(record.rows);
          const now = Date.now();
          if (now - lastNotify > 120) {
            lastNotify = now;
            notify();
          }
        } else if (record.type === 'done') {
          features.truncated = record.truncated === true;
          features.failed = record.failed || 0;
        }
      },
      { signal },
    );
    features.loading = false;
    notify();
    await parts.features.upgradeToIcons();
    state.query.answer = `${plan.answer} ${summarizeResults(features)}`;
    notify();
  }

  async function runNearest(plan, area, signal) {
    const found = await nearestImageAround(area.center, signal);
    if (!found)
      throw new Error(
        `No Mapillary imagery within ${NEAREST_RING_M[NEAREST_RING_M.length - 1] + 50} m of ${area.label || 'that point'}`,
      );
    await parts.street.openImage(found.image.id);
    state.query.answer = `${plan.answer} Opened the closest image, about ${Math.round(found.distanceM)} m away.`;
  }

  /**
   * Mapillary's radius search stops at 50 m, which misses a landmark whose
   * geocoded centre sits inside a large footprint. Probe the centre first,
   * then rings of points around it, and keep the closest hit overall.
   */
  async function nearestImageAround(center, signal) {
    const rings = [[center]];
    for (const ring of NEAREST_RING_M) {
      const probes = [];
      for (let k = 0; k < 8; k++) {
        const angle = (k / 8) * Math.PI * 2;
        probes.push({
          lat: center.lat + (ring * Math.cos(angle)) / 110_540,
          lon:
            center.lon +
            (ring * Math.sin(angle)) /
              (111_320 * Math.cos((center.lat * Math.PI) / 180)),
        });
      }
      rings.push(probes);
    }
    for (const probes of rings) {
      const results = await Promise.all(
        probes.map((probe) =>
          source
            .nearestImages(
              { lat: probe.lat, lon: probe.lon, radius: 50, limit: 3 },
              { signal },
            )
            .catch(() => []),
        ),
      );
      let best = null;
      for (const images of results)
        for (const image of images) {
          const coordinates =
            image?.computed_geometry?.coordinates ||
            image?.geometry?.coordinates;
          if (!coordinates) continue;
          const distanceM = metresBetween(center, {
            lon: coordinates[0],
            lat: coordinates[1],
          });
          if (!best || distanceM < best.distanceM) best = { image, distanceM };
        }
      if (best) return best;
    }
    return null;
  }

  /**
   * Execute an already-built plan (from the planner, the voice agent, or a
   * test). Resolves the area, streams features or opens imagery, and records
   * the turn in the history.
   */
  async function execute(plan, { prompt = plan?.title || '', signal } = {}) {
    if (!plan || typeof plan !== 'object')
      throw new Error('A plan is required');
    state.query.lastPlan = plan;
    state.query.answer = plan.answer || '';
    state.query.title = plan.title || '';
    notify();
    if (plan.intent === 'unsupported') {
      state.query.stage = 'idle';
    } else if (plan.intent === 'coverage') {
      state.query.stage = 'resolving';
      notify();
      const area = await resolveArea(plan, signal);
      parts.features.frame(area.bbox, { duration: 2.4 });
      state.query.stage = 'idle';
    } else if (plan.intent === 'nearest_image') {
      state.query.stage = 'resolving';
      notify();
      const area = await resolveArea(plan, signal);
      await runNearest(plan, area, signal);
      state.query.stage = 'idle';
    } else {
      if (!plan.layer) plan = { ...plan, layer: 'points' };
      state.query.stage = 'resolving';
      notify();
      const area = await resolveArea(plan, signal);
      await runFeatures(plan, area, signal);
      state.query.stage = 'done';
    }
    state.query.history.push({ prompt, plan, total: state.features.total });
  }

  /** Run one natural-language request end to end. */
  async function run(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return;
    abort();
    const controller = new AbortController();
    state.query.abort = controller;
    Object.assign(state.query, {
      busy: true,
      stage: 'planning',
      prompt: text,
      answer: '',
      error: null,
      usage: null,
    });
    notify();
    try {
      const { plan, usage, model } = await source.plan(
        {
          query: text,
          context: { view: viewContext(), previousPlan: state.query.lastPlan },
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      state.query.usage = usage ? { ...usage, model } : null;
      await execute(plan, { prompt: text, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      state.features.loading = false;
      state.query.stage = 'error';
      state.query.error = describeError(error);
    } finally {
      if (state.query.abort === controller) {
        state.query.busy = false;
        state.query.abort = null;
      }
      notify();
    }
  }

  /** Execute a supplied plan with the same lifecycle bookkeeping as run(). */
  async function runPlan(plan, { prompt } = {}) {
    abort();
    const controller = new AbortController();
    state.query.abort = controller;
    Object.assign(state.query, {
      busy: true,
      stage: 'resolving',
      prompt: prompt || plan?.title || '',
      answer: '',
      error: null,
      usage: null,
    });
    notify();
    try {
      await execute(plan, { prompt, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      state.features.loading = false;
      state.query.stage = 'error';
      state.query.error = describeError(error);
    } finally {
      if (state.query.abort === controller) {
        state.query.busy = false;
        state.query.abort = null;
      }
      notify();
    }
  }

  function describeError(error) {
    if (
      error?.keyRequired === 'anthropic' ||
      error?.payload?.keyRequired === 'anthropic'
    )
      return 'Mapillary AI needs an Anthropic key — add one in POWER UP.';
    if (
      error?.keyRequired === 'mapillary' ||
      error?.payload?.keyRequired === 'mapillary' ||
      error?.payload?.keyRequired === true
    )
      return 'Add a Mapillary client token in POWER UP first.';
    if (error?.payload?.error === 'area_too_large')
      return `That area spans ${error.payload.tiles?.toLocaleString()} tiles (limit ${error.payload.limit}); try a smaller place.`;
    return error?.message || 'Query failed';
  }

  function abort() {
    state.query.abort?.abort();
    state.query.abort = null;
    state.query.busy = false;
    state.features.loading = false;
  }

  /** Drop the drawn results and the conversational context. */
  function clear() {
    abort();
    parts.features.reset();
    parts.coverage.setResting(false);
    Object.assign(state.query, {
      stage: 'idle',
      prompt: '',
      answer: '',
      error: null,
      lastPlan: null,
      usage: null,
      title: '',
    });
    Object.assign(state.features, {
      bbox: null,
      title: '',
      layer: null,
      values: [],
    });
    notify();
  }

  return { run, runPlan, execute, clear, abort, viewContext };
}
