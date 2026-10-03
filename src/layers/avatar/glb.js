/**
 * Load-time glTF normalization for avatar models.
 *
 * The glTF spec says a skinned mesh's own node transform and its ancestors'
 * transforms are ignored: joints alone place the vertices. CesiumJS (1.138)
 * still applies the ancestors, so the very common Mixamo/Blender layout — the
 * mesh under an armature node scaled 0.01 and rotated −90° about X — renders
 * as a 1.8 cm figure lying on its back. Moving every skinned mesh node (that
 * has no children) to its scene root with an identity transform is a no-op
 * under the spec and makes Cesium agree with three.js and Blender.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
/** Rest-pose joint bounds are padded by this share of their diagonal so the
 *  skin (head top, toes, hands) and animated poses stay inside. */
const BOUNDS_PADDING = 0.15;
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

/**
 * Re-parent skinned mesh nodes to the scene root. Mutates and returns the
 * glTF JSON object.
 * @param {object} gltf
 * @returns {{ gltf: object, changed: number }}
 */
export function normalizeSkinnedNodes(gltf) {
  const nodes = gltf?.nodes || [];
  const parentOf = new Map();
  nodes.forEach((node, index) =>
    (node.children || []).forEach((child) => parentOf.set(child, index)),
  );
  const rootOf = (index) => {
    let current = index;
    while (parentOf.has(current)) current = parentOf.get(current);
    return current;
  };
  let changed = 0;
  nodes.forEach((node, index) => {
    if (node.skin === undefined || node.mesh === undefined) return;
    if (node.children?.length) return; // Moving it would move its children.
    const parent = parentOf.get(index);
    const hasOwnTransform =
      node.matrix || node.translation || node.rotation || node.scale;
    if (parent === undefined && !hasOwnTransform) return;
    if (parent !== undefined) {
      const root = rootOf(index);
      const siblings = nodes[parent].children;
      siblings.splice(siblings.indexOf(index), 1);
      if (!siblings.length) delete nodes[parent].children;
      parentOf.delete(index);
      for (const scene of gltf.scenes || []) {
        if (scene.nodes?.includes(root) && !scene.nodes.includes(index))
          scene.nodes.push(index);
      }
    }
    delete node.matrix;
    delete node.translation;
    delete node.rotation;
    delete node.scale;
    fitPositionBounds(gltf, node);
    changed += 1;
  });
  return { gltf, changed };
}

/** Column-major 4×4 product. */
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++)
        out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return out;
}

function localMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

/**
 * Cesium sizes a primitive from its POSITION accessor's min/max. For a skin
 * those are the unskinned (often centimetre) bind positions, so a re-parented
 * skinned mesh would get a bounding sphere ~100× too large and off-centre.
 * Replace them, in memory, with the rest-pose joint bounds plus padding —
 * where the skin actually renders.
 */
function fitPositionBounds(gltf, node) {
  const joints = gltf.skins?.[node.skin]?.joints;
  const mesh = gltf.meshes?.[node.mesh];
  if (!joints?.length || !mesh) return;
  const nodes = gltf.nodes;
  const parentOf = new Map();
  nodes.forEach((candidate, index) =>
    (candidate.children || []).forEach((child) => parentOf.set(child, index)),
  );
  const worldCache = new Map();
  const world = (index) => {
    if (worldCache.has(index)) return worldCache.get(index);
    const local = localMatrix(nodes[index]);
    const matrix = parentOf.has(index)
      ? multiply(world(parentOf.get(index)), local)
      : local;
    worldCache.set(index, matrix);
    return matrix;
  };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const joint of joints) {
    const matrix = world(joint);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], matrix[12 + axis]);
      max[axis] = Math.max(max[axis], matrix[12 + axis]);
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return;
  const pad =
    BOUNDS_PADDING *
    Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const bounds = {
    min: min.map((value) => value - pad),
    max: max.map((value) => value + pad),
  };
  for (const primitive of mesh.primitives || []) {
    const accessor = gltf.accessors?.[primitive.attributes?.POSITION];
    if (accessor?.min && accessor?.max) {
      accessor.min = bounds.min.slice();
      accessor.max = bounds.max.slice();
    }
  }
}

/**
 * Normalize a binary glTF. Returns the original bytes when the input is not a
 * GLB or needs no change; binary chunks are carried over untouched.
 * @param {Uint8Array} bytes
 * @returns {{ bytes: Uint8Array, changed: number }}
 */
export function normalizeGlb(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 20)
    return { bytes, changed: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2)
    return { bytes, changed: 0 };
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength > bytes.length)
    return { bytes, changed: 0 };
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)),
  );
  const { changed } = normalizeSkinnedNodes(json);
  if (!changed) return { bytes, changed: 0 };

  let encoded = new TextEncoder().encode(JSON.stringify(json));
  const padding = (4 - (encoded.length % 4)) % 4;
  if (padding) {
    const padded = new Uint8Array(encoded.length + padding).fill(0x20);
    padded.set(encoded);
    encoded = padded;
  }
  const rest = bytes.subarray(20 + jsonLength);
  const out = new Uint8Array(20 + encoded.length + rest.length);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, GLB_MAGIC, true);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, out.length, true);
  outView.setUint32(12, encoded.length, true);
  outView.setUint32(16, CHUNK_JSON, true);
  out.set(encoded, 20);
  out.set(rest, 20 + encoded.length);
  return { bytes: out, changed };
}

/**
 * Fetch a model and return Cesium `Model.fromGltfAsync` source options:
 * `{ gltf, basePath }` for a normalized model, `{ url }` otherwise.
 * @param {string} url Resolved URL.
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function loadAvatarSource(
  url,
  { fetchImpl = fetch, signal } = {},
) {
  const response = await fetchImpl(url, { signal });
  if (!response.ok)
    throw new Error(`Avatar model request failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const basePath = new URL(url, globalThis.location?.href).href;
  if (bytes[0] === 0x7b) {
    // '{' — a JSON .gltf with external or embedded buffers.
    const gltf = JSON.parse(new TextDecoder().decode(bytes));
    normalizeSkinnedNodes(gltf);
    return { gltf, basePath };
  }
  const normalized = normalizeGlb(bytes);
  if (normalized.bytes === bytes && bytes.byteLength >= 4) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset).getUint32(
      0,
      true,
    );
    if (magic !== GLB_MAGIC)
      throw new Error('Avatar model is not glTF (expected .glb or .gltf)');
  }
  return { gltf: normalized.bytes, basePath };
}
