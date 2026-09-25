import { keySetupRequirement } from '../keySetupCore.mjs';

/**
 * Turn the Street Level layer's UI state into the strings and flags the panel
 * renders. Pure: no DOM, no layer calls, so every wording decision is testable.
 */

/** Relative "captured since" windows the panel offers, in days. */
export const SINCE_OPTIONS = Object.freeze([
  Object.freeze({ days: 0, label: 'any date' }),
  Object.freeze({ days: 365, label: 'last year' }),
  Object.freeze({ days: 730, label: '2 years' }),
  Object.freeze({ days: 1826, label: '5 years' }),
  Object.freeze({ days: 3652, label: '10 years' }),
]);

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

function presentStatus(state) {
  if (state.keyRequired) return { text: 'KEY REQUIRED', tone: 'warn' };
  if (state.coverage.loading) return { text: 'LOADING', tone: 'busy' };
  return state.enabled ? { text: 'ON', tone: 'on' } : { text: 'OFF', tone: '' };
}

/** One chip per registered provider; a keyless provider reads as an error chip. */
function presentProviders(state) {
  return (state.providers || []).map((provider) => {
    const keyRequired = provider.keyRequired === true;
    let title = `${provider.name} imagery ${provider.on ? 'on' : 'off'}`;
    if (keyRequired && provider.requiresKeyId)
      title = `${provider.name}: ${keySetupRequirement(provider.requiresKeyId)}`;
    else if (provider.error) title = `${provider.name}: ${provider.error}`;
    return {
      id: provider.id,
      label: provider.label,
      title,
      active: provider.on === true,
      disabled: false,
      state: keyRequired
        ? 'error'
        : provider.loading
          ? 'loading'
          : provider.on
            ? 'active'
            : 'idle',
      busy: provider.loading === true,
    };
  });
}

function presentViewer(state) {
  const { street } = state;
  const right = [];
  if (street.isPano) right.push('360°');
  if (Number.isFinite(street.bearing))
    right.push(`${Math.round(street.bearing)}°`);
  if (street.capturedAt) right.push(formatDate(street.capturedAt));
  return {
    open: street.open === true,
    loading: street.loading === true && !street.imageId,
    renderMode: street.renderMode === 'fill' ? 'fill' : 'letterbox',
    captionLeft: street.creator ? `Image by ${street.creator}` : '',
    captionRight: right.join(' · '),
    link: street.externalUrl || null,
    linkLabel: street.providerLabel ? `${street.providerLabel} ↗` : '',
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
  if (state.coverage.count > 0)
    return `${state.coverage.count.toLocaleString()} sequences in view · click a line for its photos`;
  return state.coverage.hint || '';
}

/**
 * @param {object} state Snapshot from the layer's `getUIState()`.
 * @returns {object} Everything the panel needs, already worded.
 */
export function presentStreetLevelPanel(state) {
  const enabled = state.enabled === true;
  const keyRequired = state.keyRequired === true;
  const filter = state.filter || { pano: 'all', sinceDays: 0 };
  return {
    enabled,
    keyRequired,
    status: presentStatus(state),
    controlsDisabled: keyRequired,
    enableButton: {
      text: enabled ? 'STREET LEVEL ON' : 'STREET LEVEL OFF',
      pressed: enabled,
    },
    providers: presentProviders(state),
    error: state.street.error || state.coverage.error || null,
    filter: { pano: filter.pano, sinceDays: Number(filter.sinceDays) || 0 },
    legend: state.legend || [],
    viewer: presentViewer(state),
    meta: presentMeta(state),
    /** The panel opens itself when an image opens (a native panel stays put otherwise). */
    wantsOpen: state.street.open === true,
  };
}
