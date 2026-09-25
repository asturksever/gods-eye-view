import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapillaryImageUrl,
  presentMapillaryPanel,
} from './mapillaryPresentation.js';

function snapshot(overrides = {}) {
  const base = {
    enabled: false,
    keyRequired: false,
    coverage: {
      zoom: null,
      kind: null,
      filter: { pano: 'all', sinceMs: null },
      legend: [
        { key: 'recent', label: 'Recent (≤2 yr)', color: '#05cb63' },
        { key: 'older', label: 'Older', color: '#2e7d5b' },
        { key: 'pano', label: '360°', color: '#ff4fd8' },
        { key: 'selected', label: 'Selected', color: '#00d4ff' },
      ],
      loading: false,
      sequences: 0,
      hint: '',
      error: null,
    },
    sequence: { selectedId: null, images: 0, loading: false },
    street: {
      open: false,
      follow: false,
      loading: false,
      error: null,
      imageId: null,
      position: null,
      bearing: null,
      isPano: false,
      capturedAt: null,
      sequenceId: null,
      creator: null,
      renderMode: 'letterbox',
    },
  };
  return deepMerge(base, overrides);
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === 'object'
        ? deepMerge(target[key], value)
        : value;
  }
  return out;
}

test('a missing Mapillary token gates every control and flags KEY REQUIRED', () => {
  const view = presentMapillaryPanel(snapshot({ keyRequired: true }));
  assert.equal(view.controlsDisabled, true);
  assert.deepEqual(view.status, { text: 'KEY REQUIRED', tone: 'warn' });
});

test('status reads LOADING while coverage streams, then ON or OFF', () => {
  assert.deepEqual(presentMapillaryPanel(snapshot()).status, {
    text: 'OFF',
    tone: '',
  });
  assert.deepEqual(
    presentMapillaryPanel(
      snapshot({ enabled: true, coverage: { loading: true } }),
    ).status,
    { text: 'LOADING', tone: 'busy' },
  );
  assert.deepEqual(presentMapillaryPanel(snapshot({ enabled: true })).status, {
    text: 'ON',
    tone: 'on',
  });
});

test('errors from the viewer or the coverage web surface in one alert', () => {
  assert.equal(presentMapillaryPanel(snapshot()).error, null);
  assert.equal(
    presentMapillaryPanel(
      snapshot({ street: { error: 'Image could not be opened' } }),
    ).error,
    'Image could not be opened',
  );
  assert.equal(
    presentMapillaryPanel(snapshot({ coverage: { error: 'Tile HTTP 502' } }))
      .error,
    'Tile HTTP 502',
  );
});

test('legend passes through in the layer’s order', () => {
  const view = presentMapillaryPanel(snapshot());
  assert.deepEqual(
    view.legend.map((entry) => entry.key),
    ['recent', 'older', 'pano', 'selected'],
  );
});

test('the meta line never mixes the visible-sequence count with the selected sequence', () => {
  assert.equal(presentMapillaryPanel(snapshot()).meta, '');
  const browsing = presentMapillaryPanel(
    snapshot({ enabled: true, coverage: { zoom: 14, sequences: 812 } }),
  );
  assert.match(browsing.meta, /^812 sequences in view · click a line/);
  const selected = presentMapillaryPanel(
    snapshot({
      enabled: true,
      coverage: { zoom: 14, sequences: 812 },
      sequence: { selectedId: 'abc', images: 33 },
    }),
  );
  assert.equal(selected.meta, '33 images in this sequence · Esc clears');
  assert.doesNotMatch(selected.meta, /sequences in view/);
  const hinted = presentMapillaryPanel(
    snapshot({
      enabled: true,
      coverage: { hint: 'Point the camera at the globe' },
    }),
  );
  assert.equal(hinted.meta, 'Point the camera at the globe');
});

test('viewer caption reads "Image by" left and date right, with a deep link', () => {
  const view = presentMapillaryPanel(
    snapshot({
      enabled: true,
      street: {
        open: true,
        imageId: '1814275685699406',
        creator: 'mapfool',
        capturedAt: Date.UTC(2023, 9, 8),
        bearing: 93.4,
        isPano: true,
      },
    }),
  );
  assert.equal(view.viewer.captionLeft, 'Image by mapfool');
  assert.equal(view.viewer.captionRight, '360° · 93° · 2023-10-08');
  assert.equal(
    view.viewer.link,
    'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
  );
  assert.equal(view.viewer.follow.disabled, false);
  assert.equal(view.wantsOpen, true);
});

test('an image without a creator name leaves the left caption empty', () => {
  const view = presentMapillaryPanel(
    snapshot({
      street: { open: true, imageId: '1', capturedAt: Date.UTC(2024, 0, 2) },
    }),
  );
  assert.equal(view.viewer.captionLeft, '');
  assert.equal(view.viewer.captionRight, '2024-01-02');
});

test('image deep links match the mapillary.com share format', () => {
  assert.equal(
    mapillaryImageUrl(1814275685699406),
    'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
  );
  assert.equal(mapillaryImageUrl('  '), 'https://www.mapillary.com/app/');
});
