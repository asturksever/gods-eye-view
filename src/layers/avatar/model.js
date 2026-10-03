/**
 * Pure policy for the Me Mode avatar: URL options, clip selection, movement
 * on the local east-north plane and ground-height smoothing. No Cesium, no DOM;
 * the layer in index.js owns every scene resource.
 */

/** Served from `public/avatars/` when present (see `npm run avatar:fetch`). */
export const DEFAULT_AVATAR_URL = '/avatars/default.glb';
/**
 * Pinned runtime fallback for the placeholder model when no local copy exists.
 * The model is not committed to this repository (see public/avatars/README.md).
 */
export const FALLBACK_AVATAR_URL =
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/models/gltf/Soldier.glb';
/** Clip names in the placeholder model. */
export const DEFAULT_CLIP_MAP = Object.freeze({
  idle: 'Idle',
  walk: 'Walk',
  run: 'Run',
});
/**
 * Extra compass-heading rotation (radians) that turns the model's authored
 * forward axis onto the direction of travel. The placeholder faces glTF −Z.
 */
export const DEFAULT_HEADING_OFFSET = Math.PI;

export const WALK_SPEED_MPS = 1.4;
export const RUN_SPEED_MPS = 4;
export const EYE_HEIGHT_M = 1.6;
export const CAMERA_RANGE_MIN_M = 2;
export const CAMERA_RANGE_MAX_M = 30;
export const CAMERA_RANGE_DEFAULT_M = 6;
export const CAMERA_PITCH_DEFAULT = -0.3;
export const CAMERA_PITCH_MIN = -1.3;
export const CAMERA_PITCH_MAX = 0.6;
/** Voice "move to" walks under this distance and teleports beyond it. */
export const WALK_TO_MAX_M = 300;
/** Autopilot stops within this distance of its target. */
export const ARRIVAL_RADIUS_M = 0.75;

const EARTH_RADIUS_M = 6371008.8;
const TWO_PI = Math.PI * 2;
const CLIP_ROLES = ['idle', 'walk', 'run'];

/**
 * Read `?avatar=` and `?clips=idle:Idle,walk:Walk,run:Run` from a query string.
 * Only same-origin root-relative paths and https URLs are accepted as models.
 * @param {string} search `location.search`
 * @returns {{ url: string|null, clips: Object<string,string>|null, headingOffset: number|null }}
 */
export function parseAvatarParams(search = '') {
  const params = new URLSearchParams(search);
  const rawUrl = params.get('avatar')?.trim() || '';
  const url =
    /^\/(?!\/)[^\s]*\.(glb|gltf)(\?[^\s]*)?$/i.test(rawUrl) ||
    /^https:\/\/[^\s]+$/i.test(rawUrl)
      ? rawUrl
      : null;
  const clips = {};
  for (const pair of (params.get('clips') || '').split(',')) {
    const [role, name] = pair.split(':').map((part) => part?.trim());
    if (CLIP_ROLES.includes(role) && name) clips[role] = name;
  }
  const degrees = Number(params.get('avatarHeading'));
  return {
    url,
    clips: Object.keys(clips).length ? clips : null,
    headingOffset:
      params.has('avatarHeading') && Number.isFinite(degrees)
        ? (degrees * Math.PI) / 180
        : null,
  };
}

/**
 * Map idle/walk/run onto the clips a model actually has. A requested name that
 * the model lacks falls back by role (run → walk → idle), and a model with one
 * clip uses it for every role. Returns null roles when the model has no clips.
 * @param {string[]} available Animation names in the loaded model.
 * @param {Object<string,string>} [requested]
 * @returns {{ idle: string|null, walk: string|null, run: string|null }}
 */
export function resolveClipMap(available = [], requested = DEFAULT_CLIP_MAP) {
  const names = available.filter(Boolean);
  const find = (wanted) => {
    if (!wanted) return null;
    if (names.includes(wanted)) return wanted;
    const lower = wanted.toLowerCase();
    return names.find((name) => name.toLowerCase() === lower) || null;
  };
  const guess = (role) =>
    names.find((name) => name.toLowerCase().includes(role)) || null;
  const idle =
    find(requested.idle) ||
    guess('idle') ||
    names.find((name) => !/t-?pose/i.test(name)) ||
    null;
  const walk = find(requested.walk) || guess('walk') || idle;
  const run = find(requested.run) || guess('run') || walk;
  return { idle, walk, run };
}

/** Animation role for a ground speed. */
export function clipRoleForSpeed(speed) {
  if (speed > (WALK_SPEED_MPS + RUN_SPEED_MPS) / 2) return 'run';
  if (speed > 0.1) return 'walk';
  return 'idle';
}

/** Playback rate that keeps a clip's stride matched to the ground speed. */
export function clipRateForSpeed(role, speed) {
  if (role === 'run') return Math.max(0.5, speed / RUN_SPEED_MPS);
  if (role === 'walk') return Math.max(0.5, speed / WALK_SPEED_MPS);
  return 1;
}

/**
 * Desired horizontal velocity from held keys, relative to a compass heading.
 * @param {{forward:boolean, back:boolean, left:boolean, right:boolean, run:boolean}} keys
 * @param {number} cameraHeading Compass radians (0 = north, clockwise).
 * @returns {{ east: number, north: number, speed: number, heading: number|null }}
 */
export function velocityFromKeys(keys, cameraHeading) {
  const forward = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const right = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  if (!forward && !right) return { east: 0, north: 0, speed: 0, heading: null };
  const heading = normalizeAngle(cameraHeading + Math.atan2(right, forward));
  const speed = keys.run ? RUN_SPEED_MPS : WALK_SPEED_MPS;
  return {
    east: Math.sin(heading) * speed,
    north: Math.cos(heading) * speed,
    speed,
    heading,
  };
}

/**
 * Move a WGS84 position by an east/north displacement in metres.
 * @returns {{ lon: number, lat: number }} Degrees.
 */
export function offsetLonLat(lon, lat, eastM, northM) {
  const latRad = (lat * Math.PI) / 180;
  const dLat = northM / EARTH_RADIUS_M;
  const dLon = eastM / (EARTH_RADIUS_M * Math.max(1e-6, Math.cos(latRad)));
  return {
    lon: wrapLongitude(lon + (dLon * 180) / Math.PI),
    lat: Math.max(-89.9, Math.min(89.9, lat + (dLat * 180) / Math.PI)),
  };
}

/**
 * Local east/north offset (metres) and compass bearing from one point to
 * another. Equirectangular; accurate well beyond the walk-to radius.
 */
export function localOffset(fromLon, fromLat, toLon, toLat) {
  const meanLat = (((fromLat + toLat) / 2) * Math.PI) / 180;
  const dLon = wrapLongitude(toLon - fromLon);
  const east = ((dLon * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos(meanLat);
  const north = (((toLat - fromLat) * Math.PI) / 180) * EARTH_RADIUS_M;
  return {
    east,
    north,
    distance: Math.hypot(east, north),
    bearing: normalizeAngle(Math.atan2(east, north)),
  };
}

/** Turn `from` toward `to` by at most `maxStep` radians along the short way. */
export function turnToward(from, to, maxStep) {
  const delta = normalizeAngle(to - from + Math.PI) - Math.PI;
  if (Math.abs(delta) <= maxStep) return normalizeAngle(to);
  return normalizeAngle(from + Math.sign(delta) * maxStep);
}

/** Wrap radians into [0, 2π). */
export function normalizeAngle(angle) {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

function wrapLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Clamp a value into [min, max]. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Moving average over the last few ground samples. A jump larger than
 * `resetJumpM` (teleport, stepping off a bridge) restarts the window so the
 * avatar does not glide through the gap; smaller tile-LOD pops are averaged.
 */
export class HeightSmoother {
  constructor({ window = 5, resetJumpM = 4 } = {}) {
    this.window = window;
    this.resetJumpM = resetJumpM;
    this.samples = [];
  }

  /** Discard history and start from an exact height. */
  reset(height) {
    this.samples = Number.isFinite(height) ? [height] : [];
  }

  /** Add a sample; undefined/NaN samples are ignored (keep last good). */
  push(height) {
    if (!Number.isFinite(height)) return this.value;
    const current = this.value;
    if (current !== null && Math.abs(height - current) > this.resetJumpM)
      this.samples = [];
    this.samples.push(height);
    if (this.samples.length > this.window) this.samples.shift();
    return this.value;
  }

  /** Current smoothed height, or null before the first good sample. */
  get value() {
    if (!this.samples.length) return null;
    return this.samples.reduce((sum, h) => sum + h, 0) / this.samples.length;
  }
}

/** A downward ground probe starts this far above the feet: steps and curbs
 *  below it are climbed, and anything above it (tree canopy, bridges,
 *  awnings) is walked under rather than stood on. */
export const STEP_UP_M = 1.2;
/** Placement descends through canopies in at most this many probes. */
const MAX_DESCENT_PROBES = 6;
/** Each descent probe starts this far below the previous hit. */
const DESCENT_GAP_M = 0.3;

/**
 * Ground under a walking avatar. `castDown(fromHeight)` returns the height of
 * the first surface below `fromHeight` (or undefined); `topDown()` is the
 * fallback "highest surface here" read for when the probe starts inside
 * geometry and finds nothing.
 * @returns {number|undefined}
 */
export function followGround(castDown, currentHeight, topDown) {
  const below = Number.isFinite(currentHeight)
    ? castDown(currentHeight + STEP_UP_M)
    : undefined;
  return Number.isFinite(below) ? below : topDown();
}

/**
 * Ground for a placement whose height is unknown: start from the highest
 * surface (`top`) and keep probing just below each hit until nothing is
 * below. Canopies and bridge decks are passed through, so the lowest surface
 * found is the ground. A roof with nothing under it stays the answer.
 * @param {(fromHeight: number) => Promise<number|undefined>} castDown
 * @param {number} top
 * @returns {Promise<number>}
 */
export async function descendToGround(castDown, top) {
  let ground = top;
  for (let probe = 0; probe < MAX_DESCENT_PROBES; probe++) {
    const below = await castDown(ground - DESCENT_GAP_M);
    if (!Number.isFinite(below) || below >= ground) break;
    ground = below;
  }
  return ground;
}

/** Plain JSON pose for voice scene context. */
export function describePose({ lon, lat, height, heading, speed, view }) {
  const round = (value, digits) =>
    Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
  return {
    longitude: round(lon, 6),
    latitude: round(lat, 6),
    heightM: round(height, 2),
    headingDeg: round((normalizeAngle(heading || 0) * 180) / Math.PI, 1),
    facing: compassPoint(heading || 0),
    speedMps: round(speed, 2),
    view,
  };
}

function compassPoint(heading) {
  const points = ['north', 'northeast', 'east', 'southeast'];
  const all = [...points, 'south', 'southwest', 'west', 'northwest'];
  return all[Math.round(normalizeAngle(heading) / (Math.PI / 4)) % 8];
}
