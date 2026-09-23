import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PbfWriter } from 'pbf';
import { mapillaryProxy } from 'gods-eye-view/server/providers/mapillary';
import {
  buildPlannerUserMessage,
  finalizePlan,
  planQuery,
  PLANNER_SYSTEM_PROMPT,
  reconcilePlanValues,
} from '../../server/providers/mapillary/planner.js';
import { normalizeFeatureQuery } from '../../server/providers/mapillary/features.js';
import {
  listTileLayers,
  stripTileLayers,
} from '../../server/providers/mapillary/trim.js';
import {
  fetchTile,
  normalizeTileAddress,
  TileRequestError,
  _resetTileMemoryForTest,
} from '../../server/providers/mapillary/tiles.js';
import { handleSprite } from '../../server/providers/mapillary/sprites.js';

/** Mount the plugin and return a caller keyed by route. */
function install(plugin, mode = 'configureServer') {
  const routes = new Map();
  plugin[mode]({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  const call = async (route, url = '/', method = 'GET', body) => {
    const handler = routes.get(route);
    assert.ok(handler, `route ${route} is mounted`);
    const headers = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      getHeader(name) {
        return headers[name.toLowerCase()];
      },
      writeHead(status, extra) {
        this.statusCode = status;
        Object.assign(headers, extra || {});
      },
      end(payload) {
        this.body = payload;
        this.writableEnded = true;
      },
      on() {},
    };
    const listeners = {};
    const req = {
      url,
      method,
      headers: {},
      on(event, fn) {
        listeners[event] = fn;
      },
      [Symbol.asyncIterator]: async function* () {
        if (body) yield Buffer.from(body);
      },
    };
    await handler(req, res);
    return { ...res, headers };
  };
  return { routes, call };
}

const json = (res) => JSON.parse(String(res.body));

test('the plugin mounts the five Mapillary routes for dev and preview servers', () => {
  for (const mode of ['configureServer', 'configurePreviewServer']) {
    const { routes } = install(mapillaryProxy(), mode);
    assert.deepEqual([...routes.keys()].sort(), [
      '/api/mapillary/features',
      '/api/mapillary/plan',
      '/api/mapillary/sprite',
      '/api/mapillary/status',
      '/api/mapillary/tiles',
    ]);
  }
});

test('status reports capabilities, never values, and rejects non-GET', async () => {
  const saved = {
    MAPILLARY_CLIENT_TOKEN: process.env.MAPILLARY_CLIENT_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.MAPILLARY_CLIENT_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const { call } = install(mapillaryProxy());
    const res = await call('/api/mapillary/status');
    assert.equal(res.statusCode, 200);
    const payload = json(res);
    assert.equal(payload.configured, false);
    assert.equal(payload.planner, false);
    assert.equal(payload.plannerModel, null);
    assert.equal(payload.limits.featureZoom, 14);
    assert.doesNotMatch(String(res.body), /MLY\||sk-ant/);
    const post = await call('/api/mapillary/status', '/', 'POST');
    assert.equal(post.statusCode, 405);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test('tile route validates the path and refuses to proxy without a token', async () => {
  const saved = process.env.MAPILLARY_CLIENT_TOKEN;
  delete process.env.MAPILLARY_CLIENT_TOKEN;
  try {
    const { call } = install(mapillaryProxy());
    const bad = await call('/api/mapillary/tiles', '/coverage/14/1/x');
    assert.equal(bad.statusCode, 400);
    const noKey = await call('/api/mapillary/tiles', '/coverage/14/1/2');
    assert.equal(noKey.statusCode, 503);
    assert.deepEqual(json(noKey), { error: 'no_key', keyRequired: true });
    const post = await call('/api/mapillary/tiles', '/coverage/14/1/2', 'POST');
    assert.equal(post.statusCode, 405);
  } finally {
    if (saved === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = saved;
  }
});

test('normalizeTileAddress enforces layer names, zoom ranges and tile bounds', () => {
  assert.equal(
    normalizeTileAddress({ layer: 'coverage', z: 3, x: 1, y: 2 }).key,
    'coverage/3/1/2',
  );
  assert.deepEqual(
    normalizeTileAddress({ layer: 'coverage', z: '14', x: '5', y: '6' })
      .dropLayers,
    ['image'],
  );
  assert.deepEqual(
    normalizeTileAddress({ layer: 'points', z: 14, x: 5, y: 6 }).dropLayers,
    [],
  );
  for (const bad of [
    { layer: 'image', z: 14, x: 1, y: 1 },
    { layer: 'points', z: 13, x: 1, y: 1 },
    { layer: 'coverage', z: 15, x: 1, y: 1 },
    { layer: 'coverage', z: 2, x: 4, y: 0 },
    { layer: 'coverage', z: 2, x: 1.5, y: 0 },
    { layer: 'coverage', z: -1, x: 0, y: 0 },
  ])
    assert.throws(
      () => normalizeTileAddress(bad),
      TileRequestError,
      JSON.stringify(bad),
    );
});

test('fetchTile serves from memory after one upstream fetch and strips the image layer', async () => {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.MAPILLARY_CLIENT_TOKEN;
  process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|test|token';
  _resetTileMemoryForTest();
  const tile = (() => {
    const writer = new PbfWriter();
    for (const name of ['sequence', 'image']) {
      writer.writeMessage(
        3,
        (layer, pbf) => {
          pbf.writeVarintField(15, 2);
          pbf.writeStringField(1, layer.name);
          if (layer.name === 'image')
            pbf.writeBytesField(4, Buffer.alloc(4000, 1));
        },
        { name },
      );
    }
    return Buffer.from(writer.finish());
  })();
  let upstreamCalls = 0;
  globalThis.fetch = async (url) => {
    upstreamCalls++;
    assert.match(
      String(url),
      /tiles\.mapillary\.com\/maps\/vtp\/mly1_public\/2\/10\/0\/0\?access_token=/,
    );
    return new Response(tile, {
      status: 200,
      headers: { 'content-type': 'application/x-protobuf' },
    });
  };
  try {
    // z10 is never requested by the app (overview z0–5, sequences z11–14), and
    // the file is removed first so an earlier test run cannot leave a disk hit.
    await fsp
      .rm(
        path.join(
          process.cwd(),
          '.gev-cache/mapillary/tiles/coverage/10/0-0.pbf',
        ),
      )
      .catch(() => {});
    const first = await fetchTile({ layer: 'coverage', z: 10, x: 0, y: 0 });
    assert.equal(first.source, 'upstream');
    assert.deepEqual(listTileLayers(first.bytes), ['sequence']);
    assert.ok(first.bytes.length < 100, 'image layer stripped in transit');
    const second = await fetchTile({ layer: 'coverage', z: 10, x: 0, y: 0 });
    assert.equal(second.source, 'memory');
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
    _resetTileMemoryForTest();
  }
});

test('sprite route only accepts taxonomy values, never paths', async () => {
  const respond = async (url) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
      end(body) {
        this.body = body;
      },
    };
    await handleSprite({ url }, res);
    return { status: res.statusCode, headers, body: res.body };
  };
  for (const bad of [
    '/..%2Fetc%2Fpasswd.svg',
    '/../x.svg',
    '/Object--Fire.svg',
    '/a..b.svg',
    '/a--.svg',
    '/.svg',
    '/x.png',
  ])
    assert.equal((await respond(bad)).status, 400, bad);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(
      String(url),
      /package_objects\/object--fire-hydrant--zz-test\.svg$/,
    );
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
      status: 200,
    });
  };
  try {
    const ok = await respond('/object--fire-hydrant--zz-test.svg');
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /image\/svg\+xml/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('normalizeFeatureQuery caps values, normalises the bbox and rejects oversized areas', () => {
  const missing = normalizeFeatureQuery({});
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 400);
  const ok = normalizeFeatureQuery({
    bbox: [-121.5, 38.55, -121.45, 38.6],
    layer: 'points',
    values: ['object--fire-hydrant', '', 'object--bench'],
    seenAfter: '2020-01-01',
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.request.values.slice(0, 2), [
    'object--fire-hydrant',
    'object--bench',
  ]);
  assert.equal(ok.request.since, Date.parse('2020-01-01'));
  assert.ok(ok.request.tiles.length > 0);
  const huge = normalizeFeatureQuery({
    bbox: [-125, 32, -114, 42],
    layer: 'points',
    values: ['object--bench'],
  });
  assert.equal(huge.ok, false);
  assert.equal(huge.error, 'area_too_large');
  assert.ok(huge.detail.tiles > huge.detail.limit);
});

// ── Planner (relocated from src/layers/mapillary/planner.test.mjs) ──────────
const basePlan = {
  intent: 'map_features',
  place: 'Sacramento, California',
  use_current_view: false,
  values: ['object--fire-hydrant'],
  seen_after: null,
  seen_before: null,
  prefer_pano: false,
  visualise: 'icons',
  title: 'Fire hydrants · Sacramento',
  answer: 'Showing fire hydrants in Sacramento.',
};

test('the system prompt is frozen text carrying the taxonomy', () => {
  assert.match(PLANNER_SYSTEM_PROMPT, /object--fire-hydrant/);
  assert.match(PLANNER_SYSTEM_PROMPT, /regulatory--stop\b/);
  assert.doesNotMatch(PLANNER_SYSTEM_PROMPT, /Today is/);
});

test('reconcilePlanValues keeps taxonomy values, expands families, drops junk', () => {
  const result = reconcilePlanValues([
    'object--fire-hydrant',
    'regulatory--stop',
    'regulatory--stop--*',
    'object--unicorn',
    'warning--nothing-like-this--*',
  ]);
  assert.deepEqual(result.values, [
    'object--fire-hydrant',
    'regulatory--stop--*',
  ]);
  assert.deepEqual(result.dropped, [
    'object--unicorn',
    'warning--nothing-like-this--*',
  ]);
});

test('finalizePlan derives the tile layer from the values', () => {
  assert.equal(finalizePlan(basePlan).layer, 'points');
  const signs = finalizePlan({
    ...basePlan,
    intent: 'map_features',
    values: ['regulatory--stop--*'],
  });
  assert.equal(signs.layer, 'signs');
  assert.equal(signs.intent, 'traffic_signs');
});

test('finalizePlan downgrades to unsupported when nothing usable survives', () => {
  const plan = finalizePlan({ ...basePlan, values: ['object--unicorn'] });
  assert.equal(plan.intent, 'unsupported');
  assert.match(plan.answer, /object--unicorn/);
});

test('finalizePlan keeps objects and reports signs on a mixed request', () => {
  const plan = finalizePlan({
    ...basePlan,
    values: ['object--fire-hydrant', 'regulatory--stop--*'],
  });
  assert.equal(plan.layer, 'points');
  assert.deepEqual(plan.values, ['object--fire-hydrant']);
  assert.deepEqual(plan.dropped, ['regulatory--stop--*']);
  assert.match(plan.answer, /different layers/);
});

test('buildPlannerUserMessage carries the date, view and previous plan', () => {
  const text = buildPlannerUserMessage({
    query: 'only after 2024',
    today: '2026-09-15',
    context: {
      view: { lat: 38.58, lon: -121.49, heightM: 1234.6, label: 'Sacramento' },
      previousPlan: basePlan,
    },
  });
  assert.match(text, /Today is 2026-09-15/);
  assert.match(
    text,
    /38\.5800, -121\.4900, camera 1235 m above ground, near Sacramento/,
  );
  assert.match(text, /Previous plan: \{"intent":"map_features"/);
  assert.match(text, /Request: only after 2024$/);
});

test('planQuery sends a cached system block and structured output config', async () => {
  const calls = [];
  const anthropic = {
    messages: {
      async create(params) {
        calls.push(params);
        return {
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...basePlan,
                values: ['object--fire-hydrant', 'bogus'],
              }),
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  };
  const result = await planQuery(
    { query: 'show me all fire hydrants in Sacramento', context: {} },
    {
      anthropic,
      model: 'claude-opus-5',
      now: new Date('2026-09-15T12:00:00Z'),
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'claude-opus-5');
  assert.deepEqual(calls[0].system[0].cache_control, { type: 'ephemeral' });
  assert.equal(calls[0].output_config.effort, 'low');
  assert.equal(calls[0].output_config.format.type, 'json_schema');
  assert.equal(calls[0].output_config.format.schema.type, 'object');
  assert.ok(!('$schema' in calls[0].output_config.format.schema));
  assert.ok(calls[0].output_config.format.schema.properties.intent);
  assert.deepEqual(result.plan.values, ['object--fire-hydrant']);
  assert.deepEqual(result.plan.dropped, ['bogus']);
  assert.equal(result.plan.layer, 'points');
});

test('planQuery turns a refusal into an unsupported plan instead of throwing', async () => {
  const anthropic = {
    messages: {
      async create() {
        return { stop_reason: 'refusal', usage: null };
      },
    },
  };
  const result = await planQuery(
    { query: 'x', context: {} },
    { anthropic, model: 'm' },
  );
  assert.equal(result.plan.intent, 'unsupported');
});

test('normalizeFeatureQuery validates bbox, layer, values and the tile cap', () => {
  const ok = normalizeFeatureQuery({
    bbox: [-121.56, 38.44, -121.36, 38.69],
    layer: 'points',
    values: ['Object--Fire-Hydrant', ''],
    seenAfter: '2024-01-01',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.request.tiles.length, 160);
  assert.deepEqual(ok.request.values, ['object--fire-hydrant']);
  assert.equal(ok.request.since, Date.parse('2024-01-01'));
  assert.equal(ok.request.until, null);
  assert.equal(normalizeFeatureQuery({ bbox: 'nope' }).status, 400);
  const huge = normalizeFeatureQuery({ bbox: [-125, 32, -114, 42] });
  assert.equal(huge.ok, false);
  assert.equal(huge.status, 413);
  assert.equal(huge.error, 'area_too_large');
});

// ── Tile trimming (relocated from server/providers/mapillary/trim.test.mjs) ──
/** Build a minimal MVT: layers with a name, a version and one opaque feature. */
function tile(layers) {
  const writer = new PbfWriter();
  for (const { name, payload } of layers) {
    writer.writeMessage(
      3,
      (layer, pbf) => {
        pbf.writeVarintField(15, 2); // version
        pbf.writeStringField(1, layer.name);
        pbf.writeMessage(2, (_f, p) => p.writeVarintField(1, 7), null); // feature
        pbf.writeVarintField(5, 4096); // extent
        if (layer.payload) pbf.writeBytesField(4, layer.payload); // a big key
      },
      { name, payload },
    );
  }
  return Buffer.from(writer.finish());
}

test('dropping a layer keeps the others byte-for-byte', () => {
  const big = Buffer.alloc(50_000, 7);
  const bytes = tile([
    { name: 'sequence' },
    { name: 'image', payload: big },
    { name: 'overview' },
  ]);
  const trimmed = stripTileLayers(bytes, ['image']);
  assert.deepEqual(listTileLayers(trimmed), ['sequence', 'overview']);
  assert.ok(trimmed.length < 200, `trimmed to ${trimmed.length} bytes`);
  assert.deepEqual(trimmed, tile([{ name: 'sequence' }, { name: 'overview' }]));
});

test('a tile without the layer is returned untouched', () => {
  const bytes = tile([{ name: 'sequence' }]);
  assert.equal(stripTileLayers(bytes, ['image']), bytes);
  assert.equal(stripTileLayers(bytes, []), bytes);
  assert.equal(stripTileLayers(Buffer.alloc(0), ['image']).length, 0);
});

test('layer names are read without decoding features', () => {
  assert.deepEqual(listTileLayers(tile([{ name: 'a' }, { name: 'b' }])), [
    'a',
    'b',
  ]);
});
