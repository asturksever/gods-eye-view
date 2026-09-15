import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlannerUserMessage,
  finalizePlan,
  planQuery,
  PLANNER_SYSTEM_PROMPT,
  reconcilePlanValues,
} from '../../../server/providers/mapillary/planner.js';
import { normalizeFeatureQuery } from '../../../server/providers/mapillary/features.js';

const basePlan = {
  intent: 'map_features',
  place: 'Sacramento, California',
  use_current_view: false,
  values: ['object--fire-hydrant'],
  seen_after: null,
  seen_before: null,
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
      async parse(params) {
        calls.push(params);
        return {
          stop_reason: 'end_turn',
          parsed_output: {
            ...basePlan,
            values: ['object--fire-hydrant', 'bogus'],
          },
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
  assert.deepEqual(result.plan.values, ['object--fire-hydrant']);
  assert.deepEqual(result.plan.dropped, ['bogus']);
  assert.equal(result.plan.layer, 'points');
});

test('planQuery turns a refusal into an unsupported plan instead of throwing', async () => {
  const anthropic = {
    messages: {
      async parse() {
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
