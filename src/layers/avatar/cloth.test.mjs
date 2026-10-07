import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloth, stepCloth } from './cloth.js';
import { CAPE, capeRig } from './flightGear.js';

const rows = (cloth) => {
  const { cols, pos } = cloth;
  const bottom = [];
  for (let c = 0; c < cols; c++) {
    const i = ((cloth.rows - 1) * cols + c) * 3;
    bottom.push([pos[i], pos[i + 1], pos[i + 2]]);
  }
  return bottom;
};
const mean = (points, k) =>
  points.reduce((sum, p) => sum + p[k], 0) / points.length;
const maxStretch = (cloth) => {
  let worst = 0;
  for (const [a, b, rest] of cloth.links) {
    const d = Math.hypot(
      cloth.pos[a * 3] - cloth.pos[b * 3],
      cloth.pos[a * 3 + 1] - cloth.pos[b * 3 + 1],
      cloth.pos[a * 3 + 2] - cloth.pos[b * 3 + 2],
    );
    worst = Math.max(worst, d / rest);
  }
  return worst;
};

/** Fly north at `speed` for `seconds`, 60 fps. */
function fly(speed, seconds, pose = { heading: 0, lean: 0 }) {
  const cloth = createCloth(CAPE);
  const rig = capeRig(pose);
  for (let t = 0; t < seconds; t += 1 / 60) {
    // The feet moved north: the cloth, in the feet' frame, moves south.
    stepCloth(
      cloth,
      { anchors: rig.anchors, colliders: rig.colliders, shift: [0, -speed / 60, 0] },
      1 / 60,
    );
  }
  return cloth;
}

test('at rest the cape hangs down the back under gravity', () => {
  const cloth = fly(0, 3);
  const hem = rows(cloth);
  assert.ok(mean(hem, 2) < CAPE.shoulderHeight - 1.0, `hem z ${mean(hem, 2)}`);
  assert.ok(mean(hem, 1) < 0.05, 'not in front of the body');
  assert.ok(maxStretch(cloth) < 1.1);
});

test('in fast flight it streams out behind and stays in one piece', () => {
  const pose = { heading: 0, lean: 0.9 };
  const cloth = fly(15, 4, pose);
  const hem = rows(cloth);
  const shoulders = capeRig(pose).anchors;
  // Flying north: the hem trails well south of the shoulders, held up by
  // the air rather than hanging straight down.
  const behind = mean(shoulders, 1) - mean(hem, 1);
  const drop = mean(shoulders, 2) - mean(hem, 2);
  assert.ok(behind > 0.9, `hem behind ${behind}`);
  assert.ok(drop < 0.8, `hem drop ${drop}`);
  assert.ok(maxStretch(cloth) < 1.25, `stretch ${maxStretch(cloth)}`);
});

test('boost speed does not blow the simulation up', () => {
  const cloth = fly(60, 3, { heading: 0, lean: 0.9 });
  for (const v of cloth.pos) assert.ok(Number.isFinite(v));
  assert.ok(maxStretch(cloth) < 1.4, `stretch ${maxStretch(cloth)}`);
});

test('it flutters: the hem keeps moving in steady flight', () => {
  const cloth = createCloth(CAPE);
  const rig = capeRig({ heading: 0, lean: 0.9 });
  const wind = (t) => [0.8 * Math.sin(t * 3), 0, 0.5 * Math.sin(t * 5)];
  const hemAt = () => rows(cloth).map((p) => p.slice());
  let before;
  for (let i = 0; i < 300; i++) {
    stepCloth(
      cloth,
      { anchors: rig.anchors, colliders: rig.colliders, wind, shift: [0, -15 / 60, 0] },
      1 / 60,
    );
    if (i === 270) before = hemAt();
  }
  const after = hemAt();
  const moved = Math.max(
    ...after.map((p, i) => Math.hypot(p[0] - before[i][0], p[1] - before[i][1], p[2] - before[i][2])),
  );
  assert.ok(moved > 0.01, `hem moved ${moved}`);
});

test('a slow frame (4 fps) keeps the cape attached', () => {
  const cloth = createCloth(CAPE);
  const rig = capeRig({ heading: 0, lean: 0.9 });
  for (let i = 0; i < 20; i++)
    stepCloth(
      cloth,
      { anchors: rig.anchors, colliders: rig.colliders, shift: [0, -15 * 0.25, 0] },
      0.25,
    );
  assert.ok(maxStretch(cloth) < 1.3, `stretch ${maxStretch(cloth)}`);
});
