import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLIP_MAP,
  HeightSmoother,
  RUN_SPEED_MPS,
  WALK_SPEED_MPS,
  cameraTakenBy,
  clipRateForSpeed,
  clipRoleForSpeed,
  descendToGround,
  describePose,
  fallStep,
  flyHeight,
  flyVelocityFromKeys,
  FLY_BOOST,
  FLY_SPEED_MPS,
  parseRoadSnap,
  ringAround,
  roadSnapUrl,
  streetLevelNear,
  easeInOut,
  followGround,
  keyIntent,
  localOffset,
  offsetLonLat,
  parseAvatarParams,
  resolveClipMap,
  turnToward,
  unoccludedRange,
  velocityFromKeys,
} from './model.js';

const NO_KEYS = {
  forward: false,
  back: false,
  left: false,
  right: false,
  run: false,
};

test('avatar URL options accept same-origin root-relative models only', () => {
  assert.deepEqual(
    parseAvatarParams('?avatar=/avatars/said.glb&clips=idle:Stand,run:Sprint'),
    {
      url: '/avatars/said.glb',
      clips: { idle: 'Stand', run: 'Sprint' },
      headingOffset: null,
    },
  );

  for (const rejected of [
    '?avatar=javascript:alert(1)',
    '?avatar=//evil.example/a.glb',
    '?avatar=http://example.org/a.glb',
    '?avatar=https://example.org/a.glb',
    '?avatar=/\\evil.example/a.glb',
    '?avatar=/avatars/notes.txt',
  ])
    assert.equal(parseAvatarParams(rejected).url, null, rejected);
  assert.equal(parseAvatarParams('').clips, null);
  assert.equal(
    parseAvatarParams('?avatarHeading=90').headingOffset,
    Math.PI / 2,
  );
});

test('clip map falls back by role when a model lacks clips', () => {
  assert.deepEqual(
    resolveClipMap(['Idle', 'Run', 'TPose', 'Walk'], DEFAULT_CLIP_MAP),
    DEFAULT_CLIP_MAP,
  );
  // Case-insensitive match and role guessing for differently named rigs.
  assert.deepEqual(
    resolveClipMap(['mixamo_idle', 'Walking'], DEFAULT_CLIP_MAP),
    { idle: 'mixamo_idle', walk: 'Walking', run: 'Walking' },
  );
  // A one-clip model uses that clip for every role, never the T-pose.
  assert.deepEqual(resolveClipMap(['T-Pose', 'Swing'], DEFAULT_CLIP_MAP), {
    idle: 'Swing',
    walk: 'Swing',
    run: 'Swing',
  });
  assert.deepEqual(resolveClipMap([], DEFAULT_CLIP_MAP), {
    idle: null,
    walk: null,
    run: null,
  });
  assert.equal(
    resolveClipMap(['a', 'b', 'c'], { idle: 'a', walk: 'b', run: 'c' }).run,
    'c',
  );
});

test('movement is relative to the camera heading', () => {
  assert.equal(velocityFromKeys(NO_KEYS, 0).speed, 0);
  const north = velocityFromKeys({ ...NO_KEYS, forward: true }, 0);
  assert.ok(Math.abs(north.north - WALK_SPEED_MPS) < 1e-9);
  assert.ok(Math.abs(north.east) < 1e-9);
  // Camera facing east, strafe left → north; Shift runs.
  const left = velocityFromKeys(
    { ...NO_KEYS, left: true, run: true },
    Math.PI / 2,
  );
  assert.ok(Math.abs(left.north - RUN_SPEED_MPS) < 1e-9);
  assert.ok(Math.abs(left.east) < 1e-9);
  assert.equal(clipRoleForSpeed(0), 'idle');
  assert.equal(clipRoleForSpeed(WALK_SPEED_MPS), 'walk');
  assert.equal(clipRoleForSpeed(RUN_SPEED_MPS), 'run');
});

test('local offsets round-trip at Kings Cross', () => {
  const start = { lon: -0.1238, lat: 51.5308 };
  const moved = offsetLonLat(start.lon, start.lat, 60, 80);
  const back = localOffset(start.lon, start.lat, moved.lon, moved.lat);
  assert.ok(Math.abs(back.distance - 100) < 0.05, `${back.distance}`);
  assert.ok(Math.abs(back.east - 60) < 0.05);
  assert.ok(Math.abs(back.bearing - Math.atan2(60, 80)) < 1e-4);
  // Wrapping across the antimeridian stays local.
  assert.ok(localOffset(179.9999, 0, -179.9999, 0).distance < 30);
});

test('turnToward takes the short way round', () => {
  assert.ok(Math.abs(turnToward(0.1, 2 * Math.PI - 0.1, 0.05) - 0.05) < 1e-9);
  assert.equal(turnToward(1, 1.02, 0.5), 1.02);
});

test('height smoother averages LOD pops and resets on real jumps', () => {
  const smoother = new HeightSmoother({ window: 5, resetJumpM: 4 });
  assert.equal(smoother.value, null);
  smoother.reset(50);
  for (const h of [50.4, 49.6, undefined, 50.2, 49.8]) smoother.push(h);
  assert.ok(Math.abs(smoother.value - 50) < 0.01);
  // A miss keeps the last good height.
  assert.ok(Math.abs(smoother.push(NaN) - 50) < 0.01);
  // Teleport-scale jump restarts the window instead of gliding.
  assert.equal(smoother.push(80), 80);
});

/** A street with a tree canopy (6–9 m) over ground at 20 m. */
function streetUnderTree() {
  const surfaces = [29, 26, 20]; // canopy top, canopy underside, ground
  return (from) => surfaces.find((h) => h < from);
}

test('walking under a canopy follows the ground, not the treetop', () => {
  const castDown = streetUnderTree();
  const topDown = () => 29;
  assert.equal(followGround(castDown, 20, topDown), 20);
  // Curbs and steps up to STEP_UP_M are climbed.
  assert.equal(
    followGround((from) => (from > 21 ? 21 : undefined), 20, topDown),
    21,
  );
  // Probe starting inside geometry finds nothing: fall back to top-down.
  assert.equal(
    followGround(() => undefined, 20, topDown),
    29,
  );
  assert.equal(followGround(castDown, undefined, topDown), 29);
});

test('placement descends through canopy to the ground', async () => {
  const castDown = streetUnderTree();
  assert.equal(await descendToGround(async (from) => castDown(from), 29), 20);
  // A roof with nothing under it stays the answer.
  assert.equal(await descendToGround(async () => undefined, 45), 45);
  // A probe that reports a surface at or above the start never loops.
  assert.equal(await descendToGround(async () => 50, 45), 45);
});

test('voice pose is plain JSON with a compass word', () => {
  assert.deepEqual(
    describePose({
      lon: -73.98551234567,
      lat: 40.758,
      height: 12.3456,
      heading: Math.PI / 2,
      speed: 0,
      view: 'third-person',
    }),
    {
      longitude: -73.985512,
      latitude: 40.758,
      heightM: 12.35,
      headingDeg: 90,
      facing: 'east',
      speedMps: 0,
      view: 'third-person',
    },
  );
});

test('keys: text fields and modifiers are left alone, controls keep arrows', () => {
  const key = (code, extra = {}) => ({ code, type: 'keydown', ...extra });
  assert.equal(keyIntent(key('KeyW'), 'text'), null);
  assert.equal(keyIntent(key('KeyW', { ctrlKey: true }), 'surface'), null);
  assert.equal(keyIntent(key('ArrowUp'), 'control'), null);
  assert.deepEqual(keyIntent(key('KeyW'), 'control'), {
    kind: 'move',
    role: 'forward',
    down: true,
    claim: true,
  });
  assert.equal(keyIntent(key('ArrowLeft'), 'surface').role, 'left');
  assert.equal(
    keyIntent({ code: 'ShiftLeft', type: 'keyup' }, 'surface').down,
    false,
  );
  assert.equal(
    keyIntent(key('KeyV', { repeat: true }), 'surface').toggle,
    false,
  );
  assert.equal(keyIntent(key('KeyZ'), 'surface'), null);
});

test('keys: Escape exits from the globe but not from panels', () => {
  assert.deepEqual(keyIntent({ code: 'Escape', type: 'keydown' }, 'surface'), {
    kind: 'exit',
    claim: false,
  });
  assert.equal(keyIntent({ code: 'Escape', type: 'keydown' }, 'control'), null);
  assert.equal(keyIntent({ code: 'Escape', type: 'keyup' }, 'surface'), null);
});

test('follow camera pulls in front of walls and slopes', () => {
  assert.equal(unoccludedRange(6, undefined), 6);
  assert.equal(unoccludedRange(6, 9), 6);
  assert.equal(unoccludedRange(6, 3), 2.7);
  assert.equal(unoccludedRange(6, 0.5), 1);
});

test('entry easing is smooth and clamped', () => {
  assert.equal(easeInOut(-1), 0);
  assert.equal(easeInOut(0.5), 0.5);
  assert.equal(easeInOut(2), 1);
});

test('camera hand-off ignores one-frame nudges but not flights or jumps', () => {
  // Cesium's collision push or any one-off correction: overwritten, kept.
  assert.equal(cameraTakenBy({ moved: 2, strikes: 1 }), false);
  // A flight moves the camera every frame.
  assert.equal(cameraTakenBy({ moved: 2, strikes: 2 }), true);
  // A search or setView jump is another owner at once.
  assert.equal(cameraTakenBy({ moved: 2000, strikes: 1 }), true);
});

test('speeds: walk 2× and run 4× a person, clips capped', () => {
  assert.equal(WALK_SPEED_MPS, 2.8);
  assert.equal(RUN_SPEED_MPS, 16);
  assert.equal(clipRoleForSpeed(WALK_SPEED_MPS), 'walk');
  assert.equal(clipRoleForSpeed(RUN_SPEED_MPS), 'run');
  assert.equal(clipRateForSpeed('walk', WALK_SPEED_MPS), 2);
  assert.equal(clipRateForSpeed('run', RUN_SPEED_MPS), 2.5);
});

test('fly: WASD across the camera heading, E/Q climb, Shift boosts', () => {
  const none = { forward: false, back: false, left: false, right: false };
  const hover = flyVelocityFromKeys({ ...none, up: true }, 0);
  assert.equal(hover.speed, 0);
  assert.ok(hover.up > 0);
  const boosted = flyVelocityFromKeys(
    { ...none, forward: true, down: true, run: true },
    Math.PI / 2,
  );
  assert.ok(Math.abs(boosted.east - FLY_SPEED_MPS * FLY_BOOST) < 1e-9);
  assert.ok(boosted.up < 0);
  // Never below the floor, never far above it.
  assert.equal(flyHeight(10, -100, 1, 5), 5);
  assert.equal(flyHeight(10, 3, 1, 0), 13);
  assert.equal(flyHeight(10, 1e6, 1, 0), 3000);
});

test('landing falls under gravity and settles on the ground', () => {
  let state = { height: 100, fallSpeed: 0 };
  let frames = 0;
  while (state.height > 20 && frames++ < 1000)
    state = fallStep(state.height, state.fallSpeed, 20, 0.05);
  assert.equal(state.height, 20);
  assert.equal(state.fallSpeed, 0);
  assert.ok(frames > 10, 'it falls, it does not teleport');
});

test('road snap uses a zero-length route and rejects far roads', () => {
  assert.match(
    roadSnapUrl(-0.1238, 51.5308),
    /profile=car&coords=-0\.123800%2C51\.530800%3B-0\.123800%2C51\.530800/,
  );
  assert.deepEqual(
    parseRoadSnap(
      {
        ok: true,
        geometry: [
          [-0.1239, 51.5309],
          [-0.1239, 51.5309],
        ],
      },
      -0.1238,
      51.5308,
    ),
    { lon: -0.1239, lat: 51.5309 },
  );
  assert.equal(
    parseRoadSnap({ ok: true, geometry: [[-0.13, 51.54]] }, -0.1238, 51.5308),
    null,
  );
  assert.equal(parseRoadSnap({ ok: false }, 0, 0), null);
});

test('a drop on a roof moves to the nearest street-level point', () => {
  const ring = ringAround(0, 0, [6, 12], 4).map((point, index) => ({
    ...point,
    // Building to the north and east; street to the south and west.
    height: index % 4 >= 2 ? 20 : 45,
  }));
  const street = streetLevelNear(45, ring);
  assert.equal(street.height, 20);
  assert.equal(street.distance, 6);
  // Already at street level, or on gentle slopes: stay.
  assert.equal(streetLevelNear(20.5, ring), null);
  assert.equal(streetLevelNear(45, ring.slice(0, 2)), null);
});

test('keys: B switches the fly style', () => {
  assert.deepEqual(keyIntent({ code: 'KeyB', type: 'keydown' }, 'surface'), {
    kind: 'style',
    toggle: true,
    claim: true,
  });
});
