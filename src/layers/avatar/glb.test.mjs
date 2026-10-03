import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAvatarSource,
  normalizeGlb,
  normalizeSkinnedNodes,
} from './glb.js';

/** Mixamo-style layout: skinned mesh under a scaled, rotated armature. */
function mixamoLike() {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: 'Armature',
        rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        scale: [0.01, 0.01, 0.01],
        children: [1, 2],
      },
      { name: 'Body', mesh: 0, skin: 0, scale: [2, 2, 2] },
      { name: 'Hips', translation: [0, 100, 0], children: [3] },
      { name: 'Spine', translation: [0, 80, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: [-90, -20, 0], max: [90, 20, 183] }],
    skins: [{ joints: [2, 3] }],
  };
}

function glb(json, bin = new Uint8Array([1, 2, 3, 4])) {
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  const padded = new Uint8Array(text.length + pad).fill(0x20);
  padded.set(text);
  text = padded;
  const out = new Uint8Array(20 + text.length + 8 + bin.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  view.setUint32(20 + text.length, bin.length, true);
  view.setUint32(24 + text.length, 0x004e4942, true);
  out.set(bin, 28 + text.length);
  return out;
}

function readJson(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
}

test('skinned meshes move to the scene root with no transform', () => {
  const { gltf, changed } = normalizeSkinnedNodes(mixamoLike());
  assert.equal(changed, 1);
  assert.deepEqual(gltf.scenes[0].nodes, [0, 1]);
  assert.deepEqual(gltf.nodes[0].children, [2]);
  assert.deepEqual(gltf.nodes[1], { name: 'Body', mesh: 0, skin: 0 });
  // Bounds follow the skeleton (metres after the armature's 0.01 scale and
  // −90° X rotation), not the raw centimetre positions.
  const { min, max } = gltf.accessors[0];
  assert.ok(Math.abs(max[1] - min[1]) < 2, `${min} → ${max}`);
  assert.ok(
    max.every((value) => Math.abs(value) < 3),
    `${max}`,
  );
  // Joints keep their hierarchy and transforms.
  assert.deepEqual(gltf.nodes[0].scale, [0.01, 0.01, 0.01]);
  assert.deepEqual(gltf.nodes[2].children, [3]);
});

test('spec-friendly and unskinned models are left alone', () => {
  const flat = mixamoLike();
  flat.nodes[0].children = [2];
  flat.scenes[0].nodes = [0, 1];
  delete flat.nodes[1].scale;
  assert.equal(normalizeSkinnedNodes(flat).changed, 0);

  const withChild = mixamoLike();
  withChild.nodes[1].children = [3];
  withChild.nodes[2].children = [];
  assert.equal(normalizeSkinnedNodes(withChild).changed, 0);

  const bytes = glb({ asset: { version: '2.0' }, nodes: [{ mesh: 0 }] });
  assert.equal(normalizeGlb(bytes).bytes, bytes);
  const notGlb = new Uint8Array(32);
  assert.equal(normalizeGlb(notGlb).bytes, notGlb);
});

test('GLB rewrite keeps the binary chunk and valid lengths', () => {
  const bin = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
  const { bytes, changed } = normalizeGlb(glb(mixamoLike(), bin));
  assert.equal(changed, 1);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint32(8, true), bytes.length);
  const jsonLength = view.getUint32(12, true);
  assert.equal(jsonLength % 4, 0);
  assert.deepEqual(readJson(bytes).scenes[0].nodes, [0, 1]);
  assert.deepEqual([...bytes.subarray(28 + jsonLength)], [...bin]);
});

test('loadAvatarSource returns normalized gltf bytes or JSON', async () => {
  const fetchFor = (body) => async () => ({
    ok: true,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset),
  });
  const binary = await loadAvatarSource('https://example.org/a/me.glb', {
    fetchImpl: fetchFor(glb(mixamoLike())),
  });
  assert.equal(binary.basePath, 'https://example.org/a/me.glb');
  assert.deepEqual(readJson(binary.gltf).scenes[0].nodes, [0, 1]);

  const json = await loadAvatarSource('https://example.org/me.gltf', {
    fetchImpl: fetchFor(new TextEncoder().encode(JSON.stringify(mixamoLike()))),
  });
  assert.deepEqual(json.gltf.scenes[0].nodes, [0, 1]);

  await assert.rejects(
    loadAvatarSource('https://example.org/x.glb', {
      fetchImpl: fetchFor(new TextEncoder().encode('<!doctype html>')),
    }),
    /not glTF/,
  );
  await assert.rejects(
    loadAvatarSource('https://example.org/x.glb', {
      fetchImpl: async () => ({ ok: false, status: 404 }),
    }),
    /404/,
  );
});
