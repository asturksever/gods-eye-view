import path from 'node:path';

/** Mapillary vector tile root; the path template is /{layer}/2/{z}/{x}/{y}. */
export const MAPILLARY_TILE_HOST = 'https://tiles.mapillary.com/maps/vtp';

/** Public tile layer names this proxy exposes, mapped to Mapillary's ids. */
export const TILE_LAYERS = Object.freeze({
  // Overview points (z0–5), sequences (z6–14) and image points (z14 only).
  coverage: Object.freeze({ upstream: 'mly1_public', minZoom: 0, maxZoom: 14 }),
  // Point map features such as fire hydrants, benches and utility poles.
  points: Object.freeze({
    upstream: 'mly_map_feature_point',
    minZoom: 14,
    maxZoom: 14,
  }),
  // Classified traffic-sign detections.
  signs: Object.freeze({
    upstream: 'mly_map_feature_traffic_sign',
    minZoom: 14,
    maxZoom: 14,
  }),
});

/** Zoom at which Mapillary publishes map-feature tiles. */
export const FEATURE_TILE_ZOOM = 14;

/** Disk cache root, alongside the other providers' caches. */
export const MAPILLARY_CACHE_DIR = path.join(
  process.cwd(),
  '.gev-cache',
  'mapillary',
);
export const TILE_DISK_DIR = path.join(MAPILLARY_CACHE_DIR, 'tiles');
export const SPRITE_DISK_DIR = path.join(MAPILLARY_CACHE_DIR, 'sprites');

/**
 * Tiles change when new imagery is processed, which is far slower than the
 * 15-minute upstream Cache-Control. A day keeps a city-wide query from
 * re-downloading hundreds of megabytes on every run.
 */
export const TILE_DISK_TTL_MS = 24 * 60 * 60 * 1000;
export const SPRITE_DISK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A z14 image tile over a dense city is ~11 MB; anything past this is wrong. */
export const TILE_MAX_BYTES = 48 * 1024 * 1024;
export const SPRITE_MAX_BYTES = 512 * 1024;

/** In-memory tile cache budget (bytes) and upstream fetch timeout. */
export const TILE_MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;
export const TILE_FETCH_TIMEOUT_MS = 60_000;

/** Executor limits for one natural-language query. */
export const QUERY_MAX_TILES = 600;
export const QUERY_MAX_FEATURES = 120_000;
export const QUERY_TILE_CONCURRENCY = 6;
export const QUERY_MAX_BODY_BYTES = 32 * 1024;

/** Sprite SVG source (MIT) — one file per taxonomy value. */
export const SPRITE_SOURCE_ROOT =
  'https://raw.githubusercontent.com/mapillary/mapillary_sprite_source/master';

/** Planner defaults; the model id is external and may be overridden by env. */
export const PLANNER_MODEL_DEFAULT = 'claude-opus-5';
export const PLANNER_MAX_TOKENS = 1500;
export const PLANNER_MAX_BODY_BYTES = 32 * 1024;
export const PLANNER_MAX_QUERY_CHARS = 600;

/** The client token lives in the browser by design; the server adds it to tile URLs too. */
export function mapillaryToken() {
  return String(process.env.MAPILLARY_CLIENT_TOKEN || '').trim();
}

/** Anthropic credentials are server-side only. */
export function anthropicConfigured() {
  return Boolean(
    String(process.env.ANTHROPIC_API_KEY || '').trim() ||
    String(process.env.ANTHROPIC_AUTH_TOKEN || '').trim(),
  );
}

export function plannerModel() {
  return (
    String(process.env.ANTHROPIC_PLANNER_MODEL || '').trim() ||
    PLANNER_MODEL_DEFAULT
  );
}
