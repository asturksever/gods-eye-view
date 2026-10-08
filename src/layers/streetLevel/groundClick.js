import { GROUND_CLICK_MAX_HEIGHT_M } from './policy.js';
import { cameraHeightAboveGround, groundPointAt } from './view.js';

/**
 * A click on bare ground at street zoom opens the nearest image of the active
 * providers that have no coverage to click (`groundClick`, Google Street
 * View). `openNearest(point, {providerIds})` is the layer's lookup.
 * @returns {(screenPosition: {x: number, y: number}) => Promise<boolean>|false}
 */
export function createGroundClick({ state, parts, openNearest }) {
  return function openAtGround(screenPosition) {
    const isWorldPosition = state.services.scenePick?.isPickedWorldPosition;
    if (!state.enabled || !state.viewer || !isWorldPosition) return false;
    const providerIds = [...state.providers.values()]
      .filter(
        (entry) =>
          entry.on && entry.def.groundClick && entry.status?.configured,
      )
      .map((entry) => entry.def.id);
    if (!providerIds.length) return false;
    // From higher up a click is a misclick, not a street.
    const height = cameraHeightAboveGround(state.viewer, {
      groundAt: parts.groundCaster?.groundAt,
    });
    if (!(height <= GROUND_CLICK_MAX_HEIGHT_M)) return false;
    const point = groundPointAt(state.viewer, screenPosition, {
      isWorldPosition,
    });
    return point ? openNearest(point, { providerIds }) : false;
  };
}
