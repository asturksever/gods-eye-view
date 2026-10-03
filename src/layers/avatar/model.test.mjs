import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CLIP_MAP,
  HeightSmoother,
  RUN_SPEED_MPS,
  WALK_SPEED_MPS,
  clipRoleForSpeed,
  describePose,
  localOffset,
  offsetLonLat,
  parseAvatarParams,
  resolveClipMap,
  turnToward,
  velocityFromKeys,
} from './model.js';

const NO_KEYS = {
  forward: false,
  back: false,
  left: false,
  right: false,
  run: false,
};

test('avatar URL options accept root-relative and https models only', () => {
  assert.deepEqual(
    parseAvatarParams('?avatar=/avatars/said.glb&clips=idle:Stand,run:Sprint'),
    {
      url: '/avatars/said.glb',
      clips: { idle: 'Stand', run: 'Sprint' },
      headingOffset: null,
    },
  );
  assert.equal(
    parseAvatarParams('?avatar=https://example.org/a.glb').url,
    'https://example.org/a.glb',
  );
  for (const rejected of [
    '?avatar=javascript:alert(1)',
    '?avatar=//evil.example/a.glb',
    '?avatar=http://example.org/a.glb',
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
