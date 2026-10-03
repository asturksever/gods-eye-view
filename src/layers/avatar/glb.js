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
    changed += 1;
  });
  return { gltf, changed };
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
