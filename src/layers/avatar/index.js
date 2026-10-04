import * as Cesium from 'cesium';
import {
  ARRIVAL_RADIUS_M,
  CAMERA_PITCH_DEFAULT,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  CAMERA_RANGE_DEFAULT_M,
  CAMERA_RANGE_MAX_M,
  CAMERA_RANGE_MIN_M,
  DEFAULT_AVATAR_URL,
  DEFAULT_CLIP_MAP,
  DEFAULT_HEADING_OFFSET,
  EYE_HEIGHT_M,
  FALLBACK_AVATAR_URL,
  HeightSmoother,
  WALK_SPEED_MPS,
  cameraTakenBy,
  clamp,
  clipRateForSpeed,
  clipRoleForSpeed,
  descendToGround,
  describePose,
  FLY_SPEED_MPS,
  fallStep,
  flyHeight,
  flyVelocityFromKeys,
  parseRoadSnap,
  ringAround,
  roadSnapUrl,
  streetLevelNear,
  easeInOut,
  followGround,
  keyIntent,
  localOffset,
  normalizeAngle,
  offsetLonLat,
  parseAvatarParams,
  resolveClipMap,
  turnToward,
  unoccludedRange,
  velocityFromKeys,
} from './model.js';
import { loadAvatarSource } from './glb.js';
import { SURF_LEAN, createFlightGear } from './flightGear.js';
export * from './model.js';

const RENDER_OWNER = 'me-mode';
const MODE_EVENT = 'gev:me-mode-changed';
/** Ground re-sample cadence while moving / standing (ms). Each sample is a
 *  synchronous pick render, so this is rationed rather than per-frame. */
const SAMPLE_MOVING_MS = 90;
const SAMPLE_IDLE_MS = 600;
/** Exact first-placement sample waits at most this long for tiles (ms). */
const EXACT_SAMPLE_TIMEOUT_MS = 8000;
/** Seconds for the displayed height to close most of a new sample's gap. */
const HEIGHT_EASE_S = 0.12;
const TURN_RATE = 10;
/** Camera moved by someone else since our last frame: hand it over. */
const CAMERA_HANDOFF_M = 0.5;
const CAMERA_HANDOFF_DOT = 0.9995;
const HINT_TEXT =
  'WASD · Shift run · F fly, E/Q up/down, B cape/surf · drag to look';
/** Road snapping gives up after this long and falls back to the tiles. */
const ROAD_SNAP_TIMEOUT_MS = 6000;
/** Street-level check rings around the final spot (m) and their directions. */
const STREET_CHECK_RADII = [5, 10, 18, 28, 42, 60, 85];
const STREET_CHECK_DIRECTIONS = 12;
/** Forward lean while flying at full speed (radians). */
const FLY_LEAN = 0.9;
/** A drag shorter than this is a click: drop at the screen centre. */
const PEGMAN_DRAG_PX = 6;
const PEGMAN_SVG =
  '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
  '<circle cx="12" cy="4.6" r="3.1" fill="#f6c400" stroke="#7a5b00" stroke-width="0.9"/>' +
  '<path d="M8.3 9.2h7.4l1.6 6.1h-2.3l-.6 7.2h-2.1L12 17.6l-.3 4.9H9.6L9 15.3H6.7z" ' +
  'fill="#f6c400" stroke="#7a5b00" stroke-width="0.9" stroke-linejoin="round"/></svg>';

/** A model that has not finished loading by then fails the toggle. */
const MODEL_READY_TIMEOUT_MS = 30000;
/** Entry flight from the current view down to the follow camera. */
const ENTRY_MS = 1600;
/** Skip the entry flight when the camera is already this close (m). */
const ENTRY_MIN_DISTANCE_M = 30;
/** Seconds for the follow distance to recover after an obstruction clears. */
const RANGE_RECOVER_S = 0.4;

function isTextTarget(target) {
  return Boolean(
    target?.isContentEditable ||
    target?.closest?.(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ),
  );
}

/** Where a key landed: a text field, a focusable control, or the globe/page. */
function focusKind(target) {
  if (isTextTarget(target)) return 'text';
  const document = globalThis.document;
  if (
    !target ||
    target === document?.body ||
    target === document?.documentElement ||
    target.tagName === 'CANVAS'
  )
    return 'surface';
  return target.closest?.('button, a[href], select, [role], [tabindex]')
    ? 'control'
    : 'surface';
}

/** Ground lies between the Dead Sea shore and Everest's summit. */
function plausibleGround(height) {
  return Number.isFinite(height) && height > -500 && height < 9000;
}

/** Cockpit flies the camera itself; Me Mode never runs alongside it. */
function isCockpitActive() {
  return Boolean(globalThis.document?.body?.classList.contains('cockpit-mode'));
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Me Mode: one rigged glTF avatar that walks on the photoreal surface, with a
 * third-/first-person follow camera. While enabled the layer owns the camera
 * and WASD/Shift/V; disabling restores Cesium's camera inputs.
 *
 * @param {object} options
 * @param {{ holdContinuousRender: Function, releaseContinuousRender: Function }} options.render
 * @param {(url: string) => string} [options.resolveAsset]
 * @param {string} [options.search] Query string carrying `?avatar=` / `?clips=`.
 */
export function createAvatarLayer({
  render,
  resolveAsset = (url) => url,
  search = globalThis.location?.search || '',
} = {}) {
  if (typeof render?.holdContinuousRender !== 'function')
    throw new TypeError('Me Mode requires the render governor');
  const params = parseAvatarParams(search);

  let _viewer = null;
  let _dataManager = null;
  let _enabled = false;
  let _model = null;
  let _modelEpoch = 0;
  let _modelUrl = params.url || DEFAULT_AVATAR_URL;
  let _requestedClips = { ...DEFAULT_CLIP_MAP, ...(params.clips || {}) };
  let _headingOffset = params.headingOffset ?? DEFAULT_HEADING_OFFSET;
  let _clips = { idle: null, walk: null, run: null };
  let _clipName = null;
  let _clipSeconds = 0;
  let _clipRate = 1;
  let _error = null;
  let _removers = [];
  let _hint = null;
  let _viewButton = null;
  let _flyButton = null;
  let _pegman = null;
  let _initialized = false;
  let _pegmanRemovers = [];
  let _flying = false;
  let _fallSpeed = 0;
  let _floor = null;
  let _flyPitch = 0;
  let _flyStyle = 'cape';
  let _gear = null;
  let _styleButton = null;
  let _gearShown = null;
  let _flyClock = 0;
  let _savedInputs = null;
  let _savedCollision = null;
  let _takeoverStrikes = 0;

  // Pose (degrees / ellipsoid metres / compass radians).
  let _lon = null;
  let _lat = null;
  let _height = 0;
  let _groundReady = false;
  let _heading = 0;
  let _speed = 0;
  let _autopilot = null;
  let _pendingStart = null;
  let _placeEpoch = 0;
  const _smoother = new HeightSmoother();
  let _lastSampleAt = 0;

  // Camera.
  let _camHeading = 0;
  let _camPitch = CAMERA_PITCH_DEFAULT;
  let _camRange = CAMERA_RANGE_DEFAULT_M;
  let _firstPerson = false;
  let _lastFrameAt = 0;
  let _cameraSet = null;
  let _handedOff = false;
  let _loadAbort = null;
  // Entry flight: the camera pose when Me Mode turned on, and when it began.
  let _entryFrom = null;
  let _entryStartedAt = null;
  // Follow distance after walls/slopes behind the avatar are accounted for.
  let _rangeTarget = CAMERA_RANGE_DEFAULT_M;
  let _rangeNow = CAMERA_RANGE_DEFAULT_M;
  let _lastOcclusionAt = 0;
  const _keys = {
    forward: false,
    back: false,
    left: false,
    right: false,
    run: false,
  };

  const scratchMatrix = new Cesium.Matrix4();
  const scratchDirection = new Cesium.Cartesian3();
  const scratchUp = new Cesium.Cartesian3();
  const scratchEye = new Cesium.Cartesian3();
  const scratchDestination = new Cesium.Cartesian3();

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    _removers.push(() => target.removeEventListener(type, handler, options));
  }

  function clearKeys() {
    for (const key of Object.keys(_keys)) _keys[key] = false;
  }

  function cancelAutopilot() {
    _autopilot?.resolve?.(false);
    _autopilot = null;
  }

  function onKey(event) {
    if (!_enabled) return;
    const intent = keyIntent(event, focusKind(event.target));
    if (!intent) return;
    if (intent.kind === 'exit') {
      // Escape still reaches dialogs and selection handlers (not claimed).
      if (_dataManager)
        _dataManager.setEnabled('avatar', false, { origin: 'user' });
      return;
    }
    if (intent.kind === 'move') {
      _keys[intent.role] = intent.down;
      if (intent.down && intent.role !== 'run') cancelAutopilot();
    } else if (intent.kind === 'view' && intent.toggle) {
      setView(_firstPerson ? 'third' : 'first');
    } else if (intent.kind === 'fly' && intent.toggle) {
      setFlying(!_flying);
    } else if (intent.kind === 'style' && intent.toggle) {
      setFlyStyle(_flyStyle === 'cape' ? 'surf' : 'cape');
    }
    // Claim the key so W (POI), D (detection) and V (clean view) shortcuts
    // do not fire underneath Me Mode.
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function installInput(viewer) {
    const canvas = viewer.scene.canvas;
    let drag = null;
    listen(document, 'keydown', onKey, true);
    listen(document, 'keyup', onKey, true);
    listen(window, 'blur', clearKeys);
    // Right-drag orbits too; no browser menu at the end of it.
    listen(canvas, 'contextmenu', (event) => event.preventDefault());
    listen(canvas, 'pointerdown', (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture?.(event.pointerId);
    });
    listen(canvas, 'pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      _camHeading = normalizeAngle(_camHeading + dx * 0.005);
      _camPitch = clamp(
        _camPitch - dy * 0.004,
        CAMERA_PITCH_MIN,
        CAMERA_PITCH_MAX,
      );
    });
    const endDrag = (event) => {
      if (drag?.id === event.pointerId) drag = null;
    };
    listen(canvas, 'pointerup', endDrag);
    listen(canvas, 'pointercancel', endDrag);
    listen(
      canvas,
      'wheel',
      (event) => {
        event.preventDefault();
        if (_firstPerson) return;
        _camRange = clamp(
          _camRange * Math.exp(event.deltaY * 0.0015),
          CAMERA_RANGE_MIN_M,
          CAMERA_RANGE_MAX_M,
        );
        _rangeTarget = Math.min(_rangeTarget, _camRange);
      },
      { passive: false },
    );
    // Cockpit owns the camera too; the later mode wins.
    listen(window, 'gev:cockpit-mode-changed', (event) => {
      if (event.detail?.active && _enabled)
        _dataManager?.setEnabled('avatar', false, { origin: 'programmatic' });
    });
    _removers.push(viewer.scene.preUpdate.addEventListener(onPreUpdate));
    _removers.push(viewer.scene.postRender.addEventListener(onPostRender));
  }

  function showHint(viewer) {
    _hint = document.createElement('div');
    _hint.className = 'me-mode-hint';
    Object.assign(_hint.style, {
      position: 'absolute',
      left: '50%',
      // Above the bottom dock (location / voice / presets), which covers
      // the bottom ~100 px of the viewer.
      bottom: '128px',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '6px 6px 6px 12px',
      borderRadius: '6px',
      background: 'rgba(0, 0, 0, 0.6)',
      color: '#e6f3ff',
      font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.04em',
      pointerEvents: 'none',
      zIndex: '5',
    });
    const text = document.createElement('span');
    text.setAttribute('role', 'status');
    text.textContent = HINT_TEXT;
    _viewButton = document.createElement('button');
    _viewButton.type = 'button';
    _viewButton.className = 'me-mode-view-toggle';
    Object.assign(_viewButton.style, {
      pointerEvents: 'auto',
      cursor: 'pointer',
      padding: '3px 10px',
      border: '1px solid rgba(230, 243, 255, 0.5)',
      borderRadius: '4px',
      background: 'rgba(230, 243, 255, 0.12)',
      color: 'inherit',
      font: 'inherit',
    });
    _viewButton.addEventListener('click', () => {
      setView(_firstPerson ? 'third' : 'first');
      // Hand the keyboard back to the globe so arrows keep walking.
      _viewButton.blur();
    });
    _flyButton = _viewButton.cloneNode();
    _flyButton.className = 'me-mode-fly-toggle';
    _flyButton.addEventListener('click', () => {
      setFlying(!_flying);
      _flyButton.blur();
    });
    _styleButton = _viewButton.cloneNode();
    _styleButton.className = 'me-mode-style-toggle';
    _styleButton.addEventListener('click', () => {
      setFlyStyle(_flyStyle === 'cape' ? 'surf' : 'cape');
      _styleButton.blur();
    });
    const exit = _viewButton.cloneNode();
    exit.className = 'me-mode-exit';
    exit.textContent = '✕ Exit';
    exit.title = 'Leave Me Mode (Esc)';
    exit.addEventListener('click', () => {
      if (_dataManager)
        _dataManager.setEnabled('avatar', false, { origin: 'user' });
      else layer.disable(_viewer);
    });
    _hint.append(text, _flyButton, _styleButton, _viewButton, exit);
    syncViewButton();
    viewer.container.appendChild(_hint);
  }

  function syncViewButton() {
    if (!_viewButton) return;
    _viewButton.textContent = _firstPerson
      ? '👁 First person'
      : '🧍 Third person';
    _viewButton.title = _firstPerson
      ? 'Switch to the third-person follow camera (V)'
      : 'Switch to first person (V)';
    _viewButton.setAttribute('aria-pressed', String(_firstPerson));
    syncFlyButton();
  }

  function syncFlyButton() {
    if (_styleButton) {
      _styleButton.hidden = !_flying;
      _styleButton.textContent = _flyStyle === 'cape' ? '🦸 Cape' : '🏄 Surf';
      _styleButton.title = 'Switch between cape and surfboard (B)';
    }
    if (!_flyButton) return;
    _flyButton.textContent = _flying ? '🚶 Land' : '🕊 Fly';
    _flyButton.title = _flying
      ? 'Land where you are (F)'
      : 'Fly: WASD, E up, Q down, Shift faster (F)';
    _flyButton.setAttribute('aria-pressed', String(_flying));
  }

  /** Cape (lean into the flight) or surf (stand on a board). */
  function setFlyStyle(style) {
    _flyStyle = style === 'surf' ? 'surf' : 'cape';
    syncFlyButton();
  }

  /** Take off, or land by falling to whatever surface is below. */
  function setFlying(flying) {
    if (flying === _flying || !_groundReady) return;
    _flying = flying;
    cancelAutopilot();
    _fallSpeed = 0;
    if (flying) _floor = _smoother.value ?? _height;
    if (!flying && Number.isFinite(_floor)) _smoother.reset(_floor);
    _lastSampleAt = 0;
    syncFlyButton();
  }

  function setView(view) {
    _firstPerson = view === 'first';
    if (_model) _model.show = !_firstPerson && _groundReady;
    syncViewButton();
  }

  function cartographic(lon = _lon, lat = _lat, height = 0) {
    return Cesium.Cartographic.fromDegrees(lon, lat, height);
  }

  function excluded() {
    const own = _gear ? [..._gear.primitives] : [];
    return _model ? [_model, ...own] : own;
  }

  /** Globe surface height, or undefined when the globe cannot answer. */
  function globeHeight(carto) {
    const scene = _viewer.scene;
    if (!scene.globe?.show) return undefined;
    // The keyless fallback terrain is the bare ellipsoid; its coarse tile
    // meshes can report wildly wrong heights.
    if (_viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)
      return 0;
    const height = scene.globe.getHeight(carto);
    return plausibleGround(height) ? height : undefined;
  }

  function downRay(lon, lat, fromHeight) {
    const origin = Cesium.Cartesian3.fromDegrees(lon, lat, fromHeight);
    const down = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      origin,
      new Cesium.Cartesian3(),
    );
    return new Cesium.Ray(origin, Cesium.Cartesian3.negate(down, down));
  }

  function hitHeight(hit, fromHeight) {
    if (!hit?.position) return undefined;
    // A globe hit (no picked object) over the bare-ellipsoid fallback terrain
    // is the ellipsoid itself; its coarse tile meshes report wrong heights.
    if (
      !hit.object &&
      _viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider
    )
      return fromHeight >= 0 ? 0 : undefined;
    const height = Cesium.Cartographic.fromCartesian(hit.position).height;
    return plausibleGround(height) && height <= fromHeight + 0.01
      ? height
      : undefined;
  }

  /** First surface below `fromHeight` on loaded geometry (one pick render). */
  function castDown(lon, lat, fromHeight) {
    const scene = _viewer.scene;
    if (typeof scene.pickFromRay !== 'function') return undefined;
    try {
      return hitHeight(
        scene.pickFromRay(downRay(lon, lat, fromHeight), excluded()),
        fromHeight,
      );
    } catch {
      return undefined;
    }
  }

  /** First surface below `fromHeight`, waiting for the most detailed tiles. */
  async function castDownExact(lon, lat, fromHeight) {
    const scene = _viewer.scene;
    if (typeof scene.pickFromRayMostDetailed !== 'function') return undefined;
    try {
      return hitHeight(
        await withTimeout(
          scene.pickFromRayMostDetailed(
            downRay(lon, lat, fromHeight),
            excluded(),
          ),
          EXACT_SAMPLE_TIMEOUT_MS,
        ),
        fromHeight,
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Per-sample ground read while walking: a ray from just above the feet,
   * so canopies and bridges overhead are walked under (sampleHeight would
   * return the highest surface here, i.e. the treetop).
   */
  function sampleGround(lon, lat) {
    return followGround(
      (from) => castDown(lon, lat, from),
      _groundReady ? _height : undefined,
      () => sampleTopDown(lon, lat),
    );
  }

  /** Highest surface here: rendered tiles first, then the globe. */
  function sampleTopDown(lon, lat) {
    const scene = _viewer.scene;
    const carto = cartographic(lon, lat);
    // No photoreal tiles over bare-ellipsoid terrain: the ground is exact.
    if (
      scene.globe?.show &&
      _viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider
    )
      return 0;
    let height;
    if (scene.sampleHeightSupported) {
      try {
        height = scene.sampleHeight(carto, excluded());
      } catch {
        height = undefined;
      }
    }
    if (!plausibleGround(height)) height = globeHeight(carto);
    return plausibleGround(height) ? height : undefined;
  }

  /**
   * Exact ground for a placement: the highest surface on the most detailed
   * tiles, then probes downward through canopies and bridge decks.
   */
  async function sampleGroundExact(lon, lat) {
    const top = await sampleTopDownExact(lon, lat);
    if (!plausibleGround(top)) return undefined;
    return descendToGround((from) => castDownExact(lon, lat, from), top);
  }

  async function sampleTopDownExact(lon, lat) {
    const scene = _viewer.scene;
    if (scene.sampleHeightSupported) {
      try {
        const [carto] =
          (await withTimeout(
            scene.sampleHeightMostDetailed(
              [cartographic(lon, lat)],
              excluded(),
            ),
            EXACT_SAMPLE_TIMEOUT_MS,
          )) || [];
        if (plausibleGround(carto?.height)) return carto.height;
      } catch {
        // Fall through to terrain.
      }
    }
    const provider = _viewer.terrainProvider;
    if (scene.globe?.show && provider) {
      if (provider instanceof Cesium.EllipsoidTerrainProvider) return 0;
      try {
        const positions = [cartographic(lon, lat)];
        const [carto] =
          (await withTimeout(
            provider.availability
              ? Cesium.sampleTerrainMostDetailed(provider, positions)
              : Cesium.sampleTerrain(provider, 14, positions),
            EXACT_SAMPLE_TIMEOUT_MS,
          )) || [];
        if (plausibleGround(carto?.height)) return carto.height;
      } catch {
        // Fall through to a rendered sample.
      }
    }
    return sampleTopDown(lon, lat);
  }

  /** Where the camera is looking: the start point when Me Mode turns on. */
  function cameraTarget(viewer) {
    const scene = viewer.scene;
    const centre = new Cesium.Cartesian2(
      scene.canvas.clientWidth / 2,
      scene.canvas.clientHeight / 2,
    );
    let position;
    // A depth pick is exact on the photoreal tiles (GEV hides the globe while
    // they are shown); over the globe the ellipsoid ray is the safer guess.
    if (scene.pickPositionSupported && !scene.globe?.show) {
      try {
        position = scene.pickPosition(centre);
      } catch {
        position = undefined;
      }
    }
    if (!position) position = viewer.camera.pickEllipsoid(centre);
    const carto = position
      ? Cesium.Cartographic.fromCartesian(position)
      : viewer.camera.positionCartographic;
    // Only the horizontal position is trusted: a depth-buffer pick on a far
    // view can be metres to kilometres off vertically.
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    };
  }

  /**
   * Nearest road via GEV's routing proxy (a zero-length OSRM route).
   * @returns {Promise<{ point: {lon, lat}|null, reason: string }>}
   */
  async function snapToRoad(lon, lat) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ROAD_SNAP_TIMEOUT_MS);
    try {
      const response = await fetch(roadSnapUrl(lon, lat), {
        signal: abort.signal,
      });
      if (!response.ok)
        return { point: null, reason: `routing HTTP ${response.status}` };
      const payload = await response.json();
      const point = parseRoadSnap(payload, lon, lat);
      if (point) return { point, reason: 'road' };
      return {
        point: null,
        reason:
          payload?.ok === true
            ? 'no road within 150 m'
            : `routing: ${payload?.error || 'no answer'}`,
      };
    } catch (error) {
      return {
        point: null,
        reason: abort.signal.aborted
          ? `routing timed out after ${ROAD_SNAP_TIMEOUT_MS / 1000} s`
          : `routing failed: ${error?.message || error}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Nearest street-level point when `lon, lat` is up on a building. */
  function streetLevelCheck(lon, lat) {
    return streetLevelNear(
      sampleTopDown(lon, lat),
      ringAround(lon, lat, STREET_CHECK_RADII, STREET_CHECK_DIRECTIONS).map(
        (point) => ({ ...point, height: sampleTopDown(point.lon, point.lat) }),
      ),
    );
  }

  /**
   * Keep a drop out of buildings. First the nearest road (routing proxy);
   * then, always, a street-level check of the resulting spot on the loaded
   * 3D surface, which also catches a road lookup that failed or answered
   * with a point that is still up on a structure. Logs what it did.
   */
  async function streetSpot(lon, lat) {
    const road = await snapToRoad(lon, lat);
    let spot = road.point ? { ...road.point } : { lon, lat };
    const steps = [];
    if (road.point)
      steps.push(
        `moved ${Math.round(localOffset(lon, lat, spot.lon, spot.lat).distance)} m to road`,
      );
    else steps.push(`no road snap (${road.reason})`);
    const street = streetLevelCheck(spot.lon, spot.lat);
    if (street) {
      steps.push(
        `moved ${Math.round(street.distance)} m off a roof to street level`,
      );
      spot = { lon: street.lon, lat: street.lat };
    }
    console.info(`[Me Mode] Drop: ${steps.join('; ')}`);
    const snapped = street ? 'street-level' : road.point ? 'road' : null;
    return { ...spot, snapped };
  }

  /**
   * Stand the avatar on the ground at a position. Drops (`toStreet`) are
   * moved onto the nearest street first.
   * @returns {Promise<{ grounded: boolean, snapped: string|null }>}
   */
  async function place(lon, lat, { toStreet = false } = {}) {
    const epoch = ++_placeEpoch;
    cancelAutopilot();
    _groundReady = false;
    _flying = false;
    _fallSpeed = 0;
    syncFlyButton();
    if (_model) _model.show = false;
    let snapped = null;
    if (toStreet) {
      const spot = await streetSpot(lon, lat);
      if (epoch !== _placeEpoch || !_viewer)
        return { grounded: false, snapped: null };
      ({ lon, lat, snapped } = spot);
    }
    _lon = lon;
    _lat = lat;
    const exact = await sampleGroundExact(lon, lat);
    if (epoch !== _placeEpoch || !_viewer)
      return { grounded: false, snapped: null };
    // Without an exact sample, read whatever has loaded here now; only as a
    // last resort keep the previous height (the rationed samples correct it,
    // and a jump restarts the smoother window).
    const fallback = Number.isFinite(exact) ? exact : sampleTopDown(lon, lat);
    const height = Number.isFinite(fallback)
      ? fallback
      : (_smoother.value ?? 0);
    _height = height;
    _smoother.reset(height);
    _groundReady = true;
    _lastSampleAt = performance.now();
    if (_model) _model.show = !_firstPerson;
    return { grounded: Number.isFinite(exact), snapped };
  }

  async function loadModel(url) {
    const epoch = ++_modelEpoch;
    const viewer = _viewer;
    _loadAbort?.abort();
    const abort = new AbortController();
    _loadAbort = abort;
    const attempt = async (candidate) => {
      // Fetch and normalize skinned-node placement before Cesium parses it
      // (see glb.js); Cesium misplaces skins under transformed parents.
      const source = await loadAvatarSource(resolveAsset(candidate), {
        signal: abort.signal,
      });
      return Cesium.Model.fromGltfAsync({
        ...source,
        modelMatrix: modelMatrix(),
        minimumPixelSize: 0,
        scale: 1,
        id: 'me-mode-avatar',
        show: false,
      });
    };
    let model;
    try {
      model = await attempt(url);
    } catch (error) {
      if (url !== DEFAULT_AVATAR_URL || abort.signal.aborted) throw error;
      console.info(
        '[Me Mode] No local default avatar; using the pinned CDN copy.',
      );
      model = await attempt(FALLBACK_AVATAR_URL);
    }
    if (epoch !== _modelEpoch || viewer !== _viewer || !_enabled) {
      model.destroy();
      return null;
    }
    viewer.scene.primitives.add(model);
    if (!model.ready)
      await new Promise((resolve, reject) => {
        const settle = (error) => {
          clearTimeout(timer);
          removers.forEach((remove) => remove());
          abort.signal.removeEventListener('abort', onAbort);
          if (!error) return resolve();
          viewer.scene.primitives.remove(model);
          reject(error);
        };
        const onAbort = () => settle(new Error('Avatar load cancelled'));
        const timer = setTimeout(
          () => settle(new Error('Avatar model took too long to load')),
          MODEL_READY_TIMEOUT_MS,
        );
        const removers = [
          model.readyEvent.addEventListener(() => settle()),
          model.errorEvent.addEventListener((error) => settle(error)),
        ];
        abort.signal.addEventListener('abort', onAbort);
      });
    if (epoch !== _modelEpoch || viewer !== _viewer || !_enabled) {
      viewer.scene.primitives.remove(model);
      return null;
    }
    const names = (model.sceneGraph?.components?.animations || []).map(
      (animation) => animation.name,
    );
    const previous = _model;
    _model = model;
    _clips = resolveClipMap(names, _requestedClips);
    _clipName = null;
    model.activeAnimations.animateWhilePaused = true;
    model.show = _groundReady && !_firstPerson;
    if (previous) viewer.scene.primitives.remove(previous);
    console.info('[Me Mode] Avatar loaded', {
      clips: _clips,
      available: names,
    });
    return model;
  }

  function modelMatrix() {
    const position = Cesium.Cartesian3.fromDegrees(
      _lon ?? 0,
      _lat ?? 0,
      _height,
    );
    // Compass heading → Cesium model heading: the model's +X points east at
    // heading 0 and heading turns clockwise.
    const hpr = new Cesium.HeadingPitchRoll(
      _heading - Math.PI / 2 + _headingOffset,
      _flyPitch,
      0,
    );
    return Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr);
  }

  function playClip(role, rate) {
    if (!_model?.ready) return;
    const name = _clips[role];
    _clipRate = rate;
    if (name === _clipName) return;
    _model.activeAnimations.removeAll();
    _clipName = name;
    _clipSeconds = 0;
    if (!name) return;
    _model.activeAnimations.add({
      name,
      loop: Cesium.ModelAnimationLoop.REPEAT,
      // Drive the clip from frame time, not scene time: GEV's clock is not
      // guaranteed to advance.
      animationTime: (duration) => (duration > 0 ? _clipSeconds / duration : 0),
    });
  }

  function stepFlying(dt) {
    const velocity = flyVelocityFromKeys(_keys, _camHeading);
    _speed = velocity.speed;
    if (velocity.heading !== null && !_firstPerson)
      _heading = turnToward(_heading, velocity.heading, TURN_RATE * dt);
    if (_firstPerson) _heading = _camHeading;
    if (_speed > 0) {
      const next = offsetLonLat(
        _lon,
        _lat,
        velocity.east * dt,
        velocity.north * dt,
      );
      _lon = next.lon;
      _lat = next.lat;
    }
    _height = flyHeight(_height, velocity.up, dt, _floor);
    // Cape: superhero lean into the direction of travel. Surf: stand on the
    // board, weight slightly back.
    const lean =
      _flyStyle === 'surf' ? SURF_LEAN : velocity.speed > 0 ? FLY_LEAN : 0;
    _flyClock += dt;
    _flyPitch += (lean - _flyPitch) * (1 - Math.exp(-dt / 0.3));
    playClip('idle', 1);
    _clipSeconds += dt * _clipRate;
  }

  function step(dt) {
    if (_flying) return stepFlying(dt);
    _flyPitch += (0 - _flyPitch) * (1 - Math.exp(-dt / 0.2));
    let velocity = velocityFromKeys(_keys, _camHeading);
    if (!velocity.speed && _autopilot) {
      const offset = localOffset(_lon, _lat, _autopilot.lon, _autopilot.lat);
      if (offset.distance <= ARRIVAL_RADIUS_M) {
        _autopilot.resolve?.(true);
        _autopilot = null;
      } else {
        const speed = Math.min(_autopilot.speed, offset.distance / dt);
        velocity = {
          east: Math.sin(offset.bearing) * speed,
          north: Math.cos(offset.bearing) * speed,
          speed,
          heading: offset.bearing,
        };
      }
    }
    _speed = velocity.speed;
    if (velocity.heading !== null && !_firstPerson)
      _heading = turnToward(_heading, velocity.heading, TURN_RATE * dt);
    if (_firstPerson) _heading = _camHeading;
    if (_speed > 0) {
      const next = offsetLonLat(
        _lon,
        _lat,
        velocity.east * dt,
        velocity.north * dt,
      );
      _lon = next.lon;
      _lat = next.lat;
    }
    const target = _smoother.value;
    if (Number.isFinite(target) && _height - target > 0.5) {
      // Landing from fly mode (or stepping off a ledge): fall, don't snap.
      ({ height: _height, fallSpeed: _fallSpeed } = fallStep(
        _height,
        _fallSpeed,
        target,
        dt,
      ));
    } else if (Number.isFinite(target)) {
      _fallSpeed = 0;
      _height += (target - _height) * (1 - Math.exp(-dt / HEIGHT_EASE_S));
    }
    const role = clipRoleForSpeed(_speed);
    playClip(role, clipRateForSpeed(role, _speed));
    _clipSeconds += dt * _clipRate;
  }

  function updateCamera(viewer) {
    const eyeHeight = _height + EYE_HEIGHT_M;
    Cesium.Cartesian3.fromDegrees(_lon, _lat, eyeHeight, undefined, scratchEye);
    Cesium.Transforms.eastNorthUpToFixedFrame(
      scratchEye,
      undefined,
      scratchMatrix,
    );
    // Keep a third-person camera above the pavement when looking up.
    const range = Math.min(_camRange, _rangeNow);
    const maxPitch =
      _firstPerson || _flying
        ? CAMERA_PITCH_MAX
        : Math.min(CAMERA_PITCH_MAX, Math.asin(Math.min(1, 1.2 / range)));
    const pitch = Math.min(_camPitch, maxPitch);
    const sh = Math.sin(_camHeading);
    const ch = Math.cos(_camHeading);
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);
    Cesium.Matrix4.multiplyByPointAsVector(
      scratchMatrix,
      new Cesium.Cartesian3(sh * cp, ch * cp, sp),
      scratchDirection,
    );
    Cesium.Matrix4.multiplyByPointAsVector(
      scratchMatrix,
      new Cesium.Cartesian3(-sh * sp, -ch * sp, cp),
      scratchUp,
    );
    Cesium.Cartesian3.normalize(scratchDirection, scratchDirection);
    Cesium.Cartesian3.normalize(scratchUp, scratchUp);
    if (_firstPerson) {
      Cesium.Cartesian3.clone(scratchEye, scratchDestination);
    } else {
      Cesium.Cartesian3.multiplyByScalar(
        scratchDirection,
        -range,
        scratchDestination,
      );
      Cesium.Cartesian3.add(scratchEye, scratchDestination, scratchDestination);
    }
    blendEntry(scratchDestination, scratchDirection, scratchUp);
    viewer.camera.setView({
      destination: scratchDestination,
      orientation: { direction: scratchDirection, up: scratchUp },
    });
    _cameraSet = {
      position: Cesium.Cartesian3.clone(viewer.camera.positionWC),
      direction: Cesium.Cartesian3.clone(viewer.camera.directionWC),
    };
  }

  /**
   * Fly from the pre-Me-Mode view down to the follow pose instead of jumping
   * (from a globe view that is thousands of kilometres). Mutates the targets.
   */
  function blendEntry(destination, direction, up) {
    if (!_entryFrom || _entryStartedAt === null) return;
    const from = _entryFrom;
    if (
      Cesium.Cartesian3.distance(from.position, destination) <
      ENTRY_MIN_DISTANCE_M
    ) {
      _entryFrom = null;
      return;
    }
    const t = easeInOut((performance.now() - _entryStartedAt) / ENTRY_MS);
    if (t >= 1) {
      _entryFrom = null;
      return;
    }
    Cesium.Cartesian3.lerp(from.position, destination, t, destination);
    Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.lerp(from.direction, direction, t, direction),
      direction,
    );
    Cesium.Cartesian3.normalize(Cesium.Cartesian3.lerp(from.up, up, t, up), up);
  }

  /** Eye→camera ray: pull the follow camera in front of walls and slopes. */
  function measureOcclusion(now) {
    if (
      _firstPerson ||
      !_cameraSet ||
      now - _lastOcclusionAt < SAMPLE_MOVING_MS
    )
      return;
    _lastOcclusionAt = now;
    const scene = _viewer.scene;
    if (typeof scene.pickFromRay !== 'function') return;
    const eye = Cesium.Cartesian3.fromDegrees(
      _lon,
      _lat,
      _height + EYE_HEIGHT_M,
    );
    const back = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(
        _cameraSet.position,
        eye,
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
    let hitDistance;
    try {
      const hit = scene.pickFromRay(new Cesium.Ray(eye, back), excluded());
      const ellipsoidGlobe =
        !hit?.object &&
        _viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider;
      if (hit?.position && !ellipsoidGlobe)
        hitDistance = Cesium.Cartesian3.distance(eye, hit.position);
    } catch {
      hitDistance = undefined;
    }
    _rangeTarget = unoccludedRange(_camRange, hitDistance);
  }

  /**
   * True when something other than Me Mode moved the camera since the last
   * frame: a search, a POI key, a voice camera tool, Director playback or
   * Cockpit. Me Mode then hands the camera over instead of silently pulling
   * it back.
   */
  function cameraTakenOver(camera) {
    if (!_cameraSet) return null;
    const moved = Cesium.Cartesian3.distance(
      camera.positionWC,
      _cameraSet.position,
    );
    const turned = Cesium.Cartesian3.dot(
      camera.directionWC,
      _cameraSet.direction,
    );
    if (moved <= CAMERA_HANDOFF_M && turned >= CAMERA_HANDOFF_DOT) {
      _takeoverStrikes = 0;
      return null;
    }
    _takeoverStrikes += 1;
    return cameraTakenBy({ moved, strikes: _takeoverStrikes })
      ? { moved, turnedDeg: (Math.acos(clamp(turned, -1, 1)) * 180) / Math.PI }
      : null;
  }

  function handOffCamera(reason) {
    if (_handedOff) return;
    _handedOff = true;
    console.info(`[Me Mode] Ending: ${reason}`);
    if (_dataManager)
      _dataManager.setEnabled('avatar', false, { origin: 'programmatic' });
    else layer.disable(_viewer);
  }

  // Camera and pose mutate in preUpdate (before tiles select) — mutating in
  // preRender makes 3D Tiles refine against a stale view (see cockpit).
  function onPreUpdate() {
    if (!_enabled || _handedOff || !_viewer || _lon === null) return;
    if (isCockpitActive()) {
      handOffCamera('Cockpit took the camera');
      return;
    }
    const takeover = cameraTakenOver(_viewer.camera);
    if (takeover) {
      handOffCamera(
        `the camera was moved elsewhere (${takeover.moved.toFixed(1)} m, ` +
          `${takeover.turnedDeg.toFixed(1)}°)`,
      );
      return;
    }
    const now = performance.now();
    // Clamped so a stalled tab does not teleport, loose enough that a slow
    // GPU still walks at the stated speed.
    const dt = clamp((now - (_lastFrameAt || now)) / 1000, 0, 0.25);
    _lastFrameAt = now;
    // First placement: leave the camera where it is until there is ground to
    // fly down to, then start the entry flight.
    if (_entryFrom && !_groundReady) return;
    if (_entryFrom && _entryStartedAt === null) _entryStartedAt = now;
    if (_groundReady) step(dt);
    if (_model) _model.modelMatrix = modelMatrix();
    _gearShown = _gear?.update({
      feet: Cesium.Cartesian3.fromDegrees(_lon, _lat, _height),
      style: _flying && _groundReady ? _flyStyle : null,
      firstPerson: _firstPerson,
      heading: _heading,
      lean: _flyPitch,
      speedRatio: _speed / FLY_SPEED_MPS,
      time: _flyClock,
    });
    // Obstructions pull the camera in at once; it eases back out after.
    _rangeNow =
      _rangeTarget < _rangeNow
        ? _rangeTarget
        : _rangeNow +
          (_rangeTarget - _rangeNow) * (1 - Math.exp(-dt / RANGE_RECOVER_S));
    updateCamera(_viewer);
  }

  // Sampling is a pick render, so it runs after the frame and is rationed.
  function onPostRender() {
    if (!_enabled || !_groundReady || _lon === null) return;
    const now = performance.now();
    measureOcclusion(now);
    const interval =
      _speed > 0 || _flying || _fallSpeed > 0
        ? SAMPLE_MOVING_MS
        : SAMPLE_IDLE_MS;
    if (now - _lastSampleAt < interval) return;
    _lastSampleAt = now;
    const ground = sampleGround(_lon, _lat);
    if (_flying) {
      // The surface below (ground or roof) is the floor of the flight.
      if (Number.isFinite(ground)) _floor = ground;
    } else _smoother.push(ground);
  }

  function releaseControls(viewer) {
    for (const remove of _removers.splice(0).reverse()) {
      try {
        remove();
      } catch (error) {
        console.warn('[Me Mode] listener cleanup failed', error);
      }
    }
    clearKeys();
    _hint?.remove();
    _hint = null;
    _viewButton = null;
    _flyButton = null;
    _styleButton = null;
    _flying = false;
    _flyPitch = 0;
    if (_pegman) _pegman.hidden = false;
    const controller = viewer?.scene?.screenSpaceCameraController;
    // Cockpit switches the inputs off before announcing itself; never hand
    // them back underneath it.
    if (controller && _savedInputs !== null && !isCockpitActive()) {
      controller.enableInputs = _savedInputs;
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    }
    _savedInputs = null;
    if (controller && _savedCollision !== null)
      controller.enableCollisionDetection = _savedCollision;
    _savedCollision = null;
    render.releaseContinuousRender(RENDER_OWNER);
    document.body?.classList.remove('me-mode');
    window.dispatchEvent(
      new CustomEvent(MODE_EVENT, { detail: { active: false } }),
    );
  }

  /** Ground position under a viewport point (canvas CSS pixels), or null. */
  function groundAtScreen(x, y) {
    const scene = _viewer.scene;
    const point = new Cesium.Cartesian2(x, y);
    let position;
    if (scene.pickPositionSupported && !scene.globe?.show) {
      try {
        position = scene.pickPosition(point);
      } catch {
        position = undefined;
      }
    }
    // Real terrain: pick the globe. The bare-ellipsoid fallback's tile
    // meshes are unreliable, so there the ellipsoid ray below is exact.
    if (
      !position &&
      scene.globe?.show &&
      !(_viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)
    ) {
      const ray = _viewer.camera.getPickRay(point);
      if (ray) position = scene.globe.pick(ray, scene);
    }
    if (!position) position = _viewer.camera.pickEllipsoid(point);
    if (!position) return null;
    const carto = Cesium.Cartographic.fromCartesian(position);
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    };
  }

  /** Drop the avatar at a position: start Me Mode there, or teleport. */
  function dropAt(position) {
    if (!position) return;
    if (_enabled) {
      layer.setPosition(position.lon, position.lat).catch(() => {});
      return;
    }
    _pendingStart?.reject(new Error('Superseded by a newer drop'));
    _pendingStart = {
      lon: position.lon,
      lat: position.lat,
      resolve: () => {},
      reject: () => {},
    };
    if (_dataManager)
      _dataManager.setEnabled('avatar', true, { origin: 'user' });
    else layer.enable(_viewer);
  }

  /**
   * The Pegman: a figure to drag onto the map, Street View style. Dropping it
   * starts Me Mode there (moved onto the nearest street); a click starts at
   * the centre of the view.
   */
  function createPegman(viewer) {
    const container = viewer.container;
    if (!container || !globalThis.document) return;
    _pegman = document.createElement('button');
    _pegman.type = 'button';
    _pegman.className = 'me-mode-pegman';
    _pegman.title = 'Me Mode: drag onto the map to walk there (or click)';
    _pegman.setAttribute('aria-label', 'Me Mode: drop yourself on the map');
    _pegman.innerHTML = PEGMAN_SVG;
    Object.assign(_pegman.style, {
      position: 'absolute',
      right: '24px',
      bottom: '210px',
      width: '44px',
      height: '44px',
      display: 'grid',
      placeItems: 'center',
      padding: '0',
      borderRadius: '50%',
      border: '1px solid rgba(246, 196, 0, 0.6)',
      background: 'rgba(10, 14, 20, 0.82)',
      boxShadow: '0 2px 10px rgba(0, 0, 0, 0.5)',
      cursor: 'grab',
      touchAction: 'none',
      zIndex: '6',
    });
    let drag = null;
    const ghostAt = (x, y) => {
      drag.ghost.style.left = `${x - 13}px`;
      drag.ghost.style.top = `${y - 34}px`;
    };
    const on = (target, type, handler) => {
      target.addEventListener(type, handler);
      _pegmanRemovers.push(() => target.removeEventListener(type, handler));
    };
    on(_pegman, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      try {
        _pegman.setPointerCapture?.(event.pointerId);
      } catch {
        // Synthetic or already-released pointer: the drag still works.
      }
      const ghost = document.createElement('div');
      ghost.className = 'me-mode-pegman-ghost';
      ghost.innerHTML = PEGMAN_SVG;
      Object.assign(ghost.style, {
        position: 'fixed',
        pointerEvents: 'none',
        transform: 'scale(1.5)',
        filter: 'drop-shadow(0 3px 3px rgba(0,0,0,0.6))',
        zIndex: '10000',
        display: 'none',
      });
      document.body.appendChild(ghost);
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        ghost,
        moved: false,
      };
    });
    on(_pegman, 'pointermove', (event) => {
      if (drag?.id !== event.pointerId) return;
      if (
        !drag.moved &&
        Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >
          PEGMAN_DRAG_PX
      ) {
        drag.moved = true;
        drag.ghost.style.display = 'block';
        _pegman.style.cursor = 'grabbing';
      }
      if (drag.moved) ghostAt(event.clientX, event.clientY);
    });
    const finish = (event, cancelled) => {
      if (drag?.id !== event.pointerId) return;
      const { moved, ghost } = drag;
      drag = null;
      ghost.remove();
      _pegman.style.cursor = 'grab';
      if (cancelled) return;
      const canvas = viewer.scene.canvas;
      const rect = canvas.getBoundingClientRect();
      const x = moved ? event.clientX - rect.left : rect.width / 2;
      const y = moved ? event.clientY - rect.top : rect.height / 2;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
      dropAt(groundAtScreen(x, y));
    };
    on(_pegman, 'pointerup', (event) => finish(event, false));
    on(_pegman, 'pointercancel', (event) => finish(event, true));
    // Keyboard: Enter / Space start at the centre of the view.
    on(_pegman, 'keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const rect = viewer.scene.canvas.getBoundingClientRect();
      dropAt(groundAtScreen(rect.width / 2, rect.height / 2));
    });
    container.appendChild(_pegman);
  }

  const layer = {
    id: 'avatar',
    name: 'Me Mode',
    icon: '🚶',
    source: 'Local avatar',
    updateInterval: -1,
    // Entered by dragging the Pegman onto the map, not from the layer list.
    showInTogglePanel: false,

    init(viewer) {
      if (_initialized) throw new Error('Me Mode is already initialized');
      _initialized = true;
      _viewer = viewer;
      if (!_pegman) createPegman(viewer);
    },

    // Nothing to poll: the avatar is driven per frame while enabled.
    async update() {
      return _enabled;
    },

    attachDataManager(dataManager) {
      _dataManager = dataManager;
      // The manager initializes layers lazily on first enable, but the Pegman
      // must be on the map from the start: it is how Me Mode is entered.
      if (!_pegman && dataManager?.viewer) {
        _viewer = dataManager.viewer;
        createPegman(dataManager.viewer);
      }
    },

    async enable(viewer = _viewer, { signal } = {}) {
      _viewer = viewer;
      if (isCockpitActive()) {
        _error = 'Exit Cockpit before starting Me Mode';
        _pendingStart?.reject(new Error(_error));
        _pendingStart = null;
        return false;
      }
      _enabled = true;
      _handedOff = false;
      _cameraSet = null;
      _error = null;
      _lastFrameAt = 0;
      _rangeTarget = _rangeNow = _camRange;
      _entryFrom = {
        position: Cesium.Cartesian3.clone(viewer.camera.positionWC),
        direction: Cesium.Cartesian3.clone(viewer.camera.directionWC),
        up: Cesium.Cartesian3.clone(viewer.camera.upWC),
      };
      _entryStartedAt = null;
      const start = _pendingStart || cameraTarget(viewer);
      const pending = _pendingStart;
      _pendingStart = null;
      _camHeading = normalizeAngle(viewer.camera.heading);
      _camPitch = CAMERA_PITCH_DEFAULT;
      _heading = _camHeading;
      viewer.camera.cancelFlight();
      viewer.trackedEntity = undefined;
      const controller = viewer.scene.screenSpaceCameraController;
      _savedInputs = controller.enableInputs;
      controller.enableInputs = false;
      // Cesium's collision correction runs every frame even with inputs off
      // and would push the follow camera up off the pavement or over a tree
      // (GEV enables tileset collision). Me Mode keeps its own camera clear.
      _savedCollision = controller.enableCollisionDetection;
      controller.enableCollisionDetection = false;
      _takeoverStrikes = 0;
      render.holdContinuousRender(RENDER_OWNER);
      if (_pegman) _pegman.hidden = true;
      document.body?.classList.add('me-mode');
      installInput(viewer);
      showHint(viewer);
      _gear = createFlightGear(Cesium, viewer.scene);
      window.dispatchEvent(
        new CustomEvent(MODE_EVENT, { detail: { active: true } }),
      );
      try {
        const placed = place(start.lon, start.lat, { toStreet: true });
        await loadModel(_modelUrl);
        const { grounded, snapped } = await placed;
        pending?.resolve({ ...layer.getPose(), grounded, snapped });
        if (signal?.aborted || !_enabled) return false;
        return true;
      } catch (error) {
        if (!_enabled) {
          // Turned off mid-load: not a failure worth reporting.
          pending?.reject(error);
          return false;
        }
        console.warn('[Me Mode] Avatar failed to load', error);
        _error = `Avatar model failed to load (${_modelUrl})`;
        pending?.reject(error);
        layer.disable(viewer);
        return false;
      }
    },

    disable(viewer = _viewer) {
      if (!_enabled && !_removers.length) return true;
      _enabled = false;
      _modelEpoch += 1;
      _placeEpoch += 1;
      _loadAbort?.abort();
      _loadAbort = null;
      cancelAutopilot();
      _entryFrom = null;
      releaseControls(viewer);
      _gear?.destroy();
      _gear = null;
      _gearShown = null;
      if (_model && viewer) viewer.scene.primitives.remove(_model);
      _model = null;
      _clipName = null;
      _groundReady = false;
      _cameraSet = null;
      return true;
    },

    destroy(viewer = _viewer) {
      layer.disable(viewer);
      for (const remove of _pegmanRemovers.splice(0)) remove();
      _pegman?.remove();
      _pegman = null;
      _pendingStart?.reject(new Error('Me Mode was destroyed'));
      _pendingStart = null;
      _initialized = false;
      _viewer = null;
      _dataManager = null;
    },

    getStats() {
      return {
        count: _enabled && _model ? 1 : 0,
        lastUpdate: null,
        error: _error,
      };
    },

    /**
     * Switch between the third-person follow camera and first person
     * (eye height, model hidden). Same as the V key and the on-screen button.
     * @param {'first'|'third'} view
     */
    setViewMode(view) {
      setView(view === 'first' ? 'first' : 'third');
      return _firstPerson ? 'first-person' : 'third-person';
    },

    /** Take off (true) or land (false). Same as F and the Fly button. */
    setFlying(flying) {
      setFlying(Boolean(flying));
      return _flying;
    },

    /** Fly style: 'cape' (lean into the flight) or 'surf' (on a board). */
    setFlyStyle(style) {
      setFlyStyle(style);
      return _flyStyle;
    },

    /** True while Me Mode owns the camera. */
    isActive() {
      return _enabled;
    },

    /**
     * Swap the avatar model. Keeps the current pose; applies on next enable
     * when Me Mode is off.
     * @param {string} url
     * @param {{idle?: string, walk?: string, run?: string}} [clipMap]
     * @param {{ headingOffsetDeg?: number }} [options]
     */
    async setModel(url, clipMap = null, { headingOffsetDeg } = {}) {
      _modelUrl = url || DEFAULT_AVATAR_URL;
      _requestedClips = { ...DEFAULT_CLIP_MAP, ...(clipMap || {}) };
      if (Number.isFinite(headingOffsetDeg))
        _headingOffset = (headingOffsetDeg * Math.PI) / 180;
      if (!_enabled) return null;
      return loadModel(_modelUrl);
    },

    /**
     * Teleport the avatar onto the ground at a WGS84 position. While Me Mode
     * is off the position becomes the start point of the next enable, and the
     * returned promise settles once that placement has grounded.
     * @returns {Promise<object>} The grounded pose.
     */
    async setPosition(lon, lat, { toStreet = true } = {}) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat))
        throw new TypeError('Me Mode position needs longitude and latitude');
      if (!_enabled) {
        _pendingStart?.reject(new Error('Superseded by a newer position'));
        return new Promise((resolve, reject) => {
          _pendingStart = { lon, lat, resolve, reject };
        });
      }
      const placed = await place(lon, lat, { toStreet });
      return { ...layer.getPose(), ...placed };
    },

    /**
     * Drop a start point queued by `setPosition` while Me Mode was off (for
     * example when turning it on was refused), so a later manual toggle does
     * not start there.
     */
    cancelPendingStart(reason = 'Me Mode did not start') {
      _pendingStart?.reject(new Error(reason));
      _pendingStart = null;
    },

    /**
     * Walk to a nearby point in a straight line (no building avoidance).
     * Resolves true on arrival, false when interrupted by input or a teleport.
     */
    walkTo(lon, lat, { speed = WALK_SPEED_MPS } = {}) {
      if (!_enabled || _lon === null) return Promise.resolve(false);
      cancelAutopilot();
      return new Promise((resolve) => {
        _autopilot = { lon, lat, speed, resolve };
      });
    },

    /** Distance in metres from the avatar to a point, or null when unplaced. */
    distanceTo(lon, lat) {
      if (!_enabled || _lon === null) return null;
      return localOffset(_lon, _lat, lon, lat).distance;
    },

    /** @returns {{ lon, lat, height, heading, speed, view, enabled }|null} */
    getPose() {
      if (_lon === null) return null;
      return {
        lon: _lon,
        lat: _lat,
        height: _height,
        heading: (_heading * 180) / Math.PI,
        speed: _speed,
        view: _firstPerson ? 'first-person' : 'third-person',
        flying: _flying,
        flyStyle: _flyStyle,
        gear: _gearShown || null,
        enabled: _enabled,
      };
    },

    /** JSON-safe pose for the voice agent's scene context. */
    describeForVoice() {
      if (!_enabled || _lon === null) return { active: false };
      return {
        active: true,
        ...describePose({
          lon: _lon,
          lat: _lat,
          height: _height,
          heading: _heading,
          speed: _speed,
          view: _firstPerson ? 'first-person' : 'third-person',
        }),
      };
    },
  };
  return layer;
}
