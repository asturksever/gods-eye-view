import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoogleViewer } from './viewer.js';
import {
  fakeHost,
  fakeMapsLoader,
  fakeStreetViewLibrary,
} from '../../../../testSupport/googleStreetViewFakes.mjs';

const PANORAMAS = {
  'pano-a': {
    lat: 38.5816,
    lng: -121.4944,
    imageDate: '2024-05',
    copyright: '© 2024 Google',
    description: '10th St',
  },
  'pano-b': {
    lat: 38.5817,
    lng: -121.4944,
    imageDate: '2019-08',
    copyright: 'From the Owner, Photo by: Ada',
  },
};

function setup() {
  const fake = fakeStreetViewLibrary({ panoramas: PANORAMAS });
  const loader = fakeMapsLoader(fake.library);
  const viewer = createGoogleViewer({ loader });
  const poses = [];
  viewer.onPose((pose) => poses.push(pose));
  const host = fakeHost();
  return { fake, loader, viewer, poses, host };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('opening a panorama shows it and emits a provider-neutral pose', async () => {
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  assert.equal(host.children.length, 1, 'renders in its own element');
  const [panorama] = fake.built;
  assert.equal(panorama.options.fullscreenControl, false);
  assert.equal(panorama.options.addressControl, false, 'the caption has it');
  assert.equal(panorama.options.enableCloseButton, false);
  assert.equal(panorama.visible, false, 'nothing shows before an open');

  await viewer.open('pano-a');
  assert.equal(panorama.visible, true);
  const pose = poses.at(-1);
  assert.deepEqual(
    {
      providerId: pose.providerId,
      imageId: pose.imageId,
      position: pose.position,
      isPano: pose.isPano,
      capturedAt: pose.capturedAt,
      capturedAtPrecision: pose.capturedAtPrecision,
      creator: pose.creator,
      title: pose.title,
    },
    {
      providerId: 'google',
      imageId: 'pano-a',
      position: { lon: -121.4944, lat: 38.5816 },
      isPano: true,
      capturedAt: Date.UTC(2024, 4, 1),
      capturedAtPrecision: 'month',
      creator: 'Google',
      title: '10th St',
    },
  );
  assert.match(pose.externalUrl, /map_action=pano&pano=pano-a/);
});

test('dragging the view and stepping along an arrow both emit poses; the date is looked up once per panorama', async () => {
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  await viewer.open('pano-a');
  const [panorama] = fake.built;
  panorama.setPov({ heading: 90, pitch: -10 });
  await settle();
  assert.deepEqual(
    [poses.at(-1).bearing, poses.at(-1).tilt],
    [90, -10],
    'the view follows the drag',
  );
  // Google's own arrow: the panorama changes without an open.
  panorama.setPano('pano-b');
  await settle();
  await settle();
  assert.equal(poses.at(-1).imageId, 'pano-b');
  assert.equal(poses.at(-1).creator, 'Ada');
  const dateLookups = fake.lookups.filter((request) => request.pano);
  assert.deepEqual(
    dateLookups.map((request) => request.pano),
    ['pano-a', 'pano-b'],
  );
});

test('a panorama Google has no imagery for fails the open', async () => {
  const { viewer, host } = setup();
  await viewer.mount(host);
  await assert.rejects(viewer.open('gone'), /no imagery/);
});

test('a closed panorama is hidden and its late view changes emit nothing', async () => {
  const { fake, viewer, poses, host } = setup();
  await viewer.mount(host);
  await viewer.open('pano-a');
  const [panorama] = fake.built;
  viewer.close();
  assert.equal(panorama.visible, false);
  const count = poses.length;
  panorama.setPov({ heading: 180, pitch: 0 });
  await settle();
  assert.equal(poses.length, count);
});

test('an open overtaken by a newer one only shows the newer panorama', async () => {
  const { viewer, poses, host } = setup();
  await viewer.mount(host);
  const first = viewer.open('pano-a');
  const second = viewer.open('pano-b');
  await Promise.all([first, second]);
  assert.deepEqual(
    [...new Set(poses.map((pose) => pose.imageId))].at(-1),
    'pano-b',
  );
  assert.ok(!poses.some((pose) => pose.imageId === 'pano-a'));
});

test('unmounting removes the element and every listener; prewarm builds no panorama', async () => {
  const { fake, loader, viewer, host } = setup();
  await viewer.prewarm(host);
  assert.deepEqual(loader.imports, ['streetView']);
  assert.equal(fake.built.length, 0, 'a panorama is billed: none on prewarm');
  await viewer.mount(host);
  const [panorama] = fake.built;
  assert.ok(panorama.listenerCount() > 0);
  viewer.unmount();
  assert.equal(host.children.length, 0);
  assert.equal(panorama.listenerCount(), 0);
  await assert.rejects(viewer.open('pano-a'), /not mounted/);
});

test('a key Google refuses fails the open at once, not after the timeout', async () => {
  const { fake, loader, viewer, host } = setup();
  await viewer.mount(host);
  const [panorama] = fake.built;
  // Google refuses the key while the panorama loads; it never reports OK.
  panorama.setPano = (id) => {
    panorama.pano = id;
    queueMicrotask(() => loader.refuseKey());
  };
  await assert.rejects(viewer.open('pano-a'), /enable the Maps JavaScript API/);
  await assert.rejects(viewer.open('pano-b'), /enable the Maps JavaScript API/);
  assert.equal(loader.listenerCount(), 0, 'no auth listener is left behind');
});
