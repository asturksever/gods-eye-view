import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createStreetLevelLayer } from './index.js';
import { MAPILLARY_CREDIT_HTML } from './providers/mapillary/policy.js';
import { createMapillaryProvider } from './providers/mapillary/index.js';
import { fakeStreetLevelProvider as fakeProvider } from '../../testSupport/streetLevelFakes.mjs';

/**
 * A stand-in Cesium viewer the layer can be enabled on: a canvas for the
 * click handler, camera events, a primitive list and a credit display.
 */
function fakeViewer() {
  const credits = [];
  /** Cesium's flight bookkeeping: a new flight cancels the current one. */
  let flight = null;
  const flights = { started: 0, cancelled: 0 };
  const stopFlight = () => {
    const current = flight;
    flight = null;
    current?.cancel?.();
    return Boolean(current);
  };
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    // Keep Cesium's handler on the canvas; there is no real document here.
    disableRootEvents: true,
    onwheel: null,
  });
  return {
    credits,
    flights,
    scene: {
      canvas,
      primitives: { add: (p) => p, remove() {} },
      // Enough of a scene for the position marker to clamp to the ground.
      frameState: { mode: Cesium.SceneMode.SCENE3D },
      updateHeight: () => () => {},
      getHeight: () => undefined,
    },
    camera: {
      changed: new Cesium.Event(),
      moveStart: new Cesium.Event(),
      moveEnd: new Cesium.Event(),
      flyToBoundingSphere(sphere, options = {}) {
        stopFlight();
        flight = options;
        flights.started++;
      },
      cancelFlight() {
        if (stopFlight()) flights.cancelled++;
      },
    },
    creditDisplay: {
      addStaticCredit: (credit) => credits.push(credit),
      removeStaticCredit: (credit) =>
        credits.splice(credits.indexOf(credit), 1),
    },
  };
}

/** A layer over `providers`, initialised and enabled on a stand-in viewer. */
async function enabledLayer(t, providers = [fakeProvider()]) {
  const saved = globalThis.document;
  // A pose moves the position marker, whose glyph is drawn on a canvas.
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  const viewer = fakeViewer();
  const layer = createStreetLevelLayer({ providers });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  await settle();
  return { layer, viewer };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A provider whose viewer reports a pose for every image it opens. */
function posingProvider() {
  const provider = fakeProvider();
  const create = provider.create;
  provider.create = (context) => {
    const instance = create(context);
    let emit = null;
    instance.viewer.onPose = (listener) => {
      emit = listener;
      return () => {
        emit = null;
      };
    };
    instance.viewer.open = async (imageId) => {
      provider.calls.open.push(imageId);
      emit?.({
        providerId: 'mapillary',
        imageId,
        position: { lon: -121.49, lat: 38.58 },
        bearing: 90,
      });
    };
    return instance;
  };
  return provider;
}

/** nearestImage lookups that answer when the test says, with their signals. */
function slowLookups() {
  const lookups = [];
  const nearestImage = (point, { signal } = {}) => {
    const answer = deferred();
    lookups.push({ point, signal, answer });
    return answer.promise;
  };
  return { lookups, nearestImage };
}

/** A map stack controller that can be switched between stacks. */
function fakeMapStack(initial) {
  let active = initial;
  const listeners = new Set();
  return {
    getActiveId: () => active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    switchTo(id) {
      active = id;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test('FOLLOW is available only while the Google 3D map stack is active', () => {
  const layer = createStreetLevelLayer({ providers: [fakeProvider()] });
  assert.equal(
    layer.getUIState().street.followAvailable,
    false,
    'unknown stack: off',
  );

  const stack = fakeMapStack('esri-imagery');
  layer.attachMapStackController(stack);
  assert.equal(layer.getUIState().street.followAvailable, false);
  layer.setFollow(true);
  assert.equal(layer.getUIState().street.follow, false, 'refused on Esri');

  stack.switchTo('photoreal');
  assert.equal(layer.getUIState().street.followAvailable, true);
  layer.setFollow(true);
  assert.equal(layer.getUIState().street.follow, true);

  stack.switchTo('osm');
  assert.equal(layer.getUIState().street.followAvailable, false);
  assert.equal(
    layer.getUIState().street.follow,
    false,
    'leaving Google 3D stops following',
  );
});

test('the layer lets go of the map stack when destroyed or re-attached', () => {
  const layer = createStreetLevelLayer({ providers: [fakeProvider()] });
  const first = fakeMapStack('photoreal');
  layer.attachMapStackController(first);
  assert.equal(first.listenerCount(), 1);
  const second = fakeMapStack('photoreal');
  layer.attachMapStackController(second);
  assert.equal(first.listenerCount(), 0);
  assert.equal(second.listenerCount(), 1);
  layer.destroy();
  assert.equal(second.listenerCount(), 0);
});

test('the CC BY-SA credit shows while a provider is on and goes with it', async (t) => {
  const { layer, viewer } = await enabledLayer(t);
  const shown = () => viewer.credits.map((credit) => credit.html);
  assert.deepEqual(shown(), [MAPILLARY_CREDIT_HTML], 'shown on activate');
  assert.match(shown()[0], /CC BY-SA 4\.0/);
  layer.setProviderEnabled('mapillary', false);
  assert.deepEqual(shown(), [], 'hidden with the provider');
  layer.setProviderEnabled('mapillary', true);
  assert.deepEqual(shown(), [MAPILLARY_CREDIT_HTML]);
  layer.disable();
  assert.deepEqual(shown(), [], 'every credit goes with the layer');
});

test('getStats tells a rejected key from a missing one', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  provider.stats.loading = true;
  assert.equal(layer.getStats().loadingLabel, 'loading coverage...');
  assert.equal(layer.getStats().keyRequired, false);

  provider.stats.keyRequired = true;
  assert.deepEqual(
    [layer.getStats().loadingLabel, layer.getStats().error],
    ['KEY REQUIRED', 'KEY REQUIRED'],
  );

  // A rejected key gates the provider exactly like a missing one.
  provider.stats.keyRequired = false;
  provider.stats.keyRejected = true;
  provider.stats.error = 'Mapillary rejected MAPILLARY_CLIENT_TOKEN';
  const stats = layer.getStats();
  assert.equal(stats.keyRequired, true);
  assert.equal(stats.loadingLabel, 'KEY REJECTED');
  assert.equal(stats.error, 'Mapillary rejected MAPILLARY_CLIENT_TOKEN');
  const ui = layer.getUIState();
  assert.equal(ui.keyRequired, true);
  assert.equal(ui.keyRejected, true);
  assert.equal(ui.providers[0].keyRequired, true);
});

test('switching a provider off deactivates it and closes the image it shows', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  assert.equal(await layer.openImage('mapillary', 'img1'), true);
  assert.deepEqual(provider.calls.open, ['img1']);
  assert.equal(layer.getUIState().street.open, true);
  layer.setProviderEnabled('mapillary', false);
  assert.equal(provider.calls.deactivate, 1);
  assert.equal(provider.calls.unmount, 1, 'its viewer is released');
  assert.equal(layer.getUIState().street.open, false);
  assert.equal(layer.getUIState().street.providerId, null);
});

test('openNearest without the panel reports it instead of loading forever', async (t) => {
  const provider = fakeProvider({ nearestImage: async () => 'img1' });
  const { layer } = await enabledLayer(t, [provider]);
  assert.equal(await layer.openNearest({ lat: 38.58, lon: -121.49 }), false);
  const { street } = layer.getUIState();
  assert.equal(street.loading, false);
  assert.match(street.error, /Open the Street Level panel/);
  assert.equal(provider.calls.mount, 0);
});

test('openNearest opens nothing once the layer went off during the lookup', async (t) => {
  const answer = deferred();
  const provider = fakeProvider({ nearestImage: () => answer.promise });
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  const opening = layer.openNearest({ lat: 38.58, lon: -121.49 });
  layer.disable();
  answer.resolve('img1');
  assert.equal(await opening, false);
  assert.equal(provider.calls.mount, 0, 'no viewer was stood up');
  const { street } = layer.getUIState();
  assert.equal(street.open, false);
  assert.equal(street.loading, false);
  assert.equal(street.error, null);
});

test('openNearest skips a provider switched off during its lookup', async (t) => {
  const answer = deferred();
  const provider = fakeProvider({ nearestImage: () => answer.promise });
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  const opening = layer.openNearest({ lat: 38.58, lon: -121.49 });
  layer.setProviderEnabled('mapillary', false);
  answer.resolve('img1');
  assert.equal(await opening, false);
  assert.deepEqual(provider.calls.open, []);
  assert.equal(layer.getUIState().street.loading, false);
});

test('a provider withdraws only the error it reported', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  const { actions } = provider.context();
  actions.reportError('Sequence images unavailable');
  assert.equal(layer.getUIState().street.error, 'Sequence images unavailable');
  actions.reportError(null);
  assert.equal(layer.getUIState().street.error, null, 'withdrawn');

  // The viewer's own error is not the provider's to clear.
  layer.attachViewerHost(null);
  actions.reportError('Sequence images unavailable');
  await layer.openImage('mapillary', 'img1');
  actions.reportError(null);
  assert.match(layer.getUIState().street.error, /Open the Street Level panel/);
});

test('closing the photo stops the globe flying to it', async (t) => {
  const { layer, viewer } = await enabledLayer(t, [posingProvider()]);
  layer.attachViewerHost({});
  assert.equal(await layer.openImage('mapillary', 'img1'), true);
  assert.equal(viewer.flights.started, 1, 'the photo is framed');
  layer.closeViewer();
  assert.equal(viewer.flights.cancelled, 1);
});

test('switching the layer off or destroying it stops the framing flight', async (t) => {
  const { layer, viewer } = await enabledLayer(t, [posingProvider()]);
  layer.attachViewerHost({});
  await layer.openImage('mapillary', 'img1');
  layer.disable();
  assert.equal(viewer.flights.cancelled, 1, 'layer off');

  layer.enable(viewer);
  await layer.openImage('mapillary', 'img2');
  layer.destroy();
  assert.equal(viewer.flights.cancelled, 2, 'destroyed');
});

test('closing the photo leaves a newer navigation flight alone', async (t) => {
  const { layer, viewer } = await enabledLayer(t, [posingProvider()]);
  layer.attachViewerHost({});
  await layer.openImage('mapillary', 'img1');
  assert.equal(viewer.flights.started, 1, 'the photo is being framed');
  // A search result flies the globe elsewhere before the framing lands.
  viewer.camera.flyToBoundingSphere(null, {});
  layer.closeViewer();
  assert.equal(viewer.flights.cancelled, 0, 'the search flight keeps going');
});

test('an older nearest lookup that answers late cannot replace a newer one', async (t) => {
  const { lookups, nearestImage } = slowLookups();
  const provider = fakeProvider({ nearestImage });
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  const older = layer.openNearest({ lat: 38.58, lon: -121.49 });
  const newer = layer.openNearest({ lat: 38.59, lon: -121.48 });
  lookups[1].answer.resolve('newer');
  assert.equal(await newer, true);
  lookups[0].answer.resolve('older');
  assert.equal(await older, false);
  assert.deepEqual(provider.calls.open, ['newer']);
  assert.equal(lookups[0].signal?.aborted, true, 'its request was aborted');
  assert.equal(lookups[1].signal?.aborted, false);
});

test('an image picked during a nearest lookup wins over its late answer', async (t) => {
  const { lookups, nearestImage } = slowLookups();
  const provider = fakeProvider({ nearestImage });
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  const lookup = layer.openNearest({ lat: 38.58, lon: -121.49 });
  // A cone click goes through the provider's openImage action.
  assert.equal(await provider.context().actions.openImage('picked'), true);
  lookups[0].answer.resolve('nearest');
  assert.equal(await lookup, false);
  assert.deepEqual(provider.calls.open, ['picked']);
  assert.equal(lookups[0].signal?.aborted, true);
});

test('closing the viewer or switching the layer off retires a nearest lookup', async (t) => {
  const { lookups, nearestImage } = slowLookups();
  const provider = fakeProvider({ nearestImage });
  const { layer, viewer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});

  const closed = layer.openNearest({ lat: 38.58, lon: -121.49 });
  layer.closeViewer();
  // The aborted fetch rejects, as fetch does; that is not the user's error.
  lookups[0].answer.reject(new DOMException('aborted', 'AbortError'));
  assert.equal(await closed, false);
  let { street } = layer.getUIState();
  assert.deepEqual(
    [street.open, street.loading, street.error],
    [false, false, null],
  );
  assert.equal(lookups[0].signal?.aborted, true, 'closing aborts the request');

  const disabled = layer.openNearest({ lat: 38.58, lon: -121.49 });
  layer.disable();
  layer.enable(viewer);
  lookups[1].answer.resolve('img1');
  assert.equal(await disabled, false, 'nor does it open once back on');
  assert.deepEqual(provider.calls.open, []);
  ({ street } = layer.getUIState());
  assert.deepEqual(
    [street.open, street.loading, street.error],
    [false, false, null],
  );
  assert.equal(lookups[1].signal?.aborted, true, 'layer off aborts it too');
});

test('the Mapillary provider hands the lookup signal to its source', async () => {
  const requests = [];
  const source = {
    hasToken: () => true,
    getStatus: async () => ({ configured: true }),
    getTile: async () => new Uint8Array(0),
    getSequenceImages: async () => [],
    nearestImages: async (query, options) => {
      requests.push(options);
      return [{ id: 7, is_pano: false, captured_at: 10 }];
    },
  };
  const instance = createMapillaryProvider({ source }).create({
    services: {},
    getFilter: () => ({ pano: 'all', sinceMs: null }),
    isActive: () => true,
    notify() {},
    actions: { openImage() {}, reportError() {} },
  });
  const { signal } = new AbortController();
  assert.equal(
    await instance.nearestImage({ lat: 1, lon: 2 }, { signal }),
    '7',
  );
  assert.equal(requests[0]?.signal, signal);
});

test('setParams takes "any date" (0 days) and a provider switch over the current values (share-link defaults)', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  layer.setParams({ pano: 'flat', sinceDays: 365 });
  assert.equal(layer.getParams().sinceDays, 365);
  layer.setParams({ sinceDays: 0 });
  assert.deepEqual(layer.getParams(), {
    mapillary: true,
    pano: 'flat',
    sinceDays: 0,
  });
  assert.equal(
    provider.filterCalls.at(-1).sinceMs,
    null,
    'providers drop the cut-off',
  );
  layer.setParams({ mapillary: false });
  assert.equal(layer.getParams().mapillary, false);
});

/** A layer initialised on a stand-in viewer but never enabled. */
function initialisedLayer(t, providers) {
  const saved = globalThis.document;
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  const viewer = fakeViewer();
  const layer = createStreetLevelLayer({ providers });
  layer.init(viewer);
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  return { layer, viewer };
}

test('switching a provider on while the layer is off activates nothing (M01)', async (t) => {
  const provider = fakeProvider();
  const prewarmed = [];
  const create = provider.create;
  provider.create = (context) => {
    const instance = create(context);
    instance.viewer.prewarm = async (host) => prewarmed.push(host);
    return instance;
  };
  const { layer, viewer } = initialisedLayer(t, [provider]);
  layer.attachViewerHost({});
  layer.setProviderEnabled('mapillary', false);
  layer.setProviderEnabled('mapillary', true);
  layer.setParams({ mapillary: false });
  layer.setParams({ mapillary: true });
  await new Promise((resolve) => setTimeout(resolve, 40)); // past whenIdle
  assert.equal(provider.calls.activate, 0, 'no coverage drawn');
  assert.deepEqual(viewer.credits, [], 'no credit shown');
  assert.deepEqual(prewarmed, [], 'no viewer stood up');
  assert.equal(layer.getUIState().providers[0].on, true, 'the switch is kept');
  // Enabling the layer is what activates it, once.
  layer.enable(viewer);
  assert.equal(provider.calls.activate, 1);
  assert.equal(viewer.credits.length, 1);
});

/** The real Google provider over the Street View fakes, beside a Mapillary stand-in. */
async function withStreetView(
  t,
  { mapStack = 'photoreal', nearest, mapillaryKeyless = false } = {},
) {
  const { createGoogleProvider } = await import('./providers/google/index.js');
  const { fakeHost, fakeMapsLoader, fakeStreetViewLibrary } =
    await import('../../testSupport/googleStreetViewFakes.mjs');
  const fake = fakeStreetViewLibrary({
    panoramas: {
      'pano-a': { lat: 38.5816, lng: -121.4944, imageDate: '2024-05' },
    },
    nearest: nearest ?? (() => 'pano-a'),
  });
  const mapillaryLookups = [];
  const mapillary = fakeProvider({
    nearestImage: async (point) => {
      mapillaryLookups.push(point);
      return null;
    },
  });
  mapillary.requiresKeyId = 'mapillary';
  if (mapillaryKeyless) {
    mapillary.stats.keyRequired = true;
    const create = mapillary.create;
    mapillary.create = (context) => ({
      ...create(context),
      status: async () => ({ configured: false }),
    });
  }
  const loader = fakeMapsLoader(fake.library);
  const google = createGoogleProvider({
    getApiKey: () => 'browser-key',
    loader,
  });
  const { layer, viewer } = await enabledLayer(t, [mapillary, google]);
  const stack = fakeMapStack(mapStack);
  layer.attachMapStackController(stack);
  layer.attachViewerHost(fakeHost());
  return { layer, viewer, stack, fake, loader, mapillaryLookups };
}

test('Street View starts off, and the layer row names the key of the providers that are on', async (t) => {
  const { layer } = await withStreetView(t);
  const google = () =>
    layer.getUIState().providers.find((p) => p.id === 'google');
  assert.equal(google().on, false);
  assert.equal(layer.requiresKeyId, 'mapillary');
  layer.setProviderEnabled('google', true);
  assert.equal(layer.requiresKeyId, 'google-maps', 'Street View alone');
});

test('the layer starts with one source lit: the first that defaults on', async (t) => {
  const { layer } = await enabledLayer(t, [
    fakeProvider(),
    fakeProvider({ id: 'panoramax', pickPrefix: 'pmx:' }),
  ]);
  assert.deepEqual(
    layer
      .getUIState()
      .providers.filter((p) => p.on)
      .map((p) => p.id),
    ['mapillary'],
  );
});

test('leaving Google 3D during a Street View lookup ends it without an error or a stuck spinner', async (t) => {
  const { layer, stack, fake } = await withStreetView(t);
  layer.setProviderEnabled('google', true);
  let answer;
  fake.library.StreetViewService.prototype.getPanorama = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const opening = layer.openNearest({ lat: 38.5816, lon: -121.4944 });
  await settle();
  assert.equal(layer.getUIState().street.loading, true);
  stack.switchTo('bing');
  answer({ data: { location: { pano: 'pano-a' }, imageDate: '2024-05' } });
  assert.equal(await opening, false);
  const { street } = layer.getUIState();
  assert.equal(street.loading, false, 'OPEN STREET VIEW is usable again');
  assert.equal(street.error, null);
  assert.equal(street.open, false);
});

test('a source swap during a lookup reports no false "no imagery"', async (t) => {
  let answer;
  const mapillary = fakeProvider({
    nearestImage: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  const other = fakeProvider({ id: 'panoramax', pickPrefix: 'pmx:' });
  const { layer } = await enabledLayer(t, [mapillary, other]);
  const opening = layer.openNearest({ lat: 1, lon: 2 });
  layer.setProviderEnabled('panoramax', true);
  answer('img-1');
  assert.equal(await opening, false);
  assert.equal(layer.getUIState().street.error, null);
  assert.equal(layer.getUIState().street.loading, false);
});

test('Street View lit off Google 3D says why the panel is empty', async (t) => {
  const { layer, stack } = await withStreetView(t);
  layer.setProviderEnabled('google', true);
  stack.switchTo('esri-imagery');
  assert.match(
    layer.getUIState().coverage.hint,
    /Google Street View needs the Google 3D map/,
  );
  layer.setProviderEnabled('mapillary', true);
  assert.doesNotMatch(layer.getUIState().coverage.hint, /Google 3D/);
});

test('one imagery source at a time: lighting one darkens the other, either way', async (t) => {
  const { layer } = await withStreetView(t);
  const lit = () =>
    layer
      .getUIState()
      .providers.filter((p) => p.on)
      .map((p) => p.id);
  assert.deepEqual(lit(), ['mapillary'], 'Mapillary by default: it is free');
  layer.setProviderEnabled('google', true);
  assert.deepEqual(lit(), ['google']);
  assert.equal(layer.getParams().mapillary, false);
  layer.setProviderEnabled('mapillary', true);
  assert.deepEqual(lit(), ['mapillary']);
  assert.equal(layer.getParams().google, false);
  // Params that light one switch to it; reapplying them changes nothing.
  layer.setParams({ google: true });
  assert.deepEqual(lit(), ['google']);
  layer.setParams({ google: true });
  assert.deepEqual(lit(), ['google']);
  // Params lighting both keep the one already on, however often applied.
  for (let i = 0; i < 2; i++) {
    layer.setParams({ mapillary: true, providerSwitches: 'google-1' });
    assert.deepEqual(lit(), ['google']);
  }
  layer.setParams({ mapillary: true, google: false });
  assert.deepEqual(lit(), ['mapillary']);
  // Filter-only params leave the source alone.
  layer.setParams({ pano: 'pano' });
  assert.deepEqual(lit(), ['mapillary']);
  // Darkening the only lit one leaves none: the panel turns the layer off.
  layer.setProviderEnabled('mapillary', false);
  assert.deepEqual(lit(), []);
});

test('Street View appears only on the Google 3D map: chip, legend, credit, source and images', async (t) => {
  const { layer, viewer, stack } = await withStreetView(t, {
    mapStack: 'esri-imagery',
  });
  layer.setProviderEnabled('google', true);
  await settle();
  const ui = () => layer.getUIState();
  const listed = () => ui().providers.map((p) => p.id);
  const credited = () =>
    viewer.credits.some((credit) => /Street View imagery/.test(credit.html));
  assert.deepEqual(listed(), ['mapillary'], 'no Street View chip');
  assert.ok(!ui().legend.some((item) => item.key === 'google'));
  assert.equal(credited(), false, 'no Google credit on another map');
  assert.equal(layer.source, 'Mapillary');
  assert.equal(layer.getStats().source, 'Mapillary');
  assert.equal(await layer.openImage('google', 'pano-a'), false);
  assert.match(ui().street.error, /needs the Google 3D map/);
  assert.equal(layer.getParams().google, true, 'the choice is kept');

  stack.switchTo('photoreal');
  assert.deepEqual(listed(), ['mapillary', 'google']);
  assert.equal(credited(), true);
  assert.equal(layer.source, 'Mapillary · Google Street View');
  assert.equal(await layer.openImage('google', 'pano-a'), true);
  assert.equal(ui().street.providerId, 'google');

  stack.switchTo('bing');
  await settle();
  assert.equal(ui().street.open, false, 'closed with the map');
  assert.equal(credited(), false);
  assert.deepEqual(listed(), ['mapillary']);
});

test('the UI state says when a click (or the button) can open Street View here', async (t) => {
  const { layer } = await withStreetView(t);
  assert.equal(typeof layer.getUIState().groundClickReady, 'boolean');
});

test('a lookup for the click-to-open providers asks only them and reports "that point"', async (t) => {
  const { layer, mapillaryLookups } = await withStreetView(t, {
    nearest: () => null,
  });
  layer.setProviderEnabled('google', true);
  await settle();
  const opened = await layer.openNearest(
    { lat: 38.58, lon: -121.49 },
    { providerIds: ['google'], frame: false },
  );
  assert.equal(opened, false);
  assert.deepEqual(mapillaryLookups, [], 'Mapillary was not asked');
  assert.equal(
    layer.getUIState().street.error,
    'No street-level imagery within 50 m of that point',
  );
});

test('an image opened from a ground click leaves the camera where it is', async (t) => {
  const { layer, viewer } = await withStreetView(t);
  layer.setProviderEnabled('google', true);
  await settle();
  await layer.openNearest(
    { lat: 38.58, lon: -121.49 },
    { providerIds: ['google'], frame: false },
  );
  assert.equal(layer.getUIState().street.imageId, 'pano-a');
  assert.equal(viewer.flights.started, 0, 'no framing flight');
});

test('off Google 3D not even Google\u2019s script is loaded for Street View', async (t) => {
  const { layer, loader } = await withStreetView(t, {
    mapStack: 'esri-imagery',
  });
  layer.setProviderEnabled('google', true);
  layer.attachViewerHost({ ownerDocument: { createElement: () => ({}) } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(loader.imports, [], 'no prewarm, no lookup');
});

test('the button’s “centre of the view” is the ground under the middle of the screen', async (t) => {
  const { createStreetLevelLayer: create } = await import('./index.js');
  const scenePick = await import('../../data/scenePick.js');
  const lookups = [];
  const provider = fakeProvider({
    nearestImage: async (point) => {
      lookups.push(point);
      return null;
    },
  });
  const saved = globalThis.document;
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  const viewer = fakeViewer();
  const centre = Cesium.Cartesian3.fromDegrees(-121.4937, 38.5799, 0);
  Object.assign(viewer.scene, {
    pickPositionSupported: true,
    pickPosition: (at) => (at.x === 500 && at.y === 300 ? centre : undefined),
  });
  viewer.scene.canvas.clientWidth = 1000;
  viewer.scene.canvas.clientHeight = 600;
  const layer = create({ providers: [provider], services: { scenePick } });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  await layer.openNearest(undefined, { aim: 'screen-centre' });
  assert.equal(lookups.length, 1);
  assert.ok(Math.abs(lookups[0].lat - 38.5799) < 1e-9);
  assert.ok(Math.abs(lookups[0].lon - -121.4937) < 1e-9);
});

test('the button aimed at the sky opens nothing, and says to aim at a street', async (t) => {
  const { createStreetLevelLayer: create } = await import('./index.js');
  const scenePick = await import('../../data/scenePick.js');
  const lookups = [];
  const provider = fakeProvider({
    nearestImage: async (point) => {
      lookups.push(point);
      return null;
    },
  });
  const saved = globalThis.document;
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  const viewer = fakeViewer();
  // Every ground pick misses: the middle of the screen is sky.
  Object.assign(viewer.scene, {
    pickPositionSupported: true,
    pickPosition: () => undefined,
  });
  viewer.camera.pickEllipsoid = () => undefined;
  viewer.scene.canvas.clientWidth = 1000;
  viewer.scene.canvas.clientHeight = 600;
  const layer = create({ providers: [provider], services: { scenePick } });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  assert.equal(
    await layer.openNearest(undefined, { aim: 'screen-centre' }),
    false,
  );
  assert.deepEqual(lookups, [], 'no lookup at the view centre instead');
  const { street } = layer.getUIState();
  assert.match(street.error, /Aim the middle of the view at a street/);
  assert.equal(street.loading, false);
});

test('with no Mapillary token, the layer points at Street View, on Google 3D only', async (t) => {
  const { layer, stack } = await withStreetView(t, { mapillaryKeyless: true });
  await settle();
  const stats = layer.getStats();
  assert.equal(stats.keyRequired, true);
  assert.deepEqual(stats.keyAlternatives, [
    { id: 'google', label: 'GOOGLE STREET VIEW', requiresKeyId: 'google-maps' },
  ]);
  assert.deepEqual(layer.getUIState().keyAlternatives, stats.keyAlternatives);
  stack.switchTo('esri-imagery');
  assert.deepEqual(layer.getStats().keyAlternatives, [], 'not off Google 3D');
  // Lit, Street View draws: the layer is no longer key-gated.
  stack.switchTo('photoreal');
  layer.setProviderEnabled('google', true);
  assert.equal(layer.getStats().keyRequired, false);
});

test('an empty provider composition enables and tears down without acquiring imagery', async (t) => {
  const { layer, viewer } = await enabledLayer(t, []);
  assert.deepEqual(layer.providerIds, []);
  assert.deepEqual(layer.getUIState().providers, []);
  assert.equal(layer.getUIState().keyRequired, false);
  assert.match(
    layer.getUIState().coverage.hint,
    /No street-level imagery providers/,
  );
  layer.disable();
  layer.enable(viewer);
  assert.deepEqual(layer.getUIState().providers, []);
});

test('openNearest searches wider on request, never past the cap, and says how far it looked', async (t) => {
  const { layer, fake } = await withStreetView(t, { nearest: () => null });
  layer.setProviderEnabled('google', true);
  await settle();
  await layer.openNearest(
    { lat: 38.58, lon: -121.49 },
    { providerIds: ['google'], frame: false, radiusM: 250 },
  );
  assert.equal(fake.lookups.at(-1).radius, 250);
  assert.equal(
    layer.getUIState().street.error,
    'No street-level imagery within 250 m of that point',
  );
  await layer.openNearest(
    { lat: 38.58, lon: -121.49 },
    { providerIds: ['google'], frame: false, radiusM: 5000 },
  );
  assert.equal(fake.lookups.at(-1).radius, 250, 'capped');
  await layer.openNearest(
    { lat: 38.58, lon: -121.49 },
    { providerIds: ['google'], frame: false },
  );
  assert.equal(fake.lookups.at(-1).radius, 50, 'a click keeps the default');
});

test('a caller’s signal retires a nearest lookup: nothing opens after it fires', async (t) => {
  let answer = null;
  const { layer, fake } = await withStreetView(t, {
    nearest: () => 'pano-a',
  });
  const lib = fake.library;
  const service = lib.StreetViewService.prototype.getPanorama;
  lib.StreetViewService.prototype.getPanorama = function (request) {
    return new Promise((resolve, reject) => {
      answer = () => service.call(this, request).then(resolve, reject);
    });
  };
  layer.setProviderEnabled('google', true);
  await settle();
  const controller = new AbortController();
  const pending = layer.openNearest(
    { lat: 38.58, lon: -121.49 },
    { providerIds: ['google'], frame: false, signal: controller.signal },
  );
  await settle();
  controller.abort();
  answer?.();
  assert.equal(await pending, false);
  const street = layer.getUIState().street;
  assert.equal(street.open, false, 'the retired lookup opened nothing');
  assert.equal(street.loading, false, 'no stuck spinner');
  assert.equal(street.error, null, 'and reports no missing imagery');
  const refused = await layer.openNearest(
    { lat: 38.58, lon: -121.49 },
    { providerIds: ['google'], frame: false, signal: controller.signal },
  );
  assert.equal(refused, false, 'an already-aborted signal asks nothing');
});

test('providerStatus reports name, key state and billing on any map', async (t) => {
  const { layer } = await withStreetView(t, { mapStack: 'osm' });
  const google = layer.providerStatus('google');
  assert.equal(google.name, 'Google Street View');
  assert.equal(google.billed, true, 'every Street View load is billed');
  assert.equal(google.available, false, 'not on this map');
  assert.equal(google.keyRequired, false);
  assert.equal(layer.providerStatus('mapillary').billed, false);
  assert.equal(layer.providerStatus('nope'), null);
  assert.equal(layer.requiredMapStack('google'), 'photoreal');
  assert.equal(layer.requiredMapStack('mapillary'), null);
});

test('an armed lookup asks nothing until the OPEN press, then opens at its point and radius once', async (t) => {
  const { layer, fake, mapillaryLookups } = await withStreetView(t);
  layer.setProviderEnabled('google', true);
  await settle();
  const before = fake.lookups.length;
  layer.armNearest(
    { lat: 38.57986, lon: -121.49372 },
    { providerIds: ['google'], radiusM: 250 },
  );
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The click gate: arming is free. No provider was asked, nothing opened.
  assert.equal(
    fake.lookups.length,
    before,
    'no Google lookup before the press',
  );
  assert.deepEqual(mapillaryLookups, [], 'no Mapillary lookup either');
  assert.equal(layer.getUIState().street.open, false);
  assert.equal(layer.getUIState().street.loading, false);
  assert.deepEqual(layer.getUIState().street.armed, {
    point: { lat: 38.57986, lon: -121.49372 },
    providerIds: ['google'],
    radiusM: 250,
  });
  // The OPEN button: no point, aimed at the screen centre.
  const opened = await layer.openNearest(undefined, {
    providerIds: ['google'],
    frame: false,
    aim: 'screen-centre',
  });
  assert.equal(opened, true);
  assert.equal(
    fake.lookups.length,
    before + 1,
    'exactly one lookup for the press',
  );
  const request = fake.lookups.at(-1);
  assert.deepEqual(
    request.location,
    { lat: 38.57986, lng: -121.49372 },
    'the armed point, not the screen centre',
  );
  assert.equal(request.radius, 250);
  assert.equal(layer.getUIState().street.armed, null, 'used once');
  layer.armNearest({ lat: 1, lon: 2 }, { providerIds: ['google'] });
  layer.closeViewer();
  assert.equal(layer.getUIState().street.armed, null, 'closing clears it');
  layer.armNearest({ lat: 1, lon: 2 }, { providerIds: ['google'] });
  await layer.openNearest(
    { lat: 38.58, lon: -121.49 },
    { providerIds: ['google'], frame: false },
  );
  assert.deepEqual(
    fake.lookups.at(-1).location,
    { lat: 38.58, lng: -121.49 },
    'an explicit point wins',
  );
  assert.equal(layer.getUIState().street.armed, null);
  // Only the OPEN press consumes the armed point: "street view here" after a
  // pan is a new request at the view centre, and it drops the armed one.
  layer.closeViewer();
  layer.armNearest(
    { lat: 10, lon: 20 },
    { providerIds: ['google'], radiusM: 250 },
  );
  await layer.openNearest(null, { providerIds: ['google'], frame: false });
  const centre = fake.lookups.at(-1);
  assert.notDeepEqual(
    centre.location,
    { lat: 10, lng: 20 },
    'the view centre, not the armed point',
  );
  assert.equal(centre.radius, 50, 'and the default radius');
  assert.equal(layer.getUIState().street.armed, null, 'dropped');
  // Opening any image, or switching the layer off, clears it too.
  layer.armNearest({ lat: 10, lon: 20 }, { providerIds: ['google'] });
  await layer.openImage('google', 'pano-a');
  assert.equal(layer.getUIState().street.armed, null, 'cleared by an open');
  layer.armNearest({ lat: 10, lon: 20 }, { providerIds: ['google'] });
  layer.disable();
  assert.equal(layer.getUIState().street.armed, null, 'cleared by disable');
});

test('a caller’s signal: an aborted one asks nothing, and a provider that ignores the abort still opens nothing', async (t) => {
  const { layer, fake } = await withStreetView(t);
  layer.setProviderEnabled('google', true);
  await settle();
  const before = fake.lookups.length;
  const done = new AbortController();
  done.abort();
  assert.equal(
    await layer.openNearest(
      { lat: 38.58, lon: -121.49 },
      { providerIds: ['google'], frame: false, signal: done.signal },
    ),
    false,
  );
  assert.equal(
    fake.lookups.length,
    before,
    'an already-aborted signal asks nothing',
  );
});

test('a provider that ignores the abort and answers late still opens nothing', async (t) => {
  let seen = null;
  let release = null;
  const slow = fakeProvider({
    nearestImage: async (_point, { signal } = {}) => {
      seen = signal;
      await new Promise((resolve) => {
        release = resolve;
      });
      return 'late-image';
    },
  });
  const { layer: ignoring } = await enabledLayer(t, [slow]);
  const { fakeHost } =
    await import('../../testSupport/googleStreetViewFakes.mjs');
  ignoring.attachViewerHost(fakeHost());
  const controller = new AbortController();
  const pending = ignoring.openNearest(
    { lat: 1, lon: 2 },
    { frame: false, signal: controller.signal },
  );
  await settle();
  controller.abort();
  assert.equal(seen?.aborted, true, 'the provider sees the abort');
  release();
  assert.equal(await pending, false);
  const street = ignoring.getUIState().street;
  assert.equal(street.open, false, 'the late answer opened nothing');
  assert.equal(street.loading, false, 'no stuck spinner');
  assert.equal(street.error, null);
});

test('providerStatus reports a keyless source on any map', async (t) => {
  const keyless = await withStreetView(t, {
    mapStack: 'osm',
    mapillaryKeyless: true,
  });
  await settle();
  const mapillary = keyless.layer.providerStatus('mapillary');
  assert.equal(mapillary.configured, false);
  assert.equal(mapillary.keyRequired, true);
  assert.equal(mapillary.keyRejected, false);
});

test('providerStatus reports a refused key on any map', async (t) => {
  const refused = await withStreetView(t, { mapStack: 'osm' });
  refused.loader.refuseKey();
  await settle();
  const google = refused.layer.providerStatus('google');
  assert.equal(
    google.keyRequired,
    true,
    'a refused key gates like a missing one',
  );
  assert.equal(google.keyRejected, true);
  assert.equal(google.available, false, 'still not on this map');
});

test('an armed lookup dies with its source: switched off, or its map gone', async (t) => {
  const { layer, stack } = await withStreetView(t);
  layer.setProviderEnabled('google', true);
  await settle();
  layer.armNearest(
    { lat: 1, lon: 2 },
    { providerIds: ['google'], radiusM: 250 },
  );
  layer.setProviderEnabled('google', false);
  assert.equal(
    layer.getUIState().street.armed,
    null,
    'switching the source off clears it',
  );
  layer.setProviderEnabled('google', true);
  layer.armNearest(
    { lat: 1, lon: 2 },
    { providerIds: ['google'], radiusM: 250 },
  );
  // Lighting Mapillary instead (one source at a time) turns Google off too.
  layer.setProviderEnabled('mapillary', true);
  assert.equal(
    layer.getUIState().street.armed,
    null,
    'another source lit clears it',
  );
  layer.setProviderEnabled('google', true);
  layer.armNearest(
    { lat: 1, lon: 2 },
    { providerIds: ['google'], radiusM: 250 },
  );
  // A map-stack notify that keeps Google 3D (a silent re-settle) keeps it.
  stack.switchTo('photoreal');
  assert.notEqual(
    layer.getUIState().street.armed,
    null,
    'a notify on the same map keeps it',
  );
  stack.switchTo('osm');
  assert.equal(
    layer.getUIState().street.armed,
    null,
    'leaving Google 3D clears it',
  );
  // Arming notifies, so a panel can show the state.
  let notified = 0;
  const unsubscribe = layer.subscribe(() => notified++);
  stack.switchTo('photoreal');
  await settle();
  const before = notified;
  layer.armNearest({ lat: 1, lon: 2 }, { providerIds: ['google'] });
  await settle();
  assert.ok(notified > before, 'subscribers hear about the armed lookup');
  unsubscribe();
});

test('a lookup armed with no point opens under the middle of the screen on the press', async (t) => {
  const { createStreetLevelLayer: create } = await import('./index.js');
  const scenePick = await import('../../data/scenePick.js');
  const lookups = [];
  const provider = fakeProvider({
    nearestImage: async (point, options) => {
      lookups.push({ ...point, radiusM: options?.radiusM ?? null });
      return null;
    },
  });
  const saved = globalThis.document;
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  const viewer = fakeViewer();
  const centre = Cesium.Cartesian3.fromDegrees(-121.4937, 38.5799, 0);
  Object.assign(viewer.scene, {
    pickPositionSupported: true,
    pickPosition: (at) => (at.x === 500 && at.y === 300 ? centre : undefined),
  });
  viewer.scene.canvas.clientWidth = 1000;
  viewer.scene.canvas.clientHeight = 600;
  // Registered before the layer exists, so a throwing create() still
  // restores the document; destroy() runs first, while the stub is in place.
  let layer = null;
  t.after(() => {
    layer?.destroy();
    globalThis.document = saved;
  });
  layer = create({ providers: [provider], services: { scenePick } });
  layer.init(viewer);
  layer.enable(viewer);
  layer.armNearest(null, { providerIds: [provider.id], radiusM: 250 });
  assert.equal(
    layer.getUIState().street.armed.point,
    null,
    'no point stored, not 0,0',
  );
  await layer.openNearest(undefined, { aim: 'screen-centre' });
  assert.equal(lookups.length, 1);
  assert.ok(
    Math.abs(lookups[0].lat - 38.5799) < 1e-9,
    'the screen centre, not Null Island',
  );
  assert.ok(Math.abs(lookups[0].lon - -121.4937) < 1e-9);
  assert.equal(lookups[0].radiusM, 250, 'with the armed radius');
});

test('the action over the real layer: a billed link arms without a lookup, and one press makes exactly one at the point', async (t) => {
  const { createGevActionRunner } = await import('../../voice/gevActions.js');
  const { layer, fake, viewer } = await withStreetView(t);
  // The runner wires pointer tracking to the clock and camera.
  viewer.clock ??= { onTick: { addEventListener: () => () => {} } };
  viewer.camera.moveEnd ??= { addEventListener() {} };
  const dataManager = {
    layers: new Map([['street-level', { module: layer }]]),
    isEnabled: () => true,
    getLayerParams: () => layer.getParams(),
    setLayerParams: (_id, params) => {
      layer.setParams(params);
      return true;
    },
    getAll: () => [{ id: 'street-level', name: 'Street Level', enabled: true }],
  };
  const styleManager = {
    mapStackController: { getActiveId: () => 'photoreal' },
    setMapStack: async () => ({ ok: true, activeStack: 'photoreal' }),
  };
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });
  const before = fake.lookups.length;
  const armed = await runner('show_street_level', {
    latitude: 38.57986,
    longitude: -121.49372,
    provider: 'google',
    fly: false,
    autoOpen: false,
  });
  assert.equal(armed.ok, true, armed.error);
  assert.equal(armed.armed, true);
  assert.equal(armed.providerName, 'Google Street View');
  await settle();
  assert.equal(fake.lookups.length, before, 'arming made no Google request');
  assert.deepEqual(
    layer
      .getUIState()
      .providers.filter((p) => p.on)
      .map((p) => p.id),
    ['google'],
  );
  assert.equal(layer.getUIState().street.open, false);
  // The OPEN button.
  assert.equal(
    await layer.openNearest(undefined, {
      providerIds: ['google'],
      frame: false,
      aim: 'screen-centre',
    }),
    true,
  );
  assert.equal(fake.lookups.length, before + 1, 'one request for the press');
  assert.deepEqual(fake.lookups.at(-1).location, {
    lat: 38.57986,
    lng: -121.49372,
  });
  assert.equal(fake.lookups.at(-1).radius, 250);
  assert.equal(layer.getUIState().street.imageId, 'pano-a');
  // The same call without the gate opens at once, with one request.
  layer.closeViewer();
  const opened = await runner('show_street_level', {
    latitude: 38.57986,
    longitude: -121.49372,
    provider: 'google',
    fly: false,
  });
  assert.equal(opened.ok, true, opened.error);
  assert.equal(opened.imageId, 'pano-a');
  assert.equal(fake.lookups.length, before + 2);
});

test('coverageLines hands back what a provider draws, and nothing for providers without lines', async (t) => {
  const drawing = fakeProvider();
  const create = drawing.create;
  drawing.create = (context) => ({
    ...create(context),
    coverageLines: () => [
      {
        id: 's1',
        parts: [
          [
            [1, 2],
            [1, 2.001],
          ],
        ],
      },
    ],
  });
  const { layer } = await enabledLayer(t, [drawing]);
  assert.deepEqual(layer.coverageLines(drawing.id), [
    {
      id: 's1',
      parts: [
        [
          [1, 2],
          [1, 2.001],
        ],
      ],
    },
  ]);
  assert.deepEqual(layer.coverageLines('nope'), []);
});

test('coverageLines is empty for a provider that draws no coverage', async (t) => {
  const { layer } = await enabledLayer(t, [fakeProvider()]);
  assert.deepEqual(layer.coverageLines(fakeProvider().id), []);
});

/** The action runner over this real layer, with a data manager that routes
 * params and visibility to it as the app's does. */
async function runnerOverLayer(t, options = {}) {
  const { createGevActionRunner } = await import('../../voice/gevActions.js');
  const setup = await withStreetView(t, options);
  const { layer, viewer } = setup;
  viewer.clock ??= { onTick: { addEventListener: () => () => {} } };
  viewer.camera.moveEnd ??= { addEventListener() {} };
  let stack = options.mapStack ?? 'photoreal';
  const writes = [];
  const dataManager = {
    layers: new Map([['street-level', { module: layer }]]),
    isEnabled: () => true,
    getLayerParams: () => layer.getParams(),
    setLayerParams: (_id, params, { origin }) => {
      writes.push({ params, origin });
      layer.setParams(params);
      return true;
    },
    getAll: () => [{ id: 'street-level', name: 'Street Level', enabled: true }],
  };
  const styleManager = {
    mapStackController: { getActiveId: () => stack },
    setMapStack: async (id) => {
      stack = id;
      setup.stack.switchTo(id);
      return { ok: true, activeStack: id };
    },
  };
  const runner = createGevActionRunner({ viewer, styleManager, dataManager });
  return { ...setup, runner, writes, dataManager };
}

test('set_street_level: "only 360 Mapillary coverage" lights Mapillary and filters it, through the persisted path', async (t) => {
  const { runner, layer, writes, fake } = await runnerOverLayer(t);
  layer.setProviderEnabled('google', true);
  await settle();
  const lookups = fake.lookups.length;
  const result = await runner('set_street_level', {
    provider: 'mapillary',
    imagery: 'pano',
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.changed, ['provider', 'imagery']);
  // The panel's own state: one source, the 360° filter.
  const ui = layer.getUIState();
  assert.deepEqual(
    ui.providers.filter((p) => p.on).map((p) => p.id),
    ['mapillary'],
  );
  assert.equal(ui.filter.pano, 'pano');
  // The share link and saved state record it, as a chip and the filter would.
  assert.equal(layer.getParams().pano, 'pano');
  assert.equal(layer.getParams().mapillary, true);
  assert.equal(writes.at(-1).origin, 'voice');
  assert.equal(result.say, 'Mapillary, 360° only, any date.');
  assert.equal(result.filtersApply.imagery, true);
  assert.equal(fake.lookups.length, lookups, 'no Street View request');
});

test('set_street_level: a capture window by year or days, and back to any date', async (t) => {
  const { runner, layer } = await runnerOverLayer(t);
  const year = await runner('set_street_level', { sinceYear: 2023 });
  assert.equal(year.ok, true, year.error);
  assert.equal(year.sinceDate, '2023-01-01');
  assert.equal(layer.getUIState().filter.sinceDays, year.sinceDays);
  assert.equal(
    year.sinceDays,
    Math.floor((Date.now() - Date.UTC(2023, 0, 1)) / 86_400_000),
  );
  assert.equal(year.say, 'Mapillary, all imagery, since Jan 2023.');
  const days = await runner('set_street_level', {
    sinceDays: 182,
    imagery: 'flat',
  });
  assert.equal(layer.getUIState().filter.sinceDays, 182);
  assert.equal(layer.getUIState().filter.pano, 'flat');
  assert.match(days.say, /^Mapillary, flat photos only, since /);
  const any = await runner('set_street_level', {
    sinceDays: 0,
    imagery: 'all',
  });
  assert.equal(any.say, 'Mapillary, all imagery, any date.');
  assert.equal(any.sinceDate, null);
  for (const bad of [
    { sinceYear: 1990 },
    { sinceYear: 2999 },
    { imagery: 'aerial' },
    { provider: 'kartaview' },
  ]) {
    const before = JSON.stringify(layer.getParams());
    const refused = await runner('set_street_level', bad);
    assert.equal(refused.ok, false, JSON.stringify(bad));
    assert.equal(JSON.stringify(layer.getParams()), before, 'nothing changed');
  }
});

test('set_street_level: Google Street View lights on Google 3D without a request, and says its panoramas are not filtered', async (t) => {
  const { runner, layer, fake } = await runnerOverLayer(t, { mapStack: 'osm' });
  await runner('set_street_level', { imagery: 'pano', sinceYear: 2023 });
  const lookups = fake.lookups.length;
  const result = await runner('set_street_level', { provider: 'google' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.provider, 'google');
  assert.equal(result.providerName, 'Google Street View');
  assert.deepEqual(
    layer
      .getUIState()
      .providers.filter((p) => p.on)
      .map((p) => p.id),
    ['google'],
  );
  assert.equal(
    fake.lookups.length,
    lookups,
    'lighting a source loads no panorama',
  );
  assert.deepEqual(result.filtersApply, { imagery: false, since: false });
  assert.equal(
    result.say,
    "Google Street View on. Its panoramas aren't filtered by type or date.",
  );
  // The filters are kept for Mapillary.
  assert.equal(layer.getUIState().filter.pano, 'pano');
});

test('set_street_level with no arguments reads the settings and changes nothing', async (t) => {
  const { runner, writes, layer } = await runnerOverLayer(t);
  await runner('set_street_level', { imagery: 'flat' });
  const before = writes.length;
  const status = await runner('set_street_level', {});
  assert.equal(status.ok, true);
  assert.deepEqual(status.changed, []);
  assert.equal(writes.length, before, 'no write');
  assert.equal(status.imagery, 'flat');
  assert.equal(status.provider, 'mapillary');
  assert.equal(layer.getUIState().filter.pano, 'flat');
});
