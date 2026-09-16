import assert from 'node:assert/strict';
import test from 'node:test';
import { mapillaryImageUrl } from './mapillaryControls.js';

test('image deep links match the mapillary.com share format', () => {
  assert.equal(
    mapillaryImageUrl('1814275685699406'),
    'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
  );
  assert.equal(
    mapillaryImageUrl(1814275685699406),
    mapillaryImageUrl('1814275685699406'),
  );
});

test('a missing image id falls back to the app root', () => {
  assert.equal(mapillaryImageUrl(null), 'https://www.mapillary.com/app/');
  assert.equal(mapillaryImageUrl('  '), 'https://www.mapillary.com/app/');
});
