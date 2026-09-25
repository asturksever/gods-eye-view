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
    planner: true,
    plannerModel: 'claude-opus-5',
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
    features: {
      total: 0,
      title: '',
      loading: false,
      progress: { done: 0, tiles: 0 },
      counts: [],
      truncated: false,
      failed: 0,
      iconMode: false,
      hasBbox: false,
      selectedId: null,
      bbox: null,
    },
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
      feature: null,
      highlight: null,
    },
    query: {
      busy: false,
      stage: 'idle',
      prompt: '',
      place: null,
      answer: '',
      error: null,
      title: '',
      usage: null,
      history: [],
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

test('without an Anthropic key the query box explains itself and stays disabled', () => {
  const view = presentMapillaryPanel(
    snapshot({ planner: false, enabled: true }),
  );
  assert.equal(view.query.inputDisabled, true);
  assert.equal(view.query.suggestionsDisabled, true);
  assert.equal(view.query.hintWarn, true);
  assert.match(view.query.hint, /Anthropic key/);
  assert.ok(view.query.placeholder.length < 40, 'placeholder fits the field');
  assert.equal(view.controlsDisabled, false);
});

test('before the status call answers the query box does not claim a missing key', () => {
  const view = presentMapillaryPanel(snapshot({ planner: null }));
  assert.equal(view.query.inputDisabled, false);
  assert.equal(view.query.hintWarn, false);
  assert.doesNotMatch(view.query.placeholder, /Anthropic/);
});

test('a running query turns ASK into STOP and shows indeterminate progress per stage', () => {
  const planning = presentMapillaryPanel(
    snapshot({ enabled: true, query: { busy: true, stage: 'planning' } }),
  );
  assert.equal(planning.query.submitLabel, 'STOP');
  assert.equal(planning.query.submitIsStop, true);
  assert.deepEqual(planning.progress, {
    visible: true,
    indeterminate: true,
    percent: 0,
    label: 'Planning…',
  });
  assert.equal(planning.status.text, 'AI · PLANNING');

  const resolving = presentMapillaryPanel(
    snapshot({
      enabled: true,
      query: { busy: true, stage: 'resolving', place: 'Sacramento, CA' },
    }),
  );
  assert.equal(resolving.progress.label, 'Finding Sacramento, CA…');

  const fetching = presentMapillaryPanel(
    snapshot({
      enabled: true,
      query: { busy: true, stage: 'fetching' },
      features: { loading: true, progress: { done: 3, tiles: 12 }, total: 410 },
    }),
  );
  assert.equal(fetching.progress.indeterminate, false);
  assert.equal(fetching.progress.percent, 25);
  assert.equal(fetching.progress.label, '3/12 tiles · 410 found');
});

test('idle copy depends on whether the layer is on', () => {
  assert.match(
    presentMapillaryPanel(snapshot()).answer,
    /Turn on Street Level/,
  );
  assert.match(
    presentMapillaryPanel(snapshot({ enabled: true })).answer,
    /Click a green line/,
  );
  const view = presentMapillaryPanel(
    snapshot({ enabled: true, query: { error: 'Planner unavailable' } }),
  );
  assert.equal(view.error, 'Planner unavailable');
  assert.equal(view.answer, '');
});

test('result chips cap at eight and describe the overflow', () => {
  const counts = Array.from({ length: 11 }, (_, i) => ({
    value: `object--v${i}`,
    label: `Class ${i}`,
    color: '#fff',
    count: 100 - i,
  }));
  const view = presentMapillaryPanel(
    snapshot({ enabled: true, features: { total: 900, counts } }),
  );
  assert.equal(view.results.visible, true);
  assert.equal(view.results.chips.length, 8);
  assert.equal(view.results.more.count, 3);
  assert.match(view.results.more.title, /Class 8 92, Class 9 91, Class 10 90/);
  assert.equal(view.results.all.length, 11);
});

test('legend passes through in the layer’s order', () => {
  const view = presentMapillaryPanel(snapshot());
  assert.deepEqual(
    view.legend.map((entry) => entry.key),
    ['recent', 'older', 'pano', 'selected'],
  );
});

test('the meta line never mixes the visible-sequence count with the selected sequence', () => {
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
        feature: { label: 'Fire hydrant', imageCount: 5 },
        highlight: { count: 2 },
      },
    }),
  );
  assert.equal(
    view.viewer.captionLeft,
    'Fire hydrant · 5 sightings · 2 detections outlined · Image by mapfool',
  );
  assert.equal(view.viewer.captionRight, '360° · 93° · 2023-10-08');
  assert.equal(
    view.viewer.link,
    'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
  );
  assert.equal(view.viewer.follow.disabled, false);
  assert.equal(view.wantsOpen, true);
});

test('image deep links match the mapillary.com share format', () => {
  assert.equal(
    mapillaryImageUrl(1814275685699406),
    'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
  );
  assert.equal(mapillaryImageUrl('  '), 'https://www.mapillary.com/app/');
});
