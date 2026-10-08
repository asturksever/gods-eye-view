import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGroundClick } from './groundClick.js';
import { isPickedWorldPosition } from '../../data/scenePick.js';

const GROUND = Cesium.Cartesian3.fromDegrees(-121.4944, 38.5816, 10);

/** A layer state with providers `{id, on, groundClick, configured}` and a camera `height` m up. */
function harness({
  providers = [
    { id: 'mapillary', groundClick: false },
    { id: 'google', groundClick: true },
  ],
  height = 400,
  enabled = true,
  picked = GROUND,
} = {}) {
  const opened = [];
  const state = {
    enabled,
    services: { scenePick: { isPickedWorldPosition } },
    providers: new Map(
      providers.map(({ id, on = true, groundClick, configured = true }) => [
        id,
        {
          on,
          def: { id, groundClick },
          status: { configured },
        },
      ]),
    ),
    viewer: {
      scene: {
        pickPositionSupported: true,
        pickPosition: () => picked,
        globe: { getHeight: () => 10 },
      },
      camera: {
        positionCartographic: Cesium.Cartographic.fromDegrees(
          -121.4944,
          38.5816,
          10 + height,
        ),
        pickEllipsoid: () => undefined,
      },
    },
  };
  const openAtGround = createGroundClick({
    state,
    parts: {},
    openNearest: (point, options) => {
      opened.push({ point, options });
      return Promise.resolve(true);
    },
  });
  return { state, opened, openAtGround };
}

test('a ground click at street zoom opens the nearest image of the click-to-open providers there', () => {
  const { opened, openAtGround } = harness();
  openAtGround({ x: 10, y: 20 });
  assert.equal(opened.length, 1);
  const [{ point, options }] = opened;
  assert.ok(Math.abs(point.lon - -121.4944) < 1e-9);
  assert.ok(Math.abs(point.lat - 38.5816) < 1e-9);
  assert.deepEqual(options, { providerIds: ['google'] });
});

test('nothing opens from high up, over the sky, with the provider off or unconfigured, or the layer off', () => {
  for (const options of [
    { height: 5000 },
    { picked: null },
    { picked: new Cesium.Cartesian3(500, 0, 0) },
    { providers: [{ id: 'google', groundClick: true, on: false }] },
    { providers: [{ id: 'google', groundClick: true, configured: false }] },
    { providers: [{ id: 'mapillary', groundClick: false }] },
    { enabled: false },
  ]) {
    const { opened, openAtGround } = harness(options);
    assert.equal(openAtGround({ x: 1, y: 1 }), false, JSON.stringify(options));
    assert.equal(opened.length, 0);
  }
});
