import { installMapillaryRoutes } from './mapillary/routes.js';

/**
 * Vite plugin: Mapillary street-level data.
 *
 * Serves cached vector tiles (coverage, point features, traffic signs) with
 * the Mapillary token added server-side, fans a city-sized bbox out over
 * z14 feature tiles as an NDJSON stream, turns natural-language requests
 * into query plans with Claude (ANTHROPIC_API_KEY stays on this machine),
 * and proxies the MIT-licensed Mapillary sprite icons.
 */
function mapillaryProxy() {
  return {
    name: 'mapillary-proxy',
    configureServer(server) {
      installMapillaryRoutes(server.middlewares);
    },
    configurePreviewServer(server) {
      installMapillaryRoutes(server.middlewares);
    },
  };
}

export { mapillaryProxy };
