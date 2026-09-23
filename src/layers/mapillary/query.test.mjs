import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bboxFromGeocode,
  enforceMinimumSpan,
  fitBboxToTileBudget,
  summarizeResults,
} from './query.js';
import { countTilesForBbox } from './tileMath.js';

test('bboxFromGeocode prefers bounds and falls back to a point box', () => {
  const withBounds = bboxFromGeocode({
    geometry: {
      location: { lat: 38.58, lng: -121.49 },
      bounds: {
        southwest: { lat: 38.44, lng: -121.56 },
        northeast: { lat: 38.69, lng: -121.36 },
      },
    },
    formatted_address: 'Sacramento, California',
  });
  assert.deepEqual(withBounds.bbox, [-121.56, 38.44, -121.36, 38.69]);
  assert.equal(withBounds.label, 'Sacramento, California');
  const point = bboxFromGeocode({
    geometry: { location: { lat: 42.33, lng: -83.05 } },
  });
  assert.ok(point.bbox[0] < -83.05 && point.bbox[2] > -83.05);
  assert.equal(bboxFromGeocode(null), null);
});

test('fitBboxToTileBudget shrinks an oversized box around its centre', () => {
  const california = [-125, 32, -114, 42];
  const fitted = fitBboxToTileBudget(california, 600);
  assert.ok(countTilesForBbox(fitted, 14) <= 600);
  const cx = (fitted[0] + fitted[2]) / 2;
  assert.ok(Math.abs(cx - -119.5) < 1e-6);
  const small = [-121.5, 38.5, -121.4, 38.6];
  assert.deepEqual(fitBboxToTileBudget(small, 600), small);
});

test('summarizeResults reports totals, top classes and the sighting window', () => {
  const text = summarizeResults({
    total: 1234,
    counts: new Map([
      ['object--fire-hydrant', 1000],
      ['object--bench', 200],
      ['object--mailbox', 20],
      ['object--trash-can', 14],
    ]),
    earliest: Date.UTC(2019, 0, 1),
    latest: Date.UTC(2026, 5, 1),
    truncated: true,
    failed: 2,
  });
  assert.match(
    text,
    /^1,234 features: 1,000 fire hydrant, 200 bench, 20 mailbox and 1 more classes/,
  );
  assert.match(text, /seen 2019–2026 · capped · 2 tiles failed$/);
  assert.equal(
    summarizeResults({ total: 0, counts: new Map() }),
    'No matching features in this area.',
  );
});

test('node-sized geocode bounds are grown to a queryable neighbourhood box', () => {
  const tiny = bboxFromGeocode({
    geometry: {
      location: { lat: 42.3292, lng: -83.0527 },
      bounds: {
        southwest: { lat: 42.329, lng: -83.053 },
        northeast: { lat: 42.3294, lng: -83.0524 },
      },
    },
  });
  assert.ok(tiny.bbox[2] - tiny.bbox[0] >= 0.01 - 1e-9);
  assert.ok(tiny.bbox[3] - tiny.bbox[1] >= 0.01 - 1e-9);
  assert.deepEqual(enforceMinimumSpan([0, 0, 1, 1], 0.5), [0, 0, 1, 1]);
});
