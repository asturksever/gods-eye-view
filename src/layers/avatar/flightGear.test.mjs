import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD, CAPE, boardLayout, bodyFrame, capeRig } from './flightGear.js';

const close = (a, b, tolerance = 1e-9) => Math.abs(a - b) < tolerance;

test('body frame tips forward with the lean', () => {
  const upright = bodyFrame(0, 0);
  assert.deepEqual(upright.bodyUp, [0, 0, 1]);
  const leaning = bodyFrame(0, Math.PI / 4);
  // Facing north: the head moves north and the chest points down-north.
  assert.ok(leaning.bodyUp[1] > 0.7 && leaning.bodyUp[2] > 0.7);
  assert.ok(leaning.bodyForward[2] < 0);
});

test('a bank tips the head towards the turn', () => {
  // Facing north, banking right: the head moves east.
  const banked = bodyFrame(0, 0, 0.5);
  assert.ok(banked.bodyUp[0] > 0.4);
  assert.ok(close(Math.hypot(...banked.bodyUp), 1));
  assert.ok(close(Math.hypot(...banked.right), 1));
});

test('cape is pinned across the shoulders, behind the body', () => {
  const { anchors, colliders } = capeRig({ heading: 0, lean: 0 });
  assert.equal(anchors.length, CAPE.cols);
  for (const [, north, up] of anchors) {
    assert.ok(north < 0, 'behind (south of) a north-facing body');
    assert.ok(up > 1.3 && up < 1.5);
  }
  const span = anchors.at(-1)[0] - anchors[0][0];
  assert.ok(close(span, CAPE.topWidth, 1e-6));
  assert.equal(colliders.length, 3);
});

test('board lies flat under the feet along the heading, and carves', () => {
  const board = boardLayout({ heading: Math.PI / 2 });
  assert.ok(close(board.normal[2], 1));
  assert.ok(close(board.along[0], 1)); // facing east
  assert.ok(close(board.centre[2], -BOARD.thickness / 2));
  const carving = boardLayout({ heading: 0, roll: 0.4 });
  assert.ok(carving.normal[0] > 0.3, 'tips towards the turn');
});
