/**
 * A small cloth simulation for Me Mode's cape: a grid of particles joined by
 * distance constraints (position-based dynamics with Verlet integration),
 * pinned along its top edge. Forces: gravity, aerodynamic drag on each
 * triangle (pressure along its normal, so the cloth billows and flaps), and
 * gusty wind. The body is a capsule the cloth cannot pass through.
 *
 * Positions are metres in a local east/north/up frame at the avatar's feet.
 * When the avatar moves, call `translate` with minus its displacement: the
 * cloth keeps its world-space velocity and trails behind on its own.
 * Pure math, no Cesium.
 */

const GRAVITY = 9.81;
/** Air density (kg/m³) and the cape's areal density (kg/m², heavy cotton). */
const AIR_DENSITY = 1.2;
const CLOTH_DENSITY = 0.35;
/** Pressure drag coefficient for a flat plate, and skin friction. */
const DRAG_NORMAL = 1.2;
const DRAG_TANGENT = 0.05;
/** Velocity kept per second without forces (internal friction). */
const DAMPING_PER_S = 0.4;
/** Fixed simulation step and the most steps per frame (stalled tabs). */
export const CLOTH_STEP_S = 1 / 120;
const MAX_STEPS = 30;
/** Constraint solver passes per step: more is stiffer cloth. */
const ITERATIONS = 10;

/**
 * @param {object} options
 * @param {number} options.cols particles across
 * @param {number} options.rows particles down
 * @param {number} options.topWidth width at the shoulders (m)
 * @param {number} options.bottomWidth width at the hem (m)
 * @param {number} options.length length (m)
 */
export function createCloth({ cols, rows, topWidth, bottomWidth, length }) {
  const count = cols * rows;
  const cloth = {
    cols,
    rows,
    topWidth,
    bottomWidth,
    length,
    pos: new Float64Array(count * 3),
    prev: new Float64Array(count * 3),
    // Constraints as [a, b, restLength, stiffness].
    links: [],
    // Long-range attachments: [particle, pinned top particle, max distance].
    tethers: [],
    triangles: [],
    accumulator: 0,
    time: 0,
    ready: false,
  };
  const rest = restShape(cloth);
  const at = (c, r) => r * cols + c;
  const link = (a, b, stiffness) =>
    cloth.links.push([a, b, distance(rest, a, b), stiffness]);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = at(c, r);
      if (c + 1 < cols) link(i, at(c + 1, r), 1); // structural
      if (r + 1 < rows) link(i, at(c, r + 1), 1);
      if (c + 1 < cols && r + 1 < rows) {
        link(i, at(c + 1, r + 1), 0.6); // shear
        link(at(c + 1, r), at(c, r + 1), 0.6);
        cloth.triangles.push(
          [i, at(c, r + 1), at(c + 1, r)],
          [at(c + 1, r), at(c, r + 1), at(c + 1, r + 1)],
        );
      }
      if (c + 2 < cols) link(i, at(c + 2, r), 0.15); // bending
      if (r + 2 < rows) link(i, at(c, r + 2), 0.15);
      if (r > 0)
        cloth.tethers.push([i, at(c, 0), distance(rest, i, at(c, 0)) * 1.02]);
    }
  return cloth;
}

/** Flat rest layout in the cloth's own plane (x across, y down). */
function restShape({ cols, rows, topWidth, bottomWidth, length }) {
  const out = new Float64Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    const width = topWidth + (bottomWidth - topWidth) * v;
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      out[i] = (c / (cols - 1) - 0.5) * width;
      out[i + 1] = -v * length;
    }
  }
  return out;
}

function distance(p, a, b) {
  const dx = p[a * 3] - p[b * 3];
  const dy = p[a * 3 + 1] - p[b * 3 + 1];
  const dz = p[a * 3 + 2] - p[b * 3 + 2];
  return Math.hypot(dx, dy, dz);
}

/**
 * Hang the cloth straight down from the anchors, at rest.
 * @param {number[][]} anchors top-row positions, one per column
 */
export function resetCloth(cloth, anchors) {
  const { cols, rows, length } = cloth;
  for (let c = 0; c < cols; c++) {
    const top = anchors[c];
    for (let r = 0; r < rows; r++) {
      const i = (r * cols + c) * 3;
      cloth.pos[i] = top[0];
      cloth.pos[i + 1] = top[1];
      cloth.pos[i + 2] = top[2] - (r / (rows - 1)) * length;
    }
  }
  cloth.prev.set(cloth.pos);
  cloth.accumulator = 0;
  cloth.ready = true;
}

/** Shift the whole cloth (e.g. by minus the avatar's displacement). */
export function translateCloth(cloth, dx, dy, dz) {
  for (const array of [cloth.pos, cloth.prev])
    for (let i = 0; i < array.length; i += 3) {
      array[i] += dx;
      array[i + 1] += dy;
      array[i + 2] += dz;
    }
}

/**
 * Gusty wind (m/s, east/north/up) at time `t`: a steady breeze plus a few
 * incommensurate sines, so it never visibly repeats.
 */
export function windAt(t, base = [0, 0, 0]) {
  const gust = 0.6 + 0.4 * Math.sin(t * 0.7) * Math.sin(t * 1.9 + 1);
  return [
    base[0] + gust * (0.8 * Math.sin(t * 1.3) + 0.5 * Math.sin(t * 3.7 + 2)),
    base[1] + gust * (0.8 * Math.cos(t * 1.1) + 0.5 * Math.sin(t * 2.9)),
    base[2] + gust * 0.4 * Math.sin(t * 2.3 + 0.5),
  ];
}

/**
 * Advance the cloth by `dt` seconds (fixed sub-steps).
 * @param {object} cloth
 * @param {object} env
 * @param {number[][]} env.anchors top-row positions (pinned), one per column
 * @param {(t: number) => number[]} [env.wind] air velocity at time t
 * @param {{ a: number[], b: number[], radius: number }[]} [env.colliders]
 *   capsules (segment a–b with a radius) the cloth stays outside
 * @param {number[]} [env.shift] how far the frame moved this frame: minus
 *   the avatar's displacement. Applied gradually across the sub-steps, so
 *   the anchors glide rather than jump.
 * @param {number} dt
 */
export function stepCloth(cloth, env, dt) {
  if (!cloth.ready) resetCloth(cloth, env.anchors);
  const shift = env.shift || [0, 0, 0];
  cloth.accumulator = Math.min(
    cloth.accumulator + dt,
    CLOTH_STEP_S * MAX_STEPS,
  );
  const steps = Math.floor(cloth.accumulator / CLOTH_STEP_S);
  if (!steps) {
    translateCloth(cloth, ...shift);
    return;
  }
  for (let i = 0; i < steps; i++) {
    cloth.accumulator -= CLOTH_STEP_S;
    cloth.time += CLOTH_STEP_S;
    translateCloth(cloth, shift[0] / steps, shift[1] / steps, shift[2] / steps);
    substep(cloth, env, CLOTH_STEP_S);
  }
}

function substep(cloth, env, h) {
  const { pos, prev, cols } = cloth;
  const n = pos.length / 3;
  const force = new Float64Array(n * 3);
  const wind = env.wind ? env.wind(cloth.time) : [0, 0, 0];
  // Aerodynamic force per triangle, from the air speed relative to it.
  for (const [a, b, c] of cloth.triangles) {
    const ab = sub(pos, b, a);
    const ac = sub(pos, c, a);
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const twiceArea = Math.hypot(...cross);
    if (twiceArea < 1e-9) continue;
    const normal = cross.map((v) => v / twiceArea);
    const area = twiceArea / 2;
    // Triangle velocity (Verlet: displacement over the step) minus the wind.
    const rel = [0, 1, 2].map(
      (k) =>
        (pos[a * 3 + k] -
          prev[a * 3 + k] +
          pos[b * 3 + k] -
          prev[b * 3 + k] +
          pos[c * 3 + k] -
          prev[c * 3 + k]) /
          (3 * h) -
        wind[k],
    );
    const vn = rel[0] * normal[0] + rel[1] * normal[1] + rel[2] * normal[2];
    const speed = Math.hypot(...rel);
    // Pressure drag ½ρCd·A·vn·|v| along the normal; light skin friction.
    const pressure = -0.5 * AIR_DENSITY * DRAG_NORMAL * area * vn * speed;
    const friction = -0.5 * AIR_DENSITY * DRAG_TANGENT * area * speed;
    for (let k = 0; k < 3; k++) {
      const f =
        (pressure * normal[k] + friction * (rel[k] - vn * normal[k])) / 3;
      force[a * 3 + k] += f;
      force[b * 3 + k] += f;
      force[c * 3 + k] += f;
    }
  }
  const area = ((cloth.topWidth + cloth.bottomWidth) / 2) * cloth.length;
  const particleMass = (CLOTH_DENSITY * area) / n;
  const keep = Math.pow(1 - DAMPING_PER_S, h);
  for (let i = cols; i < n; i++) {
    // Explicit drag overshoots when it would reverse the air speed in one
    // step (fast flight): cap it at most of the relative speed.
    const rel = [0, 1, 2].map(
      (k) => (pos[i * 3 + k] - prev[i * 3 + k]) / h - wind[k],
    );
    const dv =
      (Math.hypot(force[i * 3], force[i * 3 + 1], force[i * 3 + 2]) /
        particleMass) *
      h;
    const limit = 0.8 * Math.hypot(...rel);
    if (dv > limit && dv > 0)
      for (let k = 0; k < 3; k++) force[i * 3 + k] *= limit / dv;
  }
  for (let i = 0; i < n; i++) {
    if (i < cols) continue; // pinned top row
    for (let k = 0; k < 3; k++) {
      const j = i * 3 + k;
      const accel = force[j] / particleMass - (k === 2 ? GRAVITY : 0);
      const next = pos[j] + (pos[j] - prev[j]) * keep + accel * h * h;
      prev[j] = pos[j];
      pos[j] = next;
    }
  }
  for (let c = 0; c < cols; c++) {
    const anchor = env.anchors[c];
    for (let k = 0; k < 3; k++) {
      prev[c * 3 + k] = pos[c * 3 + k];
      pos[c * 3 + k] = anchor[k];
    }
  }
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    for (const [a, b, restLength, stiffness] of cloth.links)
      satisfy(pos, a, b, restLength, stiffness, cols);
    for (const capsule of env.colliders || []) collide(pos, capsule, cols);
  }
  // Fabric barely stretches: never further from its pin than its length.
  for (const [i, pin, max] of cloth.tethers) {
    const d = sub(pos, i, pin);
    const length = Math.hypot(...d);
    if (length <= max) continue;
    for (let k = 0; k < 3; k++)
      pos[i * 3 + k] = pos[pin * 3 + k] + (d[k] * max) / length;
  }
}

function sub(p, a, b) {
  return [
    p[a * 3] - p[b * 3],
    p[a * 3 + 1] - p[b * 3 + 1],
    p[a * 3 + 2] - p[b * 3 + 2],
  ];
}

function satisfy(pos, a, b, restLength, stiffness, cols) {
  const d = sub(pos, b, a);
  const length = Math.hypot(...d);
  if (length < 1e-9) return;
  const pinnedA = a < cols;
  const pinnedB = b < cols;
  if (pinnedA && pinnedB) return;
  const error = ((length - restLength) / length) * stiffness;
  const wa = pinnedA ? 0 : pinnedB ? 1 : 0.5;
  const wb = pinnedB ? 0 : pinnedA ? 1 : 0.5;
  for (let k = 0; k < 3; k++) {
    pos[a * 3 + k] += d[k] * error * wa;
    pos[b * 3 + k] -= d[k] * error * wb;
  }
}

function collide(pos, { a, b, radius }, cols) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const abLength2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
  for (let i = cols; i < pos.length / 3; i++) {
    const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const t = Math.min(
      1,
      Math.max(
        0,
        ((p[0] - a[0]) * ab[0] +
          (p[1] - a[1]) * ab[1] +
          (p[2] - a[2]) * ab[2]) /
          abLength2,
      ),
    );
    const closest = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    const d = [p[0] - closest[0], p[1] - closest[1], p[2] - closest[2]];
    const length = Math.hypot(...d);
    if (length >= radius || length < 1e-9) continue;
    const push = (radius - length) / length;
    for (let k = 0; k < 3; k++) pos[i * 3 + k] += d[k] * push;
  }
}

/**
 * Smooth per-vertex normals for lighting (area-weighted face normals).
 * @returns {Float32Array}
 */
export function clothNormals(cloth) {
  const { pos } = cloth;
  const normals = new Float32Array(pos.length);
  for (const [a, b, c] of cloth.triangles) {
    const ab = sub(pos, b, a);
    const ac = sub(pos, c, a);
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    for (const v of [a, b, c])
      for (let k = 0; k < 3; k++) normals[v * 3 + k] += n[k];
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= length;
    normals[i + 1] /= length;
    normals[i + 2] /= length;
  }
  return normals;
}
