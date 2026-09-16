import * as Cesium from 'cesium';
import { MAPILLARY_LAYER_ID, PICK_PREFIX } from './policy.js';

/** Click handling for coverage lines, image cones and query results. */
export function createSelection({ state, parts }) {
  const { picking, input } = state.services;

  function ownsPick(pickedId) {
    return (
      typeof pickedId === 'string' &&
      Object.values(PICK_PREFIX).some((prefix) => pickedId.startsWith(prefix))
    );
  }

  function onClick(click) {
    const viewer = state.viewer;
    if (!viewer || !state.enabled) return;
    if (input?.isPointerFree && !input.isPointerFree()) return;
    const picked = viewer.scene.pick(click.position);
    const id = picking?.resolvePickId
      ? picking.resolvePickId(picked)
      : picked?.id;
    if (!ownsPick(id)) return;
    if (id.startsWith(PICK_PREFIX.sequence)) {
      parts.sequences.select(id.slice(PICK_PREFIX.sequence.length));
    } else if (id.startsWith(PICK_PREFIX.image)) {
      parts.street.openImage(id.slice(PICK_PREFIX.image.length));
    } else if (id.startsWith(PICK_PREFIX.feature)) {
      parts.street.openFeature(id.slice(PICK_PREFIX.feature.length));
    } else if (id.startsWith(PICK_PREFIX.object)) {
      // 3D object entities are id'd `mly:obj:<featureId>:<part>`.
      parts.street.openFeature(id.split(':')[2]);
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && state.sequence.selectedId)
      parts.sequences.clearSelection();
  }

  function install(viewer) {
    if (state.clickHandler) return;
    state.clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    state.clickHandler.setInputAction(
      onClick,
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
    document.addEventListener('keydown', onKeyDown);
    picking?.registerPickOwner?.(MAPILLARY_LAYER_ID, ownsPick);
  }

  function uninstall() {
    if (state.clickHandler && !state.clickHandler.isDestroyed())
      state.clickHandler.destroy();
    state.clickHandler = null;
    document.removeEventListener('keydown', onKeyDown);
    picking?.unregisterPickOwner?.(MAPILLARY_LAYER_ID);
  }

  return { install, uninstall, ownsPick };
}
