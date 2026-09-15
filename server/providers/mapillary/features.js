import { readRequestBody } from '../common/request.js';
import {
  FEATURE_TILE_ZOOM,
  QUERY_MAX_BODY_BYTES,
  QUERY_MAX_FEATURES,
  QUERY_MAX_TILES,
  QUERY_TILE_CONCURRENCY,
  mapillaryToken,
} from './constants.js';
import { fetchTile, TileRequestError } from './tiles.js';
import { decodeFeatureRows } from './decode.js';
import {
  normalizeBbox,
  tilesForBbox,
} from '../../../src/layers/mapillary/tileMath.js';
import {
  createValueMatcher,
  normalizeValuePattern,
} from '../../../src/layers/mapillary/values.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Parse an ISO date (or epoch ms) into epoch ms, or null when absent/invalid. */
export function parseEpochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Validate a feature query body into an executable request.
 * @returns {{ok:true, request:object}|{ok:false, status:number, error:string, detail?:object}}
 */
export function normalizeFeatureQuery(body) {
  const bbox = normalizeBbox(body?.bbox);
  if (!bbox)
    return {
      ok: false,
      status: 400,
      error: 'A bbox [west,south,east,north] is required',
    };
  const layer = body?.layer === 'signs' ? 'signs' : 'points';
  const values = Array.isArray(body?.values)
    ? body.values.map(normalizeValuePattern).filter(Boolean).slice(0, 64)
    : [];
  const since = parseEpochMs(body?.seenAfter);
  const until = parseEpochMs(body?.seenBefore);
  const { tiles, truncated, total } = tilesForBbox(bbox, FEATURE_TILE_ZOOM, {
    limit: QUERY_MAX_TILES,
  });
  if (truncated)
    return {
      ok: false,
      status: 413,
      error: 'area_too_large',
      detail: { tiles: total, limit: QUERY_MAX_TILES },
    };
  return { ok: true, request: { bbox, layer, values, since, until, tiles } };
}

/**
 * POST /api/mapillary/features — fan a bbox out over z14 map-feature tiles
 * and stream the matching features back as NDJSON, one line per tile, so
 * the globe fills in progressively while the rest of the city downloads.
 */
export async function handleFeatureQuery(req, res) {
  if (req.method !== 'POST')
    return sendJson(res, 405, { error: 'Method not allowed' });
  if (!mapillaryToken())
    return sendJson(res, 503, { error: 'no_key', keyRequired: true });
  let body;
  try {
    body = JSON.parse(
      (await readRequestBody(req, QUERY_MAX_BODY_BYTES)) || '{}',
    );
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || 'Invalid JSON body' });
  }
  const normalized = normalizeFeatureQuery(body);
  if (!normalized.ok)
    return sendJson(res, normalized.status, {
      error: normalized.error,
      ...normalized.detail,
    });
  const { layer, values, since, until, tiles, bbox } = normalized.request;
  const matcher = createValueMatcher(values);

  const abandoned = new AbortController();
  req.on?.('aborted', () => abandoned.abort());
  res.on?.('close', () => abandoned.abort());

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  const write = (line) => {
    if (res.writableEnded || abandoned.signal.aborted) return false;
    res.write(`${JSON.stringify(line)}\n`);
    return true;
  };
  write({
    type: 'start',
    tiles: tiles.length,
    zoom: FEATURE_TILE_ZOOM,
    layer,
    values,
    bbox,
  });

  let total = 0;
  let failed = 0;
  let truncated = false;
  let cursor = 0;
  const worker = async () => {
    while (cursor < tiles.length && !abandoned.signal.aborted) {
      if (total >= QUERY_MAX_FEATURES) {
        truncated = true;
        return;
      }
      const index = cursor++;
      const tile = tiles[index];
      try {
        const { bytes, source } = await fetchTile(
          { layer, z: tile.z, x: tile.x, y: tile.y },
          { signal: abandoned.signal },
        );
        const rows = decodeFeatureRows(
          bytes,
          { ...tile, layer },
          { matcher, since, until },
        );
        total += rows.length;
        write({ type: 'tile', i: index, x: tile.x, y: tile.y, source, rows });
      } catch (error) {
        if (abandoned.signal.aborted) return;
        failed++;
        write({
          type: 'tile',
          i: index,
          x: tile.x,
          y: tile.y,
          rows: [],
          error:
            error instanceof TileRequestError
              ? error.message
              : `tile unavailable (${error?.status || error?.message || 'error'})`,
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(QUERY_TILE_CONCURRENCY, tiles.length) },
      worker,
    ),
  );
  write({ type: 'done', total, failed, truncated, tiles: tiles.length });
  if (!res.writableEnded) res.end();
}
