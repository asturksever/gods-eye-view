import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeDetectionPolygons } from './decode.js';

// A real detection geometry from graph.mapillary.com (construction--barrier--curb).
const SAMPLE =
  'Gjp4AgoGbXB5LW9yKIAgEisYAwgBIiUJzi+gKHoACAMAAwADAAMAAwADAAMAAAcEAAQABAAEAAQABAAP';

test('a detection geometry decodes into a closed, normalized polygon', () => {
  const polygons = decodeDetectionPolygons(SAMPLE);
  assert.equal(polygons.length, 1);
  const ring = polygons[0];
  assert.ok(ring.length >= 4);
  for (const [x, y] of ring) {
    assert.ok(x >= 0 && x <= 1, `x in range: ${x}`);
    assert.ok(y >= 0 && y <= 1, `y in range: ${y}`);
  }
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(Math.abs(ring[0][0] - 3047 / 4096) < 1e-9);
});

test('garbage input yields no polygons instead of throwing', () => {
  assert.deepEqual(decodeDetectionPolygons('not base64!!'), []);
  assert.deepEqual(decodeDetectionPolygons(''), []);
});
