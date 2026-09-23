/**
 * Turn the Street Level layer's UI state into the strings and flags the panel
 * renders. Pure: no DOM, no layer calls, so every wording decision is testable.
 */

const HINT_READY =
  'Objects, traffic signs, coverage or a street view of any place. Follow-ups refine the last answer.';
const HINT_NO_PLANNER =
  'Plain-English questions need an Anthropic key in POWER UP. Coverage, photos and filters work without it.';
const IDLE_ANSWER_OFF =
  'Turn on Street Level to see Mapillary coverage on the globe.';
const IDLE_ANSWER_ON =
  'Click a green line to see its photos, or ask for objects and signs.';

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

/** Deep link to an image on mapillary.com, as the web app shares them. */
export function mapillaryImageUrl(imageId) {
  const id = String(imageId || '').trim();
  if (!id) return 'https://www.mapillary.com/app/';
  return `https://www.mapillary.com/app/?pKey=${encodeURIComponent(id)}&focus=photo`;
}

function presentStatus(state) {
  if (state.keyRequired) return { text: 'KEY REQUIRED', tone: 'warn' };
  if (state.query.busy)
    return { text: `AI · ${state.query.stage.toUpperCase()}`, tone: 'busy' };
  if (state.coverage.loading || state.features.loading)
    return { text: 'LOADING', tone: 'busy' };
  return state.enabled ? { text: 'ON', tone: 'on' } : { text: 'OFF', tone: '' };
}

function presentProgress(state) {
  const { stage, busy } = state.query;
  const { progress, loading, total } = state.features;
  if (loading && progress.tiles > 0) {
    const pct = Math.round((progress.done / progress.tiles) * 100);
    return {
      visible: true,
      indeterminate: false,
      percent: pct,
      label: `${progress.done}/${progress.tiles} tiles · ${total.toLocaleString()} found`,
    };
  }
  if (busy && stage === 'planning')
    return {
      visible: true,
      indeterminate: true,
      percent: 0,
      label: 'Planning…',
    };
  if (busy && stage === 'resolving')
    return {
      visible: true,
      indeterminate: true,
      percent: 0,
      label: `Finding ${state.query.place || 'the area'}…`,
    };
  if (busy)
    return {
      visible: true,
      indeterminate: true,
      percent: 0,
      label: 'Working…',
    };
  return { visible: false, indeterminate: false, percent: 0, label: '' };
}

function presentResults(state, { maxChips = 8 } = {}) {
  const counts = state.features.counts || [];
  const visible = state.features.total > 0 || state.features.hasBbox === true;
  const chips = counts.map(({ value, count, label, color }) => ({
    value,
    label,
    color,
    count: count.toLocaleString(),
  }));
  const hidden = chips.slice(maxChips);
  return {
    visible,
    chips: chips.slice(0, maxChips),
    more: hidden.length
      ? {
          count: hidden.length,
          title: hidden.map((chip) => `${chip.label} ${chip.count}`).join(', '),
        }
      : null,
    all: chips,
  };
}

function presentViewer(state) {
  const { street } = state;
  const left = [];
  if (street.feature?.label)
    left.push(
      `${street.feature.label}${street.feature.imageCount ? ` · ${street.feature.imageCount} sightings` : ''}`,
    );
  if (street.highlight?.count)
    left.push(
      `${street.highlight.count} detection${street.highlight.count === 1 ? '' : 's'} outlined`,
    );
  if (street.creator) left.push(`Image by ${street.creator}`);
  const right = [];
  if (street.isPano) right.push('360°');
  if (Number.isFinite(street.bearing))
    right.push(`${Math.round(street.bearing)}°`);
  if (street.capturedAt) right.push(formatDate(street.capturedAt));
  return {
    open: street.open === true,
    loading: street.loading === true && !street.imageId,
    renderMode: street.renderMode === 'fill' ? 'fill' : 'letterbox',
    captionLeft: left.join(' · '),
    captionRight: right.join(' · '),
    link: street.imageId ? mapillaryImageUrl(street.imageId) : null,
    follow: {
      pressed: street.follow === true,
      disabled: street.open !== true,
    },
  };
}

function presentMeta(state) {
  if (!state.enabled) return '';
  if (state.sequence.selectedId)
    return state.sequence.loading
      ? 'Loading this sequence…'
      : `${state.sequence.images.toLocaleString()} images in this sequence · Esc clears`;
  const bits = [];
  if (state.coverage.zoom && state.coverage.sequences > 0)
    bits.push(
      `${state.coverage.sequences.toLocaleString()} sequences in view · click a line for its photos`,
    );
  else if (state.coverage.hint) bits.push(state.coverage.hint);
  if (state.query.usage?.model)
    bits.push(
      `${state.query.usage.model} · ${state.query.usage.input_tokens ?? '?'}→${state.query.usage.output_tokens ?? '?'} tok`,
    );
  return bits.join(' · ');
}

function presentObjects3d(state) {
  const objects = state.objects3d || {};
  return {
    pressed: objects.enabled === true,
    text: objects.building
      ? '3D OBJECTS …'
      : objects.enabled
        ? '3D OBJECTS ON'
        : '3D OBJECTS OFF',
    note: objects.error
      ? objects.error
      : objects.enabled && objects.active
        ? `${(objects.count || 0).toLocaleString()} objects standing in 3D · click one to open its image`
        : '',
  };
}

/**
 * @param {object} state Snapshot from the layer's `getUIState()`.
 * @returns {object} Everything the panel needs, already worded.
 */
export function presentMapillaryPanel(state) {
  const enabled = state.enabled === true;
  const keyRequired = state.keyRequired === true;
  const planner = state.planner === true;
  const busy = state.query.busy === true;
  const error = state.query.error || state.street.error || null;
  let answer = state.query.answer || '';
  if (!answer && !error) {
    if (busy) answer = '';
    else if (!enabled) answer = IDLE_ANSWER_OFF;
    else if (state.coverage.hint) answer = state.coverage.hint;
    else answer = IDLE_ANSWER_ON;
  }
  return {
    enabled,
    keyRequired,
    status: presentStatus(state),
    keyless: {
      visible: keyRequired,
      text: 'Street Level needs a free Mapillary client token (MAPILLARY_CLIENT_TOKEN). Coverage, photos and queries stay off until one is added.',
    },
    controlsDisabled: keyRequired,
    enableButton: {
      text: enabled ? 'STREET LEVEL ON' : 'STREET LEVEL OFF',
      pressed: enabled,
    },
    query: {
      placeholder: planner
        ? 'Ask about objects, signs or a place'
        : 'Anthropic key needed — see POWER UP',
      inputDisabled: !planner,
      suggestionsDisabled: !planner,
      hint: planner ? HINT_READY : HINT_NO_PLANNER,
      hintWarn: !planner,
      model: state.plannerModel ? `· ${state.plannerModel}` : '',
      submitLabel: busy ? 'STOP' : 'ASK',
      submitIsStop: busy,
    },
    progress: presentProgress(state),
    answer,
    error,
    results: presentResults(state),
    filter: state.coverage.filter || { pano: 'all', sinceMs: null },
    legend: state.coverage.legend || [],
    viewer: presentViewer(state),
    objects3d: presentObjects3d(state),
    meta: presentMeta(state),
    /** The panel opens itself at these moments (a native panel stays put otherwise). */
    wantsOpen:
      state.street.open === true ||
      state.query.stage === 'done' ||
      state.query.stage === 'error',
  };
}
