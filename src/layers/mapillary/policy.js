/** Identity and tuning for the Mapillary street-level layer. */
export const MAPILLARY_LAYER_ID = 'mapillary';
export const MAPILLARY_KEY_ID = 'mapillary';
export const MAPILLARY_GRAPH_HOST = 'https://graph.mapillary.com';

/** Stable id prefixes for picked primitives. */
export const PICK_PREFIX = Object.freeze({
  sequence: 'mly:seq:',
  image: 'mly:img:',
  position: 'mly:pos',
});

/** Brand green for coverage; panoramas get a distinct hue; selection is GEV cyan. */
export const COLORS = Object.freeze({
  coverage: '#05cb63',
  coverageOld: '#2e7d5b',
  pano: '#ff4fd8',
  selected: '#00d4ff',
  image: '#e8eaed',
  position: '#ffb300',
});

/** Camera-driven coverage refresh. */
export const COVERAGE_MOVE_DEBOUNCE_MS = 320;
export const COVERAGE_MAX_TILES = 9;
/** Overview (z0–5) coverage points seen from orbit. */
export const COVERAGE_OVERVIEW_MAX_TILES = 16;
export const COVERAGE_OVERVIEW_POINT_PX = 2.5;
export const COVERAGE_MAX_SEQUENCES = 6000;
export const COVERAGE_LINE_WIDTH_PX = 2.5;
/** Sequences newer than this many days draw at full brightness. */
export const COVERAGE_RECENT_DAYS = 730;

/** Per-sequence image cones after a sequence is selected. */
export const SEQUENCE_IMAGES_LIMIT = 2000;
export const IMAGE_CONE_SIZE_PX = 26;
export const IMAGE_CONE_MIN_SPACING_M = 3;

/** Nearest-image search when the user asks to look at a place. */
export const NEAREST_RADIUS_M = 50;
export const NEAREST_LIMIT = 8;

/**
 * On-globe credit shown while the layer is enabled. Mapillary imagery and
 * derived data are CC BY-SA 4.0 and require visible attribution.
 */
export const MAPILLARY_CREDIT_HTML =
  'Street Level: imagery © <a href="https://www.mapillary.com" target="_blank" rel="noopener">Mapillary</a> contributors, CC BY-SA 4.0';

/** Fields requested from the graph API. */
export const IMAGE_FIELDS =
  'id,captured_at,compass_angle,computed_compass_angle,geometry,computed_geometry,computed_altitude,is_pano,sequence,thumb_256_url,creator,quality_score';
export const SEQUENCE_IMAGE_FIELDS =
  'id,captured_at,compass_angle,geometry,is_pano,computed_altitude';
