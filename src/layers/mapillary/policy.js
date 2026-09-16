/** Identity and tuning for the Mapillary street-level layer. */
export const MAPILLARY_LAYER_ID = 'mapillary';
export const MAPILLARY_KEY_ID = 'mapillary';
export const MAPILLARY_GRAPH_HOST = 'https://graph.mapillary.com';

/** Stable id prefixes for picked primitives. */
export const PICK_PREFIX = Object.freeze({
  sequence: 'mly:seq:',
  image: 'mly:img:',
  feature: 'mly:feat:',
  object: 'mly:obj:',
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

/** Query-result rendering: clamped icons up to this many features, unclamped
 * icons up to FEATURE_ICON_MAX, coloured points beyond. */
export const FEATURE_ICON_LIMIT = 6000;
export const FEATURE_ICON_MAX = 80_000;
/** 3D object models are built for result sets up to this size. */
export const OBJECTS_3D_LIMIT = 1500;
export const OBJECTS_3D_BATCH = 50;
export const FEATURE_ICON_SIZE_PX = 30;
export const FEATURE_POINT_SIZE_PX = 9;
export const FEATURE_RENDER_BATCH = 4000;

/** Fields requested from the graph API. */
export const IMAGE_FIELDS =
  'id,captured_at,compass_angle,computed_compass_angle,geometry,computed_geometry,computed_altitude,is_pano,sequence,thumb_256_url,creator,quality_score';
export const SEQUENCE_IMAGE_FIELDS =
  'id,captured_at,compass_angle,geometry,is_pano,computed_altitude';
export const FEATURE_FIELDS =
  'id,object_value,geometry,first_seen_at,last_seen_at,images,aligned_direction';
