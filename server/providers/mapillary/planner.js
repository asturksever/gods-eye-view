import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { readRequestBody } from '../common/request.js';
import { makeOptInRateLimiter, clientKey } from '../common/rate-limit.js';
import {
  PLANNER_MAX_BODY_BYTES,
  PLANNER_MAX_QUERY_CHARS,
  PLANNER_MAX_TOKENS,
  anthropicConfigured,
  mapillaryToken,
  plannerModel,
} from './constants.js';
import {
  OBJECT_VALUES,
  SIGN_FAMILIES,
  SIGN_VALUES,
} from '../../../src/layers/mapillary/taxonomy.js';
import {
  createValueMatcher,
  isSignValue,
  normalizeValuePattern,
} from '../../../src/layers/mapillary/values.js';

/**
 * The plan the model returns. Every field is required (structured outputs
 * reject optional keys); "unknown" is spelled with null.
 */
export const PlanSchema = z.object({
  intent: z.enum([
    'map_features',
    'traffic_signs',
    'coverage',
    'nearest_image',
    'unsupported',
  ]),
  place: z.string().nullable(),
  use_current_view: z.boolean(),
  values: z.array(z.string()),
  seen_after: z.string().nullable(),
  seen_before: z.string().nullable(),
  visualise: z.enum(['icons', 'points', 'count']),
  title: z.string(),
  answer: z.string(),
});

/**
 * Frozen system prompt. Nothing volatile lives here so the block can be
 * prompt-cached across every query; the date and view context ride in the
 * user turn instead.
 */
export const PLANNER_SYSTEM_PROMPT = [
  "You translate natural-language requests about street-level map data into a query plan for God's Eye View, a 3D globe that can draw Mapillary map features (objects detected in street imagery) and traffic signs, show Mapillary coverage, or open the nearest street-level image.",
  '',
  'Return ONLY a plan object. Field rules:',
  '- intent: "map_features" for objects (hydrants, benches, poles, manholes, traffic lights, road markings…); "traffic_signs" for signs (stop, speed limit, no parking, pedestrian crossing…); "coverage" when the user asks where imagery exists or how recent it is; "nearest_image" when they want to see/open/look at the street view of a place; "unsupported" when the request is not about Mapillary data (then explain in `answer`).',
  '- place: the place to search, as a geocodable string ("Sacramento, California"; "Detroit, Michigan"; "Shinjuku, Tokyo"). null when the user means the current view ("here", "around me", "in this area") or gives no place at all.',
  '- use_current_view: true when place is null and the current view should be used.',
  '- values: Mapillary taxonomy values for the requested things. Use exact values from the lists below. A wildcard `*` matches a run of characters: use `regulatory--stop--*` to cover every regional variant of a sign family, `object--traffic-light--*` for all traffic lights, `marking--discrete--arrow--*` for all arrow markings. Include several values when the request is broad ("street furniture" → benches, trash cans, bike racks, mailboxes). Leave empty only for coverage or nearest_image intents.',
  '- seen_after / seen_before: ISO dates (YYYY-MM-DD) when the user constrains time ("since 2024", "before 2022", "in the last two years" relative to today); otherwise null.',
  '- visualise: "icons" by default; "points" when the user asks for density or a very broad class; "count" when they only ask how many.',
  '- title: a short HUD title, e.g. "Fire hydrants · Sacramento".',
  '- answer: one plain sentence confirming what will be shown, mentioning any interpretation you made. Never claim counts; the data has not been fetched yet.',
  '',
  'Follow-ups: when a previous plan is supplied and the new request refines the same subject ("only the ones seen after 2024", "just the panoramas", "same thing in Detroit"), start from the previous plan and change only what the request changes. A request that names a new subject or a new place ("stop signs in downtown Detroit", "now benches here") starts fresh: keep nothing from the previous plan unless the user says "same", "also", "too" or "keep".',
  '',
  'Point object values (layer map_features):',
  OBJECT_VALUES.join(', '),
  '',
  'Traffic-sign families (layer traffic_signs). Each family exists as several regional variants suffixed --g1, --g2…; always request a family with the wildcard form `<family>--*`:',
  SIGN_FAMILIES.join(', '),
].join('\n');

const KNOWN_VALUES = new Set([...OBJECT_VALUES, ...SIGN_VALUES]);

/**
 * Keep only values that exist in the taxonomy (exact) or match at least one
 * taxonomy value (wildcard). Returns the surviving patterns plus what was
 * dropped so the UI can say so.
 */
export function reconcilePlanValues(values) {
  const kept = [];
  const dropped = [];
  for (const raw of values || []) {
    const pattern = normalizeValuePattern(raw);
    if (!pattern) continue;
    if (pattern.includes('*')) {
      const matches = createValueMatcher([pattern]);
      if ([...KNOWN_VALUES].some(matches)) kept.push(pattern);
      else dropped.push(pattern);
    } else if (KNOWN_VALUES.has(pattern)) kept.push(pattern);
    else if (KNOWN_VALUES.has(`${pattern}--g1`)) kept.push(`${pattern}--*`);
    else dropped.push(pattern);
  }
  return { values: [...new Set(kept)], dropped };
}

/**
 * Turn the model's plan into the executable plan the browser runs: values
 * reconciled against the taxonomy, the tile layer derived from the values,
 * and an honest downgrade to "unsupported" when nothing usable survived.
 */
export function finalizePlan(plan) {
  const { values, dropped } = reconcilePlanValues(plan.values);
  let intent = plan.intent;
  let layer = null;
  if (intent === 'map_features' || intent === 'traffic_signs') {
    if (!values.length) {
      return {
        ...plan,
        intent: 'unsupported',
        values: [],
        dropped,
        layer: null,
        answer: dropped.length
          ? `I could not map "${dropped.join('", "')}" onto a Mapillary object or sign class.`
          : plan.answer,
      };
    }
    const signs = values.filter(isSignValue).length;
    layer = signs && signs === values.length ? 'signs' : 'points';
    intent = layer === 'signs' ? 'traffic_signs' : 'map_features';
    if (signs && signs !== values.length) {
      // Mixed request: signs live in a different tile set. Keep the object
      // half and say so rather than silently dropping either.
      return {
        ...plan,
        intent,
        layer,
        values: values.filter((value) => !isSignValue(value)),
        dropped: [...dropped, ...values.filter(isSignValue)],
        answer: `${plan.answer} Traffic signs and objects come from different layers, so this run shows the objects only.`,
      };
    }
  }
  return { ...plan, intent, layer, values, dropped };
}

let _client;
function client() {
  return (_client ||= new Anthropic());
}

let _limiter;
function limiter() {
  if (_limiter === undefined)
    _limiter = makeOptInRateLimiter(
      process.env.GEV_RATELIMIT_ANTHROPIC_PER_MIN,
    );
  return _limiter;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Build the volatile user turn: the request plus whatever the globe knows. */
export function buildPlannerUserMessage({ query, context = {}, today }) {
  const lines = [`Today is ${today}.`];
  const view = context.view;
  if (view && Number.isFinite(view.lat) && Number.isFinite(view.lon)) {
    lines.push(
      `Current view: ${view.lat.toFixed(4)}, ${view.lon.toFixed(4)}` +
        (Number.isFinite(view.heightM)
          ? `, camera ${Math.round(view.heightM)} m above ground`
          : '') +
        (view.label ? `, near ${String(view.label).slice(0, 120)}` : '') +
        '.',
    );
  }
  if (context.previousPlan) {
    lines.push(
      `Previous plan: ${JSON.stringify(context.previousPlan).slice(0, 1500)}`,
    );
  }
  lines.push('', `Request: ${query}`);
  return lines.join('\n');
}

/**
 * Ask Claude for a plan. Exported for tests with an injectable client.
 * @returns {Promise<{plan: object, usage: object|null, model: string}>}
 */
export async function planQuery(
  { query, context },
  { anthropic = client(), model = plannerModel(), now = new Date() } = {},
) {
  const response = await anthropic.messages.parse({
    model,
    max_tokens: PLANNER_MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: PLANNER_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: buildPlannerUserMessage({
          query,
          context,
          today: now.toISOString().slice(0, 10),
        }),
      },
    ],
    output_config: { format: zodOutputFormat(PlanSchema), effort: 'low' },
  });
  if (response.stop_reason === 'refusal') {
    return {
      plan: finalizePlan({
        intent: 'unsupported',
        place: null,
        use_current_view: false,
        values: [],
        seen_after: null,
        seen_before: null,
        visualise: 'icons',
        title: 'Query declined',
        answer: 'The planner declined this request.',
      }),
      usage: response.usage ?? null,
      model,
    };
  }
  if (!response.parsed_output)
    throw Object.assign(new Error('Planner returned no plan'), { status: 502 });
  return {
    plan: finalizePlan(response.parsed_output),
    usage: response.usage ?? null,
    model,
  };
}

function statusForError(error) {
  if (error instanceof Anthropic.AuthenticationError) return 503;
  if (error instanceof Anthropic.RateLimitError) return 429;
  if (error instanceof Anthropic.APIConnectionError) return 502;
  if (error instanceof Anthropic.APIStatusError) return error.status || 502;
  return error?.status || 500;
}

/** POST /api/mapillary/plan — natural language in, executable plan out. */
export async function handlePlan(req, res) {
  if (req.method !== 'POST')
    return sendJson(res, 405, { error: 'Method not allowed' });
  if (!mapillaryToken())
    return sendJson(res, 503, { error: 'no_key', keyRequired: 'mapillary' });
  if (!anthropicConfigured())
    return sendJson(res, 503, { error: 'no_key', keyRequired: 'anthropic' });
  const allow = limiter();
  if (allow && !allow(clientKey(req))) {
    res.setHeader('Retry-After', '5');
    return sendJson(res, 429, { error: 'Rate limit exceeded' });
  }
  let body;
  try {
    body = JSON.parse(
      (await readRequestBody(req, PLANNER_MAX_BODY_BYTES)) || '{}',
    );
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || 'Invalid JSON body' });
  }
  const query = String(body?.query || '').trim();
  if (!query || query.length > PLANNER_MAX_QUERY_CHARS)
    return sendJson(res, 400, {
      error: `A query of 1–${PLANNER_MAX_QUERY_CHARS} characters is required`,
    });
  try {
    const result = await planQuery({
      query,
      context:
        body?.context && typeof body.context === 'object' ? body.context : {},
    });
    sendJson(res, 200, result);
  } catch (error) {
    const status = statusForError(error);
    console.warn('[Mapillary Planner]', error?.message || error);
    sendJson(res, status, {
      error:
        status === 503
          ? 'Anthropic authentication failed'
          : error?.message || 'Planner request failed',
    });
  }
}
