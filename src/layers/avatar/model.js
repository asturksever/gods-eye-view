/**
 * Pure policy for the Me Mode avatar: URL options, clip selection, movement
 * on the local east-north plane and ground-height smoothing. No Cesium, no DOM;
 * the layer in index.js owns every scene resource.
 */

/**
 * A photoreal human (Microsoft Rocketbox, MIT; see public/models/README.md),
 * converted by tools/avatar/rocketbox_to_glb.py.
 */
export const DEFAULT_AVATAR_URL = '/models/people/rocketbox-male-06.glb';
/**
 * A personal avatar, tried before the default when present. `public/avatars/`
 * is git-ignored, so a model made from your own photo stays on your machine
 * (see docs/avatar.md).
 */
export const PERSONAL_AVATAR_URL = '/avatars/me.glb';
/**
 * Pinned runtime fallback if the default model cannot be loaded: three.js's
 * Soldier, which is not committed to this repository (see
 * public/avatars/README.md).
 */
export const FALLBACK_AVATAR_URL =
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/models/gltf/Soldier.glb';
/** Clip names in the default (and fallback) model. */
export const DEFAULT_CLIP_MAP = Object.freeze({
  idle: 'Idle',
  walk: 'Walk',
  run: 'Run',
});
/**
 * Extra compass-heading rotation (radians) that turns the model's authored
 * forward axis onto the direction of travel. The default and fallback models
 * face glTF −Z.
 */
export const DEFAULT_HEADING_OFFSET = Math.PI;

/** Ground speeds: brisk walk and a superhuman sprint (2× / 4× a person). */
export const WALK_SPEED_MPS = 2.8;
export const RUN_SPEED_MPS = 16;
/** Speeds the walk/run clips were authored for; playback scales from these
 *  and is capped so fast travel does not turn the legs into a blur. */
const CLIP_NATURAL_MPS = Object.freeze({ walk: 1.4, run: 4 });
const CLIP_RATE_MAX = 2.5;
/** Fly mode: horizontal and vertical speeds; Shift multiplies both. */
export const FLY_SPEED_MPS = 15;
export const FLY_CLIMB_MPS = 6;
export const FLY_BOOST = 4;
/** Flying stops this far above the surface below. */
export const FLY_MAX_ABOVE_GROUND_M = 3000;
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
 * Only same-origin root-relative `.glb`/`.gltf` paths are accepted: a shared
 * link must not make a viewer fetch from an arbitrary host. Other origins are
 * still possible from code via the layer's `setModel`.
 * @param {string} search `location.search`
 * @returns {{ url: string|null, clips: Object<string,string>|null, headingOffset: number|null }}
 */
export function parseAvatarParams(search = '') {
  const params = new URLSearchParams(search);
  const rawUrl = params.get('avatar')?.trim() || '';
  const url = /^\/(?!\/)[^\s\\]*\.(glb|gltf)(\?[^\s]*)?$/i.test(rawUrl)
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
  const natural = CLIP_NATURAL_MPS[role];
  if (!natural) return 1;
  return clamp(speed / natural, 0.5, CLIP_RATE_MAX);
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
 * Fly-mode velocity: WASD across the camera heading, E/Q up and down, Shift
 * boosts both.
 * @returns {{ east: number, north: number, up: number, speed: number, heading: number|null }}
 */
export function flyVelocityFromKeys(keys, cameraHeading) {
  const boost = keys.run ? FLY_BOOST : 1;
  const forward = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const right = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const up = ((keys.up ? 1 : 0) - (keys.down ? 1 : 0)) * FLY_CLIMB_MPS * boost;
  if (!forward && !right)
    return { east: 0, north: 0, up, speed: 0, heading: null };
  const heading = normalizeAngle(cameraHeading + Math.atan2(right, forward));
  const speed = FLY_SPEED_MPS * boost;
  return {
    east: Math.sin(heading) * speed,
    north: Math.cos(heading) * speed,
    up,
    speed,
    heading,
  };
}

/**
 * Flight as a body with thrust, drag and inertia. Thrust pushes along the
 * keys' direction (WASD across the camera heading, E/Q up/down); quadratic
 * drag sets the top speed (FLY_SPEED_MPS, or ×FLY_BOOST streamlined with
 * Shift) and a little linear drag lets the flier coast to a stop.
 */
export const FLY_ACCEL_MPS2 = 9;
export const FLY_CLIMB_ACCEL_MPS2 = 7;
const FLY_COAST_PER_S = 0.35;

/**
 * One physics step of flight.
 * @param {{ east: number, north: number, up: number }} velocity m/s
 * @param {object} keys
 * @param {number} cameraHeading
 * @param {number} dt
 * @returns {{ east: number, north: number, up: number, accelEast: number, accelNorth: number }}
 */
export function flightStep(velocity, keys, cameraHeading, dt) {
  const boost = keys.run ? FLY_BOOST : 1;
  const forward = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const right = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const vertical = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
  let thrustEast = 0;
  let thrustNorth = 0;
  if (forward || right) {
    const heading = cameraHeading + Math.atan2(right, forward);
    // Terminal speed v = sqrt(thrust / k): thrust scales with boost², so
    // the time to reach top speed stays about the same.
    const thrust = FLY_ACCEL_MPS2 * boost * boost;
    thrustEast = Math.sin(heading) * thrust;
    thrustNorth = Math.cos(heading) * thrust;
  }
  const thrustUp = vertical * FLY_CLIMB_ACCEL_MPS2 * boost * boost;
  // Quadratic drag k so that thrust = k·v² + coast·v at the top speed v.
  const dragFor = (accel, top) =>
    Math.max(0, accel * boost * boost - FLY_COAST_PER_S * top * boost) /
    (top * boost) ** 2;
  const kHorizontal = dragFor(FLY_ACCEL_MPS2, FLY_SPEED_MPS);
  const kVertical = dragFor(FLY_CLIMB_ACCEL_MPS2, FLY_CLIMB_MPS);
  const horizontal = Math.hypot(velocity.east, velocity.north);
  const dragH = kHorizontal * horizontal + FLY_COAST_PER_S;
  const dragV = kVertical * Math.abs(velocity.up) + FLY_COAST_PER_S;
  const accelEast = thrustEast - dragH * velocity.east;
  const accelNorth = thrustNorth - dragH * velocity.north;
  const accelUp = thrustUp - dragV * velocity.up;
  // Semi-implicit drag keeps big steps stable.
  const integrate = (v, thrust, drag) => (v + thrust * dt) / (1 + drag * dt);
  return {
    east: integrate(velocity.east, thrustEast, dragH),
    north: integrate(velocity.north, thrustNorth, dragH),
    up: integrate(velocity.up, thrustUp, dragV),
    accelEast,
    accelNorth,
    accelUp,
  };
}

/**
 * The body's attitude in flight from its motion: lean forward with speed
 * (superhero), less when climbing, more when diving; bank into turns like an
 * aircraft (tan roll = lateral acceleration / g).
 * @returns {{ pitch: number, roll: number }}
 */
export function flightAttitude(velocity, accel, heading, maxLean) {
  const speed = Math.hypot(velocity.east, velocity.north);
  const fullSpeed = clamp(speed / FLY_SPEED_MPS, 0, 1);
  const climb = Math.atan2(velocity.up, Math.max(speed, 1));
  const pitch = clamp(maxLean * fullSpeed - climb * fullSpeed, -0.4, 1.35);
  // Acceleration across the heading (right positive).
  const lateral =
    accel.accelEast * Math.cos(heading) - accel.accelNorth * Math.sin(heading);
  const roll = clamp(Math.atan2(lateral, 9.81), -0.75, 0.75);
  return { pitch, roll };
}

/**
 * Which clip to play in the air, and how fast. With the cape you stride
 * through the air: walk while moving, run when boosting past cruising speed,
 * idle while hovering. On the board you stand still. Strides quicken gently
 * with speed (the legs do not carry you, so they never spin like on foot).
 * @returns {{ role: 'idle'|'walk'|'run', rate: number }}
 */
export function flightClip({ speed, boosting, style }) {
  if (style === 'surf' || speed < 0.8) return { role: 'idle', rate: 1 };
  if (boosting && speed > FLY_SPEED_MPS * 1.2)
    return {
      role: 'run',
      rate: clamp(0.8 + (0.6 * speed) / (FLY_SPEED_MPS * FLY_BOOST), 0.8, 1.4),
    };
  return {
    role: 'walk',
    rate: clamp(0.6 + (0.6 * speed) / FLY_SPEED_MPS, 0.6, 1.3),
  };
}

/**
 * Next flying height: climb or sink at `up` m/s, never below the surface
 * under the avatar (`floor`) and never more than FLY_MAX_ABOVE_GROUND_M
 * above it.
 */
export function flyHeight(height, up, dt, floor) {
  const next = height + up * dt;
  if (!Number.isFinite(floor)) return next;
  return clamp(next, floor, floor + FLY_MAX_ABOVE_GROUND_M);
}

/** Gravity for landing after fly mode, capped like a skydiver. */
const GRAVITY = 9.81;
const FALL_MAX_MPS = 50;

/**
 * One frame of falling toward `ground`. Returns the new height and fall
 * speed; both settle on the ground.
 */
export function fallStep(height, fallSpeed, ground, dt) {
  if (!Number.isFinite(ground) || height <= ground)
    return { height: Number.isFinite(ground) ? ground : height, fallSpeed: 0 };
  const speed = Math.min(FALL_MAX_MPS, fallSpeed + GRAVITY * dt);
  const next = height - speed * dt;
  return next <= ground
    ? { height: ground, fallSpeed: 0 }
    : { height: next, fallSpeed: speed };
}

/** A drop is moved to a road only if one is this close (m). */
export const ROAD_SNAP_MAX_M = 150;

/** `/api/route` request whose zero-length route starts on the nearest road. */
export function roadSnapUrl(lon, lat, profile = 'car') {
  const point = `${lon.toFixed(6)},${lat.toFixed(6)}`;
  return `/api/route?profile=${profile}&coords=${encodeURIComponent(`${point};${point}`)}`;
}

/**
 * The road point from a `/api/route` answer for {@link roadSnapUrl}, or null
 * when there is none within ROAD_SNAP_MAX_M.
 */
export function parseRoadSnap(payload, lon, lat) {
  const first = payload?.ok === true ? payload.geometry?.[0] : null;
  if (!Array.isArray(first) || !first.every(Number.isFinite)) return null;
  const [roadLon, roadLat] = first;
  return localOffset(lon, lat, roadLon, roadLat).distance <= ROAD_SNAP_MAX_M
    ? { lon: roadLon, lat: roadLat }
    : null;
}

/** A drop point this far above the lowest ground nearby is on a building. */
const ROOF_RISE_M = 2.5;
/** Street level: within this of the lowest nearby ground. */
const STREET_TOLERANCE_M = 1;

/**
 * Offline fallback for keeping a drop off buildings: when the drop point is
 * well above the lowest surface around it (a roof), return the nearest
 * street-level sample; otherwise null (stay).
 * @param {number} centreHeight
 * @param {{ lon: number, lat: number, height: number, distance: number }[]} samples
 */
export function streetLevelNear(centreHeight, samples) {
  const usable = samples.filter((sample) => Number.isFinite(sample.height));
  if (!Number.isFinite(centreHeight) || usable.length < 4) return null;
  const lowest = Math.min(...usable.map((sample) => sample.height));
  if (centreHeight - lowest < ROOF_RISE_M) return null;
  return (
    usable
      .filter((sample) => sample.height <= lowest + STREET_TOLERANCE_M)
      .sort((a, b) => a.distance - b.distance)[0] || null
  );
}

/** Points on rings around a drop, nearest first, for {@link streetLevelNear}. */
export function ringAround(
  lon,
  lat,
  radii = [6, 12, 20, 32, 50],
  directions = 12,
) {
  const points = [];
  for (const distance of radii)
    for (let i = 0; i < directions; i++) {
      const bearing = (i / directions) * TWO_PI;
      const point = offsetLonLat(
        lon,
        lat,
        Math.sin(bearing) * distance,
        Math.cos(bearing) * distance,
      );
      points.push({ ...point, distance });
    }
  return points;
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

const MOVE_KEYS = Object.freeze({
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'run',
  ShiftRight: 'run',
  KeyE: 'up',
  KeyQ: 'down',
});

/**
 * What a key event means to Me Mode.
 * `focus` is where the key landed: 'text' (inputs, editable content),
 * 'control' (a focused button, list, slider or tab — arrows stay native
 * there) or 'surface' (the page body or the globe).
 * @returns {{ kind: 'move'|'view'|'exit', role?: string, claim: boolean }|null}
 */
export function keyIntent(event, focus) {
  if (focus === 'text' || event.isComposing) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const down = event.type === 'keydown';
  if (event.code === 'Escape')
    // Exit on the surface only; Escape still reaches dialogs and selections.
    return down && focus === 'surface' ? { kind: 'exit', claim: false } : null;
  const role = MOVE_KEYS[event.code];
  if (role) {
    if (focus === 'control' && event.code.startsWith('Arrow')) return null;
    return { kind: 'move', role, down, claim: true };
  }
  if (event.code === 'KeyV')
    return { kind: 'view', toggle: down && !event.repeat, claim: true };
  if (event.code === 'KeyF')
    return { kind: 'fly', toggle: down && !event.repeat, claim: true };
  if (event.code === 'KeyB')
    return { kind: 'style', toggle: down && !event.repeat, claim: true };
  return null;
}

/**
 * Follow distance that keeps the camera in front of whatever sits between it
 * and the avatar's eye (walls behind, the slope of a hill). `hitDistance` is
 * the first surface along the eye→camera line, or undefined when clear.
 */
export function unoccludedRange(
  wanted,
  hitDistance,
  { margin = 0.3, min = 1 } = {},
) {
  if (!Number.isFinite(hitDistance) || hitDistance >= wanted) return wanted;
  return Math.max(min, hitDistance - margin);
}

/** A camera jump this large is another owner at once (search, teleport). */
export const TAKEOVER_JUMP_M = 50;
/** Smaller outside moves must repeat on this many frames (a flight does;
 *  a one-frame correction does not). */
export const TAKEOVER_STRIKES = 2;

/**
 * Whether an outside camera move means another owner took the camera.
 * @param {{ moved: number, strikes: number }} change `moved` in metres since
 *   Me Mode's last frame; `strikes` counts consecutive frames with a move,
 *   this one included.
 */
export function cameraTakenBy({ moved, strikes }) {
  return moved > TAKEOVER_JUMP_M || strikes >= TAKEOVER_STRIKES;
}

/** Smoothstep easing for the entry flight, t in [0, 1]. */
export function easeInOut(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
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
