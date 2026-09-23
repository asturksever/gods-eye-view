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

  /**
   * Esc clears the selected sequence, but only once nothing closer to the
   * user wants it: an expanded viewer, an open panel or a text field.
   */
  function onKeyDown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (
      event.target?.closest?.(
        '.panel-collapsible, [role="dialog"], input, textarea, select',
      )
    )
      return;
    if (!state.sequence.selectedId) return;
    event.preventDefault();
    parts.sequences.clearSelection();
  }

  let hoverQueued = false;
  let hoverCursor = false;
  /** Pointer cursor over anything this layer owns, so lines read as clickable. */
  function onMove(movement) {
    const viewer = state.viewer;
    if (!viewer || !state.enabled || hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      const canvas = viewer.scene?.canvas;
      if (!canvas || viewer.isDestroyed?.()) return;
      let hit = false;
      try {
        const picked = viewer.scene.pick(movement.endPosition);
        const id = picking?.resolvePickId
          ? picking.resolvePickId(picked)
          : picked?.id;
        hit = ownsPick(id);
      } catch {
        hit = false;
      }
      if (hit && !hoverCursor) {
        canvas.style.cursor = 'pointer';
        hoverCursor = true;
      } else if (!hit && hoverCursor) {
        canvas.style.cursor = '';
        hoverCursor = false;
      }
    });
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
    state.clickHandler.setInputAction(
      onMove,
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    );
    document.addEventListener('keydown', onKeyDown);
    picking?.registerPickOwner?.(MAPILLARY_LAYER_ID, ownsPick);
  }

  function uninstall() {
    if (hoverCursor && state.viewer?.scene?.canvas) {
      state.viewer.scene.canvas.style.cursor = '';
      hoverCursor = false;
    }
    if (state.clickHandler && !state.clickHandler.isDestroyed())
      state.clickHandler.destroy();
    state.clickHandler = null;
    document.removeEventListener('keydown', onKeyDown);
    picking?.unregisterPickOwner?.(MAPILLARY_LAYER_ID);
  }

  return { install, uninstall, ownsPick };
}
