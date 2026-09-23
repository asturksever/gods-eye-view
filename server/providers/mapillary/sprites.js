import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  SPRITE_DISK_DIR,
  SPRITE_DISK_TTL_MS,
  SPRITE_MAX_BYTES,
  SPRITE_SOURCE_ROOT,
} from './constants.js';
import { isSignValue } from '../../../src/layers/mapillary/values.js';

/** A taxonomy value: lower-case segments joined by `--`, words by `-`. */
const VALUE_GRAMMAR =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** @type {Map<string, Promise<Buffer|null>>} */
const _inFlight = new Map();

function spritePath(value) {
  return path.join(SPRITE_DISK_DIR, `${value}.svg`);
}

async function readDisk(value) {
  try {
    const file = spritePath(value);
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs > SPRITE_DISK_TTL_MS) return null;
    return await fsp.readFile(file);
  } catch {
    return null;
  }
}

async function fetchSprite(value) {
  const pkg = isSignValue(value) ? 'package_signs' : 'package_objects';
  const response = await fetch(`${SPRITE_SOURCE_ROOT}/${pkg}/${value}.svg`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`sprite source HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length > SPRITE_MAX_BYTES ||
    !bytes.subarray(0, 512).toString().includes('<svg')
  )
    return null;
  const file = spritePath(value);
  fsp
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => fsp.writeFile(file, bytes))
    .catch(() => {});
  return bytes;
}

/**
 * GET /api/mapillary/sprite/<value>.svg — the Mapillary icon for a taxonomy
 * value, fetched once from the MIT sprite source and cached on disk.
 */
export async function handleSprite(req, res) {
  const match = /^\/([a-z0-9-]+)\.svg$/.exec((req.url || '').split('?')[0]);
  const value = match?.[1];
  if (!value || !VALUE_GRAMMAR.test(value)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid sprite value' }));
    return;
  }
  try {
    let bytes = await readDisk(value);
    if (!bytes) {
      let pending = _inFlight.get(value);
      if (!pending) {
        pending = fetchSprite(value).finally(() => _inFlight.delete(value));
        _inFlight.set(value, pending);
      }
      bytes = await pending;
    }
    if (!bytes) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(JSON.stringify({ error: 'No sprite for value' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(bytes);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error?.message || 'Sprite unavailable' }));
  }
}
