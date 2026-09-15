import { readNdjsonResponse } from './ndjson.js';
import {
  FEATURE_FIELDS,
  IMAGE_FIELDS,
  MAPILLARY_GRAPH_HOST,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  SEQUENCE_IMAGE_FIELDS,
  SEQUENCE_IMAGES_LIMIT,
} from './policy.js';

/** Error carrying the HTTP status and any server-provided payload. */
export class MapillarySourceError extends Error {
  constructor(message, { status = 0, payload = null } = {}) {
    super(message);
    this.name = 'MapillarySourceError';
    this.status = status;
    this.payload = payload;
    this.keyRequired = payload?.keyRequired ?? payload?.error === 'no_key';
  }
}

async function readJsonOrThrow(response, label) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* status is authoritative */
  }
  if (!response.ok)
    throw new MapillarySourceError(
      payload?.error?.message ||
        payload?.error ||
        `${label} HTTP ${response.status}`,
      { status: response.status, payload },
    );
  return payload;
}

/**
 * Every network path the Mapillary layer uses. Tiles, the feature stream,
 * the planner and sprites go through the local dev-server proxy; entity
 * lookups go straight to graph.mapillary.com with the client token, exactly
 * as the embedded MapillaryJS viewer does.
 * @param {{token?: string, fetchImpl?: Function, endpoints?: object}} options
 */
export function createMapillarySource({
  token = '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoints = {},
} = {}) {
  const urls = {
    status: '/api/mapillary/status',
    tiles: '/api/mapillary/tiles',
    features: '/api/mapillary/features',
    plan: '/api/mapillary/plan',
    sprite: '/api/mapillary/sprite',
    geocode: '/api/geocode',
    graph: MAPILLARY_GRAPH_HOST,
    ...endpoints,
  };

  async function graph(path, params = {}, { signal } = {}) {
    if (!token)
      throw new MapillarySourceError('Mapillary token not configured', {
        status: 503,
        payload: { keyRequired: true },
      });
    const search = new URLSearchParams({ access_token: token, ...params });
    const response = await fetchImpl(`${urls.graph}/${path}?${search}`, {
      signal,
    });
    return readJsonOrThrow(response, 'Mapillary graph');
  }

  return {
    get token() {
      return token;
    },
    hasToken: () => Boolean(token),

    async getStatus({ signal } = {}) {
      const response = await fetchImpl(urls.status, {
        signal,
        cache: 'no-store',
      });
      return readJsonOrThrow(response, 'Mapillary status');
    },

    /** Raw protobuf bytes for one tile; an empty array means no data. */
    async getTile(layer, z, x, y, { signal } = {}) {
      const response = await fetchImpl(
        `${urls.tiles}/${layer}/${z}/${x}/${y}`,
        {
          signal,
        },
      );
      if (response.status === 204) return new Uint8Array(0);
      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          /* ignore */
        }
        throw new MapillarySourceError(
          payload?.error || `Tile HTTP ${response.status}`,
          {
            status: response.status,
            payload,
          },
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    /**
     * Stream a feature query. `onEvent` receives each NDJSON record
     * ({type:'start'|'tile'|'done'}); resolves with the done record.
     */
    async queryFeatures(body, onEvent, { signal } = {}) {
      const response = await fetchImpl(urls.features, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) await readJsonOrThrow(response, 'Feature query');
      let done = null;
      await readNdjsonResponse(
        response,
        (record) => {
          if (record?.type === 'done') done = record;
          onEvent?.(record);
        },
        { signal },
      );
      return done;
    },

    /** Natural language → plan, via the server-side Claude planner. */
    async plan(body, { signal } = {}) {
      const response = await fetchImpl(urls.plan, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJsonOrThrow(response, 'Planner');
    },

    /** Place name → geocode results through the app's existing Nominatim route. */
    async geocode(query, { signal } = {}) {
      const response = await fetchImpl(
        `${urls.geocode}?${new URLSearchParams({ q: query })}`,
        { signal },
      );
      const payload = await readJsonOrThrow(response, 'Geocode');
      return Array.isArray(payload?.results) ? payload.results : [];
    },

    getImage(id, { signal, fields = IMAGE_FIELDS } = {}) {
      return graph(String(id), { fields }, { signal });
    },

    async getSequenceImages(
      sequenceId,
      { signal, limit = SEQUENCE_IMAGES_LIMIT } = {},
    ) {
      const payload = await graph(
        'images',
        {
          sequence_ids: String(sequenceId),
          fields: SEQUENCE_IMAGE_FIELDS,
          limit: String(limit),
        },
        { signal },
      );
      return Array.isArray(payload?.data) ? payload.data : [];
    },

    async nearestImages(
      { lat, lon, radius = NEAREST_RADIUS_M, limit = NEAREST_LIMIT },
      { signal } = {},
    ) {
      const payload = await graph(
        'images',
        {
          lat: String(lat),
          lng: String(lon),
          radius: String(Math.min(50, Math.max(1, radius))),
          limit: String(Math.min(100, Math.max(1, limit))),
          fields: IMAGE_FIELDS,
        },
        { signal },
      );
      return Array.isArray(payload?.data) ? payload.data : [];
    },

    getMapFeature(id, { signal } = {}) {
      return graph(String(id), { fields: FEATURE_FIELDS }, { signal });
    },

    spriteUrl(value) {
      return `${urls.sprite}/${encodeURIComponent(value)}.svg`;
    },
  };
}
