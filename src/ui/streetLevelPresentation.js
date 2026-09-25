/**
 * Turn the Street Level layer's UI state into the strings and flags the panel
 * renders. Pure: no DOM, no layer calls, so every wording decision is testable.
 */

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
  if (state.coverage.loading) return { text: 'LOADING', tone: 'busy' };
  return state.enabled ? { text: 'ON', tone: 'on' } : { text: 'OFF', tone: '' };
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
  if (state.coverage.zoom && state.coverage.sequences > 0)
    return `${state.coverage.sequences.toLocaleString()} sequences in view · click a line for its photos`;
  return state.coverage.hint || '';
}

/**
 * @param {object} state Snapshot from the layer's `getUIState()`.
 * @returns {object} Everything the panel needs, already worded.
 */
export function presentStreetLevelPanel(state) {
  const enabled = state.enabled === true;
  const keyRequired = state.keyRequired === true;
  return {
    enabled,
    keyRequired,
    status: presentStatus(state),
    controlsDisabled: keyRequired,
    enableButton: {
      text: enabled ? 'STREET LEVEL ON' : 'STREET LEVEL OFF',
      pressed: enabled,
    },
    error: state.street.error || state.coverage.error || null,
    filter: state.coverage.filter || { pano: 'all', sinceMs: null },
    legend: state.coverage.legend || [],
    viewer: presentViewer(state),
    meta: presentMeta(state),
    /** The panel opens itself when an image opens (a native panel stays put otherwise). */
    wantsOpen: state.street.open === true,
  };
}
