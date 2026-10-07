/**
 * Flight gear for Me Mode: a cloth cape that streams and flaps behind the
 * avatar while it flies (simulated in cloth.js), or a board it surfs on.
 * Layout is in the avatar's local east/north/up frame (metres from the
 * feet); `createFlightGear` turns it into Cesium primitives each frame.
 */
import {
  clothNormals,
  createCloth,
  resetCloth,
  stepCloth,
  windAt,
} from './cloth.js';

/** Cape cloth (m) and its attachment across the avatar's shoulders. */
export const CAPE = Object.freeze({
  cols: 9,
  rows: 13,
  topWidth: 0.46,
  bottomWidth: 0.95,
  length: 1.3,
  shoulderHeight: 1.43,
  backOffset: 0.12,
});
/** A teleport or respawn: re-hang the cape instead of whipping it. */
const CAPE_RESET_M = 30;

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

/**
 * The avatar's body axes in the local east/north/up frame.
 * @param {number} heading Compass radians the avatar faces.
 * @param {number} lean Forward lean (radians, positive = head forward).
 */
export function bodyFrame(heading, lean, roll = 0) {
  const forward = [Math.sin(heading), Math.cos(heading), 0];
  const flatRight = [Math.cos(heading), -Math.sin(heading), 0];
  const up = [0, 0, 1];
  // Body axis from feet to head, tipped forward by the lean.
  const leanedUp = add(
    scale(up, Math.cos(lean)),
    scale(forward, Math.sin(lean)),
  );
  // Bank: the body rolls about the chest axis, head towards the turn.
  const bodyUp = add(
    scale(leanedUp, Math.cos(roll)),
    scale(flatRight, Math.sin(roll)),
  );
  const right = add(
    scale(flatRight, Math.cos(roll)),
    scale(leanedUp, -Math.sin(roll)),
  );
  return {
    forward,
    right,
    bodyUp,
    // Where the chest points, tipped down by the lean.
    bodyForward: add(
      scale(forward, Math.cos(lean)),
      scale(up, -Math.sin(lean)),
    ),
  };
}

/**
 * Where the cape is pinned (one point per cloth column, left to right across
 * the shoulders) and the body capsules it must stay outside.
 * @param {{ heading: number, lean: number, roll?: number }} pose
 */
export function capeRig({ heading, lean, roll = 0 }) {
  const { right, bodyUp, bodyForward } = bodyFrame(heading, lean, roll);
  const shoulders = add(
    scale(bodyUp, CAPE.shoulderHeight),
    scale(bodyForward, -CAPE.backOffset),
  );
  const anchors = [];
  for (let c = 0; c < CAPE.cols; c++) {
    const across = (c / (CAPE.cols - 1) - 0.5) * CAPE.topWidth;
    // The cape wraps slightly round the shoulders.
    const wrap = -0.06 * (1 - (2 * across) ** 2 / CAPE.topWidth ** 2);
    anchors.push(
      add(add(shoulders, scale(right, across)), scale(bodyForward, wrap)),
    );
  }
  const back = (h, offset = 0) =>
    add(scale(bodyUp, h), scale(bodyForward, offset));
  const colliders = [
    { a: back(0.95, 0.0), b: back(1.38, 0.0), radius: 0.2 }, // torso
    { a: back(0.08, 0.0), b: back(0.92, 0.0), radius: 0.15 }, // legs
    { a: back(1.5, 0.02), b: back(1.75, 0.02), radius: 0.12 }, // head
  ];
  return { anchors, colliders };
}

/** The board under the feet, along the direction the avatar faces. */
export function boardLayout({ heading, roll = 0 }) {
  // The board carves: it tips with the rider into a turn.
  const { forward, right } = bodyFrame(heading, 0, roll);
  const normal = cross(right, forward);
  return {
    centre: scale(normal, -BOARD.thickness / 2),
    right,
    along: forward,
    normal,
  };
}

/**
 * Cesium primitives for the cape and board. `update` places them from the
 * avatar's feet position and pose each frame.
 * @param {typeof import('cesium')} Cesium
 * @param {import('cesium').Scene} scene
 */
export function createFlightGear(Cesium, scene) {
  const board = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: Cesium.BoxGeometry.fromDimensions({
        dimensions: new Cesium.Cartesian3(
          BOARD.width,
          BOARD.length,
          BOARD.thickness,
        ),
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(
          Cesium.Color.fromCssColorString('#cfd8dc'),
        ),
      },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({ closed: true }),
    asynchronous: false,
    allowPicking: false,
    show: false,
  });
  scene.primitives.add(board);

  const cloth = createCloth(CAPE);
  // Deep red wool: matte, lit on both faces.
  const capeAppearance = new Cesium.MaterialAppearance({
    material: Cesium.Material.fromType('Color', {
      color: Cesium.Color.fromCssColorString('#9e0f1f'),
    }),
    faceForward: true,
    closed: false,
    translucent: false,
  });
  const indices = new Uint16Array(cloth.triangles.flat());
  const st = new Float32Array(CAPE.cols * CAPE.rows * 2);
  for (let r = 0; r < CAPE.rows; r++)
    for (let c = 0; c < CAPE.cols; c++) {
      st[(r * CAPE.cols + c) * 2] = c / (CAPE.cols - 1);
      st[(r * CAPE.cols + c) * 2 + 1] = 1 - r / (CAPE.rows - 1);
    }
  let cape = null;
  let lastFeet = null;
  let lastTime = null;
  const frame = new Cesium.Matrix4();
  const inverse = new Cesium.Matrix4();
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

  const dropCape = () => {
    if (cape) scene.primitives.remove(cape);
    cape = null;
  };

  const drawCape = () => {
    const geometry = new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: Float64Array.from(cloth.pos),
        }),
        normal: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: clothNormals(cloth),
        }),
        st: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          values: st,
        }),
      },
      indices,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(cloth.pos)),
    });
    const next = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry }),
      appearance: capeAppearance,
      modelMatrix: Cesium.Matrix4.clone(frame),
      asynchronous: false,
      allowPicking: false,
      compressVertices: false,
    });
    scene.primitives.add(next);
    dropCape();
    cape = next;
  };

  return {
    /** Every gear primitive, so ground probes can ignore them. */
    get primitives() {
      return cape ? [board, cape] : [board];
    },

    /**
     * @param {object} state
     * @param {import('cesium').Cartesian3} state.feet
     * @param {'cape'|'surf'|null} state.style null hides all gear
     * @param {boolean} state.firstPerson cape hidden from the eye's view
     * @param {number} state.heading compass radians the avatar faces
     * @param {number} state.lean forward lean (radians)
     * @param {number} [state.roll] bank (radians, positive = right side down)
     * @param {number} state.time seconds (drives the wind)
     * @returns {'cape'|'surf'|null} the gear now showing
     */
    update({ feet, style, firstPerson, heading, lean, roll = 0, time }) {
      const showCape = style === 'cape' && !firstPerson;
      const showBoard = style === 'surf';
      board.show = showBoard;
      const dt =
        lastTime === null ? 0 : Math.max(0, Math.min(0.25, time - lastTime));
      lastTime = time;
      Cesium.Transforms.eastNorthUpToFixedFrame(feet, undefined, frame);
      if (showCape) {
        const rig = capeRig({ heading, lean, roll });
        // Express the cloth relative to the feet' new position: it keeps its
        // own velocity in the world, so moving the avatar drags it behind.
        let shift = [0, 0, 0];
        if (lastFeet) {
          Cesium.Matrix4.inverseTransformation(frame, inverse);
          const old = Cesium.Matrix4.multiplyByPoint(
            inverse,
            lastFeet,
            new Cesium.Cartesian3(),
          );
          if (Cesium.Cartesian3.magnitude(old) > CAPE_RESET_M)
            cloth.ready = false;
          else shift = [old.x, old.y, old.z];
        }
        if (!cloth.ready) resetCloth(cloth, rig.anchors);
        stepCloth(
          cloth,
          {
            anchors: rig.anchors,
            colliders: rig.colliders,
            wind: (t) => windAt(t),
            shift,
          },
          dt,
        );
        drawCape();
      } else {
        dropCape();
        cloth.ready = false;
      }
      lastFeet = Cesium.Cartesian3.clone(feet, lastFeet ?? undefined);
      if (showBoard) place(board, boardLayout({ heading, roll }));
      return showCape ? 'cape' : showBoard ? 'surf' : null;
    },

    destroy() {
      dropCape();
      scene.primitives.remove(board);
    },
  };
}
