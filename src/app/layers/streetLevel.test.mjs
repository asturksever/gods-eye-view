import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationStreetLevel } from './streetLevel.js';
import { createDefaultLayerState } from '../../data/layerState.js';

test('each provider starts as its share-link option does, so a fresh page and a restored one agree', () => {
  const layer = createApplicationStreetLevel({
    surface: null,
    sources: {
      mapillary: {
        getStatus() {},
        getTile() {},
        getSequenceImages() {},
        nearestImages() {},
      },
    },
  });
  const options = createDefaultLayerState().options['street-level'];
  const providers = layer.getUIState().providers;
  assert.deepEqual(
    providers.map((p) => p.id),
    layer.providerIds,
  );
  for (const provider of providers)
    assert.equal(provider.on, options[provider.id], provider.id);
  assert.equal(options.google, false, 'Street View is billed: off');
});
