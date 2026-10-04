/**
 * Flight gear for Me Mode: a cape that streams behind the avatar while it
 * flies, or a board it surfs on. Layout is pure math in the avatar's local
 * east/north/up frame (metres from the feet); `createFlightGear` turns it
 * into a few Cesium primitives updated per frame.
 */

/** Cape dimensions (m) and attachment on the avatar's upper back. */
export const CAPE = Object.freeze({
  segments: 5,
  segmentLength: 0.24,
  width: 0.62,
  thickness: 0.015,
  shoulderHeight: 1.42,
  backOffset: 0.14,
});

/** Surfboard dimensions (m). */
export const BOARD = Object.freeze({
  length: 1.9,
  width: 0.55,
  thickness: 0.07,
});

/** Fly styles: the cape lean, or standing on a board. */
export const FLY_STYLES = Object.freeze(['cape', 'surf']);

/** Body lean while surfing: upright, weight slightly back. */
export const SURF_LEAN = -0.12;

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a) => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return scale(a, 1 / length);
};

/**
 * The avatar's body axes in the local east/north/up frame.
 * @param {number} heading Compass radians the avatar faces.
 * @param {number} lean Forward lean (radians, positive = head forward).
 */
export function bodyFrame(heading, lean) {
  const forward = [Math.sin(heading), Math.cos(heading), 0];
  const right = [Math.cos(heading), -Math.sin(heading), 0];
  const up = [0, 0, 1];
  return {
    forward,
    right,
    // Body axis from feet to head, tipped forward by the lean.
    bodyUp: add(scale(up, Math.cos(lean)), scale(forward, Math.sin(lean))),
    // Where the chest points, tipped down by the lean.
    bodyForward: add(
      scale(forward, Math.cos(lean)),
      scale(up, -Math.sin(lean)),
    ),
  };
}

/**
 * Cape segments, top to bottom: each a thin box with a centre and its axes
 * (`right` across the cape, `along` down the cape, `normal` out of it).
 * At rest the cape hangs down the back with a slight sway; with speed it
 * streams out behind and flutters faster.
 * @param {{ heading: number, lean: number, speedRatio: number, time: number }} pose
 *   `speedRatio` 0 (hover) … 1 (full flying speed); `time` in seconds.
 */
export function capeLayout({ heading, lean, speedRatio, time }) {
  const s = Math.min(1, Math.max(0, speedRatio));
  const { forward, right, bodyUp, bodyForward } = bodyFrame(heading, lean);
  let start = add(
    scale(bodyUp, CAPE.shoulderHeight),
    scale(bodyForward, -CAPE.backOffset),
  );
  // The cape swings in the vertical plane through the direction of travel:
  // straight down when hovering, trailing out behind (against the motion,
  // not away from the chest, which faces the ground mid-flight) at speed.
  const down = [0, 0, -1];
  const behind = scale(forward, -1);
  const segments = [];
  for (let i = 0; i < CAPE.segments; i++) {
    // 0 = straight down; π/2 = horizontal behind; a little past it lifts.
    const flutter =
      Math.sin(time * (3 + 9 * s) - i * 0.9) *
      (0.06 + 0.16 * s) *
      (i + 1) *
      0.35;
    const angle = 0.12 + s * (1.45 + 0.03 * i) + flutter;
    const along = normalize(
      add(scale(down, Math.cos(angle)), scale(behind, Math.sin(angle))),
    );
    const centre = add(start, scale(along, CAPE.segmentLength / 2));
    segments.push({
      centre,
      right,
      along,
      normal: normalize(cross(right, along)),
    });
    start = add(start, scale(along, CAPE.segmentLength));
  }
  return segments;
}

/** The board under the feet, along the direction the avatar faces. */
export function boardLayout({ heading }) {
  const { forward, right } = bodyFrame(heading, 0);
  return {
    centre: [0, 0, -BOARD.thickness / 2],
    right,
    along: forward,
    normal: [0, 0, 1],
  };
}

/**
 * Cesium primitives for the cape and board. `update` places them from the
 * avatar's feet position and pose each frame.
 * @param {typeof import('cesium')} Cesium
 * @param {import('cesium').Scene} scene
 */
export function createFlightGear(Cesium, scene) {
  const box = (dimensions, color) => {
    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: Cesium.BoxGeometry.fromDimensions({
          dimensions: new Cesium.Cartesian3(...dimensions),
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
        },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({ closed: true }),
      asynchronous: false,
      show: false,
    });
    scene.primitives.add(primitive);
    return primitive;
  };
  const capeColor = Cesium.Color.fromCssColorString('#c8102e');
  const cape = Array.from({ length: CAPE.segments }, () =>
    box([CAPE.width, CAPE.segmentLength, CAPE.thickness], capeColor),
  );
  const board = box(
    [BOARD.width, BOARD.length, BOARD.thickness],
    Cesium.Color.fromCssColorString('#cfd8dc'),
  );
  const frame = new Cesium.Matrix4();
  const local = new Cesium.Matrix4();

  // Box axes x/y/z = right/along/normal, positioned at `centre` (local ENU).
  const place = (primitive, { centre, right, along, normal }) => {
    Cesium.Matrix4.fromArray(
      [...right, 0, ...along, 0, ...normal, 0, ...centre, 1],
      0,
      local,
    );
    primitive.modelMatrix = Cesium.Matrix4.multiply(
      frame,
      local,
      primitive.modelMatrix,
    );
  };

  return {
    /** Every gear primitive, so ground probes can ignore them. */
    primitives: [...cape, board],

    /**
     * @param {object} state
     * @param {import('cesium').Cartesian3} state.feet
     * @param {'cape'|'surf'|null} state.style null hides all gear
     * @param {boolean} state.firstPerson cape hidden from the eye's view
     * @returns {'cape'|'surf'|null} the gear now showing
     */
    update({ feet, style, firstPerson, heading, lean, speedRatio, time }) {
      const showCape = style === 'cape' && !firstPerson;
      const showBoard = style === 'surf';
      cape.forEach((segment) => (segment.show = showCape));
      board.show = showBoard;
      if (!showCape && !showBoard) return null;
      Cesium.Transforms.eastNorthUpToFixedFrame(feet, undefined, frame);
      if (showCape)
        capeLayout({ heading, lean, speedRatio, time }).forEach((layout, i) =>
          place(cape[i], layout),
        );
      if (showBoard) place(board, boardLayout({ heading }));
      return showCape ? 'cape' : 'surf';
    },

    destroy() {
      for (const primitive of [...cape, board])
        scene.primitives.remove(primitive);
    },
  };
}
