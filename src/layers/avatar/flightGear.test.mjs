import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD,
  CAPE,
  boardLayout,
  bodyFrame,
  capeLayout,
} from './flightGear.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) < tolerance;

test('body frame tips forward with the lean', () => {
  const upright = bodyFrame(0, 0);
  assert.deepEqual(upright.bodyUp, [0, 0, 1]);
  const leaning = bodyFrame(0, Math.PI / 4);
  // Facing north: the head moves north and the chest points down-north.
  assert.ok(leaning.bodyUp[1] > 0.7 && leaning.bodyUp[2] > 0.7);
  assert.ok(leaning.bodyForward[2] < 0);
});

test('cape hangs down the back when hovering', () => {
  const segments = capeLayout({ heading: 0, lean: 0, speedRatio: 0, time: 0 });
  assert.equal(segments.length, CAPE.segments);
  const top = segments[0];
  // Attached near the shoulders, just behind the body (south when facing north).
  assert.ok(top.centre[2] > 1.1 && top.centre[2] < CAPE.shoulderHeight);
  assert.ok(top.centre[1] < 0);
  // Every segment points mostly down.
  for (const segment of segments) assert.ok(segment.along[2] < -0.7);
  // Axes are orthonormal.
  for (const { right, along, normal } of segments) {
    assert.ok(close(dot(right, along), 0));
    assert.ok(close(dot(along, normal), 0));
    assert.ok(close(Math.hypot(...normal), 1));
  }
});

test('cape streams out behind at speed, never up into the sky', () => {
  const segments = capeLayout({
    heading: 0,
    lean: 0.9,
    speedRatio: 1,
    time: 0,
  });
  // Facing and flying north: the cape trails south (against the motion),
  // close to horizontal.
  for (const { along } of segments) {
    assert.ok(along[1] < -0.85, `along ${along}`);
    assert.ok(along[2] < 0.35, `along ${along}`);
  }
  const tip = segments.at(-1).centre;
  assert.ok(tip[1] < segments[0].centre[1] - 0.8);
});

test('cape flutters over time', () => {
  const at = (time) =>
    capeLayout({ heading: 0, lean: 0.9, speedRatio: 1, time }).at(-1).centre;
  assert.notDeepEqual(at(0), at(0.2));
});

test('board lies flat under the feet along the heading', () => {
  const board = boardLayout({ heading: Math.PI / 2 });
  assert.deepEqual(board.normal, [0, 0, 1]);
  assert.ok(close(board.along[0], 1)); // facing east
  assert.equal(board.centre[2], -BOARD.thickness / 2);
});
