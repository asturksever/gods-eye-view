import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { visibleBbox } from './view.js';
import { tilesForBbox } from './tileMath.js';

// Complements @gekh's earlier date-line review: these are synthetic
// near-camera corners, not Cartesian ray hits on both sides of the meridian.
function skyFacingViewer(lon) {
  return {
    scene: {
      canvas: { clientWidth: 1200, clientHeight: 800 },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(lon, 0, 10),
      // Looking above the horizon: the near-camera neighborhood still counts.
      pickEllipsoid: () => undefined,
      computeViewRectangle: () => undefined,
    },
  };
}

const options = { nearRange: 1000, maxRange: 2500 };

for (const lon of [179.999, -179.999]) {
  test(`near-camera coverage crosses the date line from ${lon}`, () => {
    const bbox = visibleBbox(skyFacingViewer(lon), options);
    assert.ok(bbox, 'the near-camera neighborhood has bounds');
    const { tiles } = tilesForBbox(bbox, 14, { limit: 24 });
    const columns = new Set(tiles.map(({ x }) => x));
    assert.ok(columns.has(0), 'coverage includes the westernmost tile column');
    assert.ok(
      columns.has(2 ** 14 - 1),
      'coverage includes the easternmost tile column',
    );
    assert.ok(bbox[0] > bbox[2], 'the bbox uses the date-line crossing form');
  });
}

test('ordinary near-camera bounds stay on their local side of the globe', () => {
  const bbox = visibleBbox(skyFacingViewer(10), options);
  assert.ok(bbox);
  assert.ok(bbox[0] < 10 && bbox[2] > 10);
  assert.ok(bbox[0] < bbox[2]);
  const { tiles } = tilesForBbox(bbox, 14, { limit: 24 });
  assert.ok(tiles.length > 0);
  assert.ok(tiles.every(({ x }) => x !== 0 && x !== 2 ** 14 - 1));
});
