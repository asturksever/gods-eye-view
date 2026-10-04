#!/usr/bin/env node
/**
 * Browser proof of Me Mode: Pegman entry, avatar load, WASD/Shift clip changes,
 * first-person view, voice placement/walk, fly_to redirect, camera restore and
 * the `?avatar=` swap. Screenshots go to docs/avatar-demo/ when
 * QA_SCREENSHOTS=1.
 *
 *   npm run dev   # in another terminal
 *   node scripts/qa-me-mode.mjs [--second-avatar=/avatars/other.glb]
 *
 * Ground contact is measured against whatever surface is loaded: with a Google
 * key that is the photoreal tileset; keyless it is the terrain globe.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const BASE = process.env.QA_BASE_URL || 'http://localhost:4173';
const SHOTS = process.env.QA_SCREENSHOTS === '1' ? 'docs/avatar-demo' : null;
const secondAvatar =
  process.argv
    .find((arg) => arg.startsWith('--second-avatar='))
    ?.split('=')[1] || null;
const KINGS_CROSS = { lat: 51.5308, lon: -0.1238 };
const TIMES_SQUARE = { lat: 40.758, lon: -73.9855 };

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  protocolTimeout: 300000,
  args: [
    '--no-sandbox',
    '--window-size=1280,800',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
let failures = 0;
const check = (name, passed, detail = '') => {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(page, search = '') {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${BASE}/?welcome=0${search}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.dataManager?.layers?.get('avatar'),
    { timeout: 120000 },
  );
  return errors;
}

const avatarState = () => {
  const { viewer, dataManager } = window.__godsEyeView;
  const avatar = dataManager.layers.get('avatar').module;
  const primitives = viewer.scene.primitives;
  let model = null;
  for (let i = 0; i < primitives.length; i++) {
    if (primitives.get(i)?.id === 'me-mode-avatar') model = primitives.get(i);
  }
  const animations = model?.activeAnimations;
  return {
    active: avatar.isActive(),
    pose: avatar.getPose(),
    stats: avatar.getStats(),
    inputs: viewer.scene.screenSpaceCameraController.enableInputs,
    modelShown: Boolean(model?.show),
    clip: animations?.length ? animations.get(0).name : null,
    bodyClass: document.body.classList.contains('me-mode'),
    hint: Boolean(document.querySelector('.me-mode-hint')),
  };
};

/** Surface height under the avatar, excluding the avatar itself. */
const groundGap = async () => {
  const { viewer, dataManager } = window.__godsEyeView;
  const pose = dataManager.layers.get('avatar').module.getPose();
  const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
  // Keyless with the ellipsoid fallback terrain, the surface is exactly 0 m.
  if (
    viewer.scene.globe.show &&
    viewer.terrainProvider.constructor.name === 'EllipsoidTerrainProvider'
  )
    return pose.height;
  const primitives = viewer.scene.primitives;
  const exclude = [];
  for (let i = 0; i < primitives.length; i++)
    if (primitives.get(i)?.id === 'me-mode-avatar')
      exclude.push(primitives.get(i));
  // The surface under the feet: first hit of a ray from 1.2 m above them
  // (a top-down sample would read the canopy or roof overhead instead).
  const C3 = viewer.camera.position.constructor;
  const origin = C3.fromDegrees(pose.lon, pose.lat, pose.height + 1.2);
  const down = C3.negate(C3.normalize(origin, new C3()), new C3());
  const Ray = (await import('/node_modules/cesium/Build/Cesium/index.js')).Ray;
  const hit = viewer.scene.pickFromRay(new Ray(origin, down), exclude);
  if (!hit?.position) return null;
  const ground = Cesium.Cartographic.fromCartesian(hit.position).height;
  return pose.height - ground;
};

async function hold(page, keys, ms) {
  await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    window.__meModeFrames = 0;
    window.__meModeFrameCounter?.();
    window.__meModeFrameCounter = viewer.scene.postRender.addEventListener(
      () => window.__meModeFrames++,
    );
  });
  for (const key of keys) await page.keyboard.down(key);
  await sleep(ms);
  const mid = await page.evaluate(avatarState);
  mid.fps = await page.evaluate(
    (seconds) => window.__meModeFrames / seconds,
    ms / 1000,
  );
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
  return mid;
}

async function screenshot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  console.log(`  saved ${SHOTS}/${name}.png`);
}

try {
  const page = await browser.newPage();
  const errors = await open(page);
  await sleep(3000);
  check(
    'app loads with Me Mode off',
    !(await page.evaluate(avatarState)).active,
  );

  // Start from a camera looking at Kings Cross. Re-apply until it sticks:
  // GEV's startup camera flight can still be running on a slow renderer.
  await page.waitForFunction(
    async ({ lat, lon }) => {
      const { viewer } = window.__godsEyeView;
      const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
      const here = viewer.camera.positionCartographic;
      if (
        Math.abs(Cesium.Math.toDegrees(here.latitude) - (lat - 0.0025)) <
          1e-4 &&
        Math.abs(Cesium.Math.toDegrees(here.longitude) - lon) < 1e-4
      )
        return true;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.0025, 260),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
      });
      return false;
    },
    { timeout: 60000, polling: 1000 },
    KINGS_CROSS,
  );
  await sleep(1500);

  const entry = await page.evaluate(() => ({
    pegman: Boolean(document.querySelector('.me-mode-pegman:not([hidden])')),
    row: Boolean(
      document.querySelector('#data-toggles [data-layer-id="avatar"]'),
    ),
  }));
  check(
    'Pegman is on the map and Me Mode is not a layer row',
    entry.pegman && !entry.row,
    JSON.stringify(entry),
  );
  // A Pegman click (no drag) drops the avatar at the centre of the view.
  const clickToggle = async () => {
    const rect = await page.evaluate(() => {
      const box = document
        .querySelector('.me-mode-pegman')
        .getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await page.mouse.click(rect.x, rect.y);
  };
  await clickToggle();
  await page.waitForFunction(
    () => {
      const avatar =
        window.__godsEyeView.dataManager.layers.get('avatar').module;
      return avatar.getStats().count === 1 || avatar.getStats().error;
    },
    { timeout: 120000 },
  );
  await page
    .waitForFunction(
      () => {
        const { viewer } = window.__godsEyeView;
        for (let i = 0; i < viewer.scene.primitives.length; i++) {
          const model = viewer.scene.primitives.get(i);
          if (model?.id === 'me-mode-avatar')
            return model.activeAnimations.length > 0;
        }
        return false;
      },
      { timeout: 30000 },
    )
    .catch(() => {});
  let state = await page.evaluate(avatarState);
  check(
    'avatar loaded and Me Mode active',
    state.active && state.stats.count === 1,
    state.stats.error || '',
  );
  check('camera inputs are taken over', state.inputs === false);
  check('hint and body class shown', state.hint && state.bodyClass);
  const hintOnTop = await page.evaluate(() => {
    const hint = document.querySelector('.me-mode-hint');
    // The hint ignores the pointer; hit-test it as if it did not.
    hint.style.pointerEvents = 'auto';
    const rect = hint.getBoundingClientRect();
    const top = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    hint.style.pointerEvents = 'none';
    return top === hint || hint.contains(top);
  });
  check('hint is not covered by other UI', hintOnTop);
  check(
    'idle clip plays while standing',
    /idle|survey/i.test(state.clip || ''),
    state.clip,
  );
  const startDistance = Math.hypot(
    (state.pose.lat - KINGS_CROSS.lat) * 111320,
    (state.pose.lon - KINGS_CROSS.lon) *
      111320 *
      Math.cos((KINGS_CROSS.lat * Math.PI) / 180),
  );
  check(
    'avatar starts at the camera target',
    startDistance < 50,
    `${startDistance.toFixed(1)} m from Kings Cross`,
  );
  let gap = await page.evaluate(groundGap);
  check(
    'feet on the surface at start',
    gap !== null && Math.abs(gap) < 0.3,
    `gap ${gap?.toFixed(3)} m`,
  );
  await screenshot(page, 'kings-cross-start');

  const before = state.pose;
  const walking = await hold(page, ['KeyW'], 2500);
  check(
    'W walks with the walk clip',
    /walk/i.test(walking.clip || '') &&
      Math.abs(walking.pose.speed - 2.8) < 0.01,
    `${walking.clip} @ ${walking.pose.speed} m/s`,
  );
  const running = await hold(page, ['ShiftLeft', 'KeyW'], 2500);
  check(
    'Shift+W runs with the run clip',
    /run/i.test(running.clip || '') && Math.abs(running.pose.speed - 16) < 0.01,
    `${running.clip} @ ${running.pose.speed} m/s`,
  );
  await sleep(800);
  state = await page.evaluate(avatarState);
  const moved = Math.hypot(
    (state.pose.lat - before.lat) * 111320,
    (state.pose.lon - before.lon) *
      111320 *
      Math.cos((before.lat * Math.PI) / 180),
  );
  // Expected travel is speed × time, capped by the frame clamp (0.25 s/frame)
  // on very slow software renderers.
  const expected =
    2.8 * Math.min(2.5, walking.fps * 2.5 * 0.25) +
    16 * Math.min(2.5, running.fps * 2.5 * 0.25);
  check(
    'avatar moved forward at the stated speed',
    moved > expected * 0.6,
    `${moved.toFixed(1)} m, expected ~${expected.toFixed(1)} m at ${walking.fps.toFixed(1)}/${running.fps.toFixed(1)} fps`,
  );
  check(
    'back to idle after release',
    /idle|survey/i.test(state.clip || ''),
    state.clip,
  );
  gap = await page.evaluate(groundGap);
  check(
    'feet on the surface after walking',
    gap !== null && Math.abs(gap) < 0.3,
    `gap ${gap?.toFixed(3)} m`,
  );
  await screenshot(page, 'kings-cross-walked');

  // Controlled street: the globe hidden, a ground slab (top at 0 m) and a
  // tree canopy slab 6–7 m up, both under the avatar. A top-down sample reads
  // the canopy; the avatar must be placed on, and walk along, the ground.
  const canopy = await page.evaluate(async () => {
    const { viewer, dataManager } = window.__godsEyeView;
    const C3 = viewer.camera.position.constructor; // the app's Cesium
    const Cartographic = viewer.camera.positionCartographic.constructor;
    const avatar = dataManager.layers.get('avatar').module;
    const { lon, lat, height: ground } = avatar.getPose();
    window.__qaGlobeShown = viewer.scene.globe.show;
    viewer.scene.globe.show = false;
    window.__qaSlabs = [
      viewer.entities.add({
        position: C3.fromDegrees(lon, lat, ground - 0.5),
        box: { dimensions: new C3(60, 60, 1) },
      }),
      viewer.entities.add({
        position: C3.fromDegrees(lon, lat, ground + 6.5),
        box: { dimensions: new C3(60, 60, 1) },
      }),
    ];
    let model;
    for (let i = 0; i < viewer.scene.primitives.length; i++)
      if (viewer.scene.primitives.get(i)?.id === 'me-mode-avatar')
        model = viewer.scene.primitives.get(i);
    let top;
    for (let i = 0; i < 60; i++) {
      top = viewer.scene.sampleHeight(Cartographic.fromDegrees(lon, lat), [
        model,
      ]);
      if (top > ground + 6) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const placed = await avatar.setPosition(lon, lat);
    return {
      top: top - ground,
      placedHeight: placed.height - ground,
      grounded: placed.grounded,
      ground,
    };
  });
  check(
    'a top-down sample would stand on the canopy',
    canopy.top > 6,
    `top-down ${canopy.top?.toFixed(2)} m`,
  );
  check(
    'placement under the canopy lands on the ground',
    Math.abs(canopy.placedHeight) < 0.3,
    `placed at ${canopy.placedHeight?.toFixed(2)} m (grounded ${canopy.grounded})`,
  );
  await hold(page, ['KeyW'], 2000);
  await sleep(2500);
  state = await page.evaluate(avatarState);
  await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    window.__qaSlabs.forEach((entity) => viewer.entities.remove(entity));
    viewer.scene.globe.show = window.__qaGlobeShown;
  });
  check(
    'walking under the canopy stays on the ground',
    Math.abs(state.pose.height - canopy.ground) < 0.3,
    `avatar at ${state.pose.height.toFixed(2)} m`,
  );
  await screenshot(page, 'under-canopy');

  // A drop on a big roof (60 × 60 m block, 20 m tall) must land on the
  // street beside it, even when the road lookup is unavailable.
  const roofDrop = await page.evaluate(async () => {
    const { viewer, dataManager } = window.__godsEyeView;
    const C3 = viewer.camera.position.constructor;
    const Cartographic = viewer.camera.positionCartographic.constructor;
    const avatar = dataManager.layers.get('avatar').module;
    const { lon, lat, height: ground } = avatar.getPose();
    const globeShown = viewer.scene.globe.show;
    viewer.scene.globe.show = false;
    const slabs = [
      viewer.entities.add({
        position: C3.fromDegrees(lon, lat, ground - 0.5),
        box: { dimensions: new C3(400, 400, 1) },
      }),
      viewer.entities.add({
        position: C3.fromDegrees(lon, lat, ground + 10),
        box: { dimensions: new C3(60, 60, 20) },
      }),
    ];
    let roof;
    for (let i = 0; i < 60; i++) {
      roof = viewer.scene.sampleHeight(Cartographic.fromDegrees(lon, lat));
      if (roof > ground + 15) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const placed = await avatar.setPosition(lon, lat);
    const offset = Math.hypot(
      (placed.lat - lat) * 111320,
      (placed.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180),
    );
    slabs.forEach((entity) => viewer.entities.remove(entity));
    viewer.scene.globe.show = globeShown;
    return {
      roof: roof - ground,
      height: placed.height - ground,
      offset,
      snapped: placed.snapped,
    };
  });
  check(
    'a drop on a roof lands at street level beside the building',
    roofDrop.roof > 15 &&
      Math.abs(roofDrop.height) < 0.5 &&
      roofDrop.offset > 30,
    JSON.stringify(roofDrop),
  );

  // A wall between the avatar and the follow camera pulls the camera in
  // front of it; with the wall gone the camera eases back out.
  const eyeToCamera = () =>
    page.evaluate(() => {
      const { viewer, dataManager } = window.__godsEyeView;
      const C3 = viewer.camera.position.constructor;
      const pose = dataManager.layers.get('avatar').module.getPose();
      const eye = C3.fromDegrees(pose.lon, pose.lat, pose.height + 1.6);
      return C3.distance(eye, viewer.camera.positionWC);
    });
  const clearRange = await eyeToCamera();
  await page.evaluate(() => {
    const { viewer, dataManager } = window.__godsEyeView;
    const C3 = viewer.camera.position.constructor;
    const pose = dataManager.layers.get('avatar').module.getPose();
    const eye = C3.fromDegrees(pose.lon, pose.lat, pose.height + 1.6);
    const mid = C3.lerp(eye, viewer.camera.positionWC, 0.5, new C3());
    window.__qaWall = viewer.entities.add({
      position: mid,
      box: { dimensions: new C3(2, 2, 2) },
    });
  });
  // The wall's geometry is built asynchronously; wait for it to take effect.
  let blockedRange = await eyeToCamera();
  for (let i = 0; i < 20 && blockedRange > clearRange / 2 + 0.5; i++) {
    await sleep(1000);
    blockedRange = await eyeToCamera();
  }
  await page.evaluate(() =>
    window.__godsEyeView.viewer.entities.remove(window.__qaWall),
  );
  // Easing is per rendered frame; slow software renderers need longer.
  let recoveredRange = await eyeToCamera();
  for (let i = 0; i < 15 && Math.abs(recoveredRange - clearRange) >= 0.5; i++) {
    await sleep(1000);
    recoveredRange = await eyeToCamera();
  }
  check(
    'follow camera pulls in front of an obstruction',
    blockedRange < clearRange / 2 + 0.5,
    `${clearRange.toFixed(1)} m clear → ${blockedRange.toFixed(1)} m blocked`,
  );
  check(
    'follow camera eases back out when clear',
    Math.abs(recoveredRange - clearRange) < 0.5,
    `${recoveredRange.toFixed(1)} m`,
  );

  // Panel controls keep their arrow keys; the globe gets no context menu.
  const keyChecks = await page.evaluate(() => {
    const button = document.querySelector('#data-toggles .data-toggle-btn');
    button.focus();
    const arrow = new KeyboardEvent('keydown', {
      code: 'ArrowDown',
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(arrow);
    button.dispatchEvent(
      new KeyboardEvent('keyup', { code: 'ArrowDown', bubbles: true }),
    );
    button.blur();
    const menu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    window.__godsEyeView.viewer.scene.canvas.dispatchEvent(menu);
    return {
      arrowSwallowed: arrow.defaultPrevented,
      menuSuppressed: menu.defaultPrevented,
    };
  });
  check(
    'arrow keys on a focused panel control stay native',
    !keyChecks.arrowSwallowed,
  );
  check('no context menu on the globe', keyChecks.menuSuppressed);

  // Shortcut isolation: W must not trigger POI flights, V not clean view.
  await page.keyboard.press('KeyV');
  await sleep(300);
  state = await page.evaluate(avatarState);
  check(
    'V switches to first person and hides the model',
    state.pose.view === 'first-person' && !state.modelShown,
  );
  check(
    'V did not toggle clean view',
    !(await page.evaluate(() =>
      document.body.classList.contains('ui-clean-view'),
    )),
  );
  await page.keyboard.press('KeyV');
  await sleep(300);
  state = await page.evaluate(avatarState);
  check(
    'V returns to third person',
    state.pose.view === 'third-person' && state.modelShown,
  );

  // The on-screen button toggles first person too, and labels the mode.
  const viewButton = await page.evaluate(async () => {
    const button = document.querySelector('.me-mode-view-toggle');
    const pose = () =>
      window.__godsEyeView.dataManager.layers.get('avatar').module.getPose()
        .view;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const first = { view: pose(), label: button.textContent };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      first,
      back: { view: pose(), label: button.textContent },
      focusReturned: document.activeElement !== button,
    };
  });
  check(
    'view button switches to first person and back',
    viewButton.first.view === 'first-person' &&
      /first/i.test(viewButton.first.label) &&
      viewButton.back.view === 'third-person' &&
      viewButton.focusReturned,
    JSON.stringify(viewButton),
  );

  // Fly: F takes off, E climbs, WASD flies, F lands by falling to the ground.
  await page.keyboard.press('KeyF');
  await sleep(500);
  const takeoff = await page.evaluate(avatarState);
  await hold(page, ['KeyE'], 3000);
  const climbed = await page.evaluate(avatarState);
  await hold(page, ['KeyW'], 2000);
  const flown = await page.evaluate(avatarState);
  check(
    'F takes off and E climbs',
    takeoff.pose.flying && climbed.pose.height - takeoff.pose.height > 3,
    `${takeoff.pose.height.toFixed(1)} → ${climbed.pose.height.toFixed(1)} m`,
  );
  check(
    'WASD flies forward without losing height',
    flown.pose.flying &&
      Math.hypot(
        (flown.pose.lat - climbed.pose.lat) * 111320,
        (flown.pose.lon - climbed.pose.lon) * 70000,
      ) > 5 &&
      flown.pose.height >= climbed.pose.height - 0.5,
    `${flown.pose.height.toFixed(1)} m`,
  );
  await page.keyboard.press('KeyF');
  let landed = await page.evaluate(avatarState);
  for (
    let i = 0;
    i < 20 && landed.pose.height > takeoff.pose.height + 0.3;
    i++
  ) {
    await sleep(1000);
    landed = await page.evaluate(avatarState);
  }
  check(
    'F again lands back on the ground',
    !landed.pose.flying &&
      Math.abs(landed.pose.height - takeoff.pose.height) < 0.3,
    `${landed.pose.height.toFixed(2)} m`,
  );

  // Voice tools through the real action runner.
  const voice = await page.evaluate(async (target) => {
    const { createGevActionRunner } = await import('/src/voice/gevActions.js');
    const { viewer, styleManager, dataManager } = window.__godsEyeView;
    const run = createGevActionRunner({ viewer, styleManager, dataManager });
    const place = await run('place_avatar', {
      query: 'Times Square',
      latitude: target.lat,
      longitude: target.lon,
    });
    const pose = dataManager.layers.get('avatar').module.getPose();
    const near = await run('move_avatar_to', {
      latitude: target.lat + 0.0002,
      longitude: target.lon,
    });
    const view = await run('get_current_view_state', {});
    return { place, pose, near, avatar: view.avatar };
  }, TIMES_SQUARE);
  check(
    'place_avatar teleports to Times Square',
    voice.place.ok &&
      voice.place.mode === 'teleported' &&
      Math.abs(voice.pose.lat - TIMES_SQUARE.lat) < 1e-6,
    JSON.stringify({ grounded: voice.place.groundConfirmed }),
  );
  check(
    'move_avatar_to walks a short distance',
    voice.near.ok &&
      voice.near.mode === 'walking' &&
      voice.near.distanceM === 22,
    JSON.stringify(voice.near),
  );
  check(
    'view state carries the avatar pose',
    voice.avatar?.active && typeof voice.avatar.facing === 'string',
    JSON.stringify(voice.avatar),
  );
  await sleep(4000);
  state = await page.evaluate(avatarState);
  check(
    'autopilot walks toward the target',
    /walk/i.test(state.clip || '') ||
      state.pose.lat > TIMES_SQUARE.lat + 0.00005,
    `${state.clip}, lat ${state.pose.lat.toFixed(6)}`,
  );
  gap = await page.evaluate(groundGap);
  check(
    'feet on the surface at Times Square',
    gap !== null && Math.abs(gap) < 0.3,
    `gap ${gap?.toFixed(3)} m`,
  );
  await screenshot(page, 'times-square');

  const redirect = await page.evaluate(async (target) => {
    const { createGevActionRunner } = await import('/src/voice/gevActions.js');
    const { viewer, styleManager, dataManager } = window.__godsEyeView;
    const run = createGevActionRunner({ viewer, styleManager, dataManager });
    return run('fly_to_location', {
      latitude: target.lat,
      longitude: target.lon,
    });
  }, KINGS_CROSS);
  check(
    'fly_to_location moves the avatar while Me Mode is on',
    redirect.action === 'place_avatar' && redirect.mode === 'teleported',
  );

  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () =>
      !window.__godsEyeView.dataManager.layers.get('avatar').module.isActive(),
    { timeout: 30000 },
  );
  state = await page.evaluate(avatarState);
  check(
    'Escape on the globe ends Me Mode and restores camera inputs',
    state.inputs === true &&
      !state.hint &&
      !state.bodyClass &&
      state.clip === null,
  );

  // Another camera owner (search, POI key, voice camera tool) takes over:
  // Me Mode hands the camera over instead of pulling it back.
  await clickToggle();
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('avatar').module.getStats()
        .count === 1,
    { timeout: 120000 },
  );
  await sleep(1500);
  // A one-frame nudge (Cesium's collision push, any correction) must not
  // end Me Mode, and Cesium's own camera collision is off while it runs.
  const nudge = await page.evaluate(async () => {
    const { viewer, dataManager } = window.__godsEyeView;
    const C3 = viewer.camera.position.constructor;
    const controller = viewer.scene.screenSpaceCameraController;
    const collisionOff = controller.enableCollisionDetection === false;
    const up = C3.normalize(viewer.camera.positionWC, new C3());
    const pushed = C3.add(
      viewer.camera.positionWC,
      C3.multiplyByScalar(up, 2, new C3()),
      new C3(),
    );
    viewer.camera.setView({
      destination: pushed,
      orientation: {
        direction: viewer.camera.directionWC,
        up: viewer.camera.upWC,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return {
      collisionOff,
      active: dataManager.layers.get('avatar').module.isActive(),
    };
  });
  check(
    'a one-frame camera nudge does not end Me Mode',
    nudge.active,
    JSON.stringify(nudge),
  );
  check(
    "Cesium's camera collision is off while Me Mode runs",
    nudge.collisionOff,
  );

  const handoff = await page.evaluate(async ({ lat, lon }) => {
    const { viewer, dataManager } = window.__godsEyeView;
    const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 2000),
    });
    const avatar = dataManager.layers.get('avatar').module;
    for (let i = 0; i < 60 && avatar.isActive(); i++)
      await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      active: avatar.isActive(),
      height: viewer.camera.positionCartographic.height,
      inputs: viewer.scene.screenSpaceCameraController.enableInputs,
      collision:
        viewer.scene.screenSpaceCameraController.enableCollisionDetection,
    };
  }, KINGS_CROSS);
  check(
    'an outside camera move ends Me Mode and keeps the new view',
    !handoff.active &&
      Math.abs(handoff.height - 2000) < 5 &&
      handoff.inputs === true &&
      handoff.collision === true,
    JSON.stringify(handoff),
  );

  // Cockpit: entering it ends Me Mode without handing mouse input back,
  // and Me Mode refuses to start while Cockpit owns the camera.
  await clickToggle();
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('avatar').module.getStats()
        .count === 1,
    { timeout: 120000 },
  );
  await sleep(1000);
  const cockpit = await page.evaluate(async () => {
    const { viewer, dataManager } = window.__godsEyeView;
    const avatar = dataManager.layers.get('avatar').module;
    const controller = viewer.scene.screenSpaceCameraController;
    // Simulate Cockpit's enter() order: inputs off, class, then the event.
    controller.enableInputs = false;
    document.body.classList.add('cockpit-mode');
    window.dispatchEvent(
      new CustomEvent('gev:cockpit-mode-changed', {
        detail: { active: true, subjectId: 'qa', layerId: 'flights' },
      }),
    );
    for (let i = 0; i < 60 && avatar.isActive(); i++)
      await new Promise((resolve) => setTimeout(resolve, 500));
    const afterEnter = {
      active: avatar.isActive(),
      inputs: controller.enableInputs,
    };
    await dataManager.setEnabled('avatar', true, { origin: 'user' });
    const refused = {
      active: avatar.isActive(),
      error: avatar.getStats().error,
    };
    document.body.classList.remove('cockpit-mode');
    controller.enableInputs = true;
    window.dispatchEvent(
      new CustomEvent('gev:cockpit-mode-changed', {
        detail: { active: false },
      }),
    );
    return { afterEnter, refused };
  });
  check(
    'Cockpit entry ends Me Mode and leaves mouse input off',
    !cockpit.afterEnter.active && cockpit.afterEnter.inputs === false,
    JSON.stringify(cockpit.afterEnter),
  );
  check(
    'Me Mode refuses to start while Cockpit is active',
    !cockpit.refused.active && /cockpit/i.test(cockpit.refused.error || ''),
    JSON.stringify(cockpit.refused),
  );

  // Drag the Pegman onto a point of the map: Me Mode starts there.
  await sleep(1500);
  const dragFrom = await page.evaluate(() => {
    const rect = document
      .querySelector('.me-mode-pegman')
      .getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const dropTarget = await page.evaluate(async () => {
    const { viewer } = window.__godsEyeView;
    const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
    const point = new Cesium.Cartesian2(500, 520);
    const position = viewer.camera.pickEllipsoid(point);
    const carto = Cesium.Cartographic.fromCartesian(position);
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    };
  });
  await page.mouse.move(dragFrom.x, dragFrom.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++)
    await page.mouse.move(
      dragFrom.x + ((500 - dragFrom.x) * i) / 10,
      dragFrom.y + ((520 - dragFrom.y) * i) / 10,
    );
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('avatar').module.getStats()
        .count === 1,
    { timeout: 120000 },
  );
  const dropped = await page.evaluate(avatarState);
  const dropError = Math.hypot(
    (dropped.pose.lat - dropTarget.lat) * 111320,
    (dropped.pose.lon - dropTarget.lon) *
      111320 *
      Math.cos((dropTarget.lat * Math.PI) / 180),
  );
  check(
    'dragging the Pegman onto the map drops the avatar there',
    dropped.active && dropError < 30,
    `${dropError.toFixed(1)} m from the drop point`,
  );
  await screenshot(page, 'pegman-drop');

  const avatarErrors = errors.filter((text) => /me mode|avatar/i.test(text));
  check(
    'no Me Mode console errors',
    avatarErrors.length === 0,
    avatarErrors.join(' | '),
  );
  if (errors.length)
    console.log(
      `  other console errors (${errors.length}):`,
      errors.slice(0, 5),
    );
  await page.close();

  if (secondAvatar) {
    const second = await browser.newPage();
    await open(second, `&avatar=${encodeURIComponent(secondAvatar)}`);
    await sleep(2000);
    await second.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('avatar', true, {
        origin: 'user',
      }),
    );
    await second.waitForFunction(
      () =>
        window.__godsEyeView.dataManager.layers.get('avatar').module.getStats()
          .count === 1,
      { timeout: 120000 },
    );
    const swapped = await hold(second, ['KeyW'], 1500);
    check(
      `?avatar=${secondAvatar} loads and animates`,
      swapped.active && Boolean(swapped.clip),
      swapped.clip,
    );
    await screenshot(second, 'second-avatar');
    await second.close();
  }
} finally {
  await browser.close();
}
console.log(
  failures ? `${failures} check(s) failed` : 'All Me Mode checks passed',
);
process.exit(failures ? 1 : 0);
