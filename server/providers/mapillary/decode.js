import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { tileLocalToLonLat } from '../../../src/layers/mapillary/tileMath.js';

/** Vector-tile layer name inside each Mapillary map-feature tile. */
const FEATURE_LAYER_NAMES = Object.freeze({
  points: 'point',
  signs: 'traffic_sign',
});

/**
 * Decode one map-feature tile into compact rows, keeping only features whose
 * value passes `matcher` and whose sighting window overlaps [since, until].
 * Rows are positional arrays to keep the streamed payload small:
 * [lon, lat, id, value, firstSeenMs, lastSeenMs].
 * @param {Buffer|Uint8Array} bytes
 * @param {{x:number,y:number,z:number,layer:'points'|'signs'}} address
 * @param {{matcher?: (value:string)=>boolean, since?: number|null, until?: number|null}} [filter]
 * @returns {Array<[number, number, string, string, number, number]>}
 */
export function decodeFeatureRows(bytes, address, filter = {}) {
  if (!bytes || !bytes.length) return [];
  const layerName = FEATURE_LAYER_NAMES[address.layer];
  const tile = new VectorTile(new PbfReader(bytes));
  const layer = layerName ? tile.layers[layerName] : null;
  if (!layer) return [];
  const matcher = filter.matcher || (() => true);
  const since = Number.isFinite(filter.since) ? filter.since : null;
  const until = Number.isFinite(filter.until) ? filter.until : null;
  const rows = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const value = feature.properties?.value;
    if (typeof value !== 'string' || !matcher(value)) continue;
    const first = Number(feature.properties.first_seen_at) || 0;
    const last = Number(feature.properties.last_seen_at) || first;
    if (since !== null && last < since) continue;
    if (until !== null && first > until) continue;
    const geometry = feature.loadGeometry();
    const point = geometry?.[0]?.[0];
    if (!point) continue;
    const [lon, lat] = tileLocalToLonLat(
      point.x,
      point.y,
      layer.extent,
      address.x,
      address.y,
      address.z,
    );
    rows.push([
      Number(lon.toFixed(6)),
      Number(lat.toFixed(6)),
      String(feature.properties.id ?? feature.id ?? ''),
      value,
      first,
      last,
    ]);
  }
  return rows;
}
