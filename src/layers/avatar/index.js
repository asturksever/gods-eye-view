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
  clamp,
  clipRateForSpeed,
  clipRoleForSpeed,
  describePose,
  localOffset,
  normalizeAngle,
  offsetLonLat,
  parseAvatarParams,
  resolveClipMap,
  turnToward,
  velocityFromKeys,
} from './model.js';
import { loadAvatarSource } from './glb.js';
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
const HINT_TEXT = 'WASD move · Shift run · V view · drag to look · wheel zoom';

const KEY_ROLES = Object.freeze({
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'run',
  ShiftRight: 'run',
});

function isTextTarget(target) {
  return Boolean(
    target?.isContentEditable ||
    target?.closest?.(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    ),
  );
}

/** Ground lies between the Dead Sea shore and Everest's summit. */
function plausibleGround(height) {
  return Number.isFinite(height) && height > -500 && height < 9000;
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
  let _savedInputs = null;

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

  function onKey(event) {
    if (!_enabled || event.isComposing || isTextTarget(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const down = event.type === 'keydown';
    const role = KEY_ROLES[event.code];
    if (role) {
      _keys[role] = down;
      if (down && role !== 'run') _autopilot = null;
    } else if (event.code === 'KeyV') {
      if (down && !event.repeat) setView(_firstPerson ? 'third' : 'first');
    } else {
      return;
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
    _hint.setAttribute('role', 'status');
    _hint.textContent = HINT_TEXT;
    Object.assign(_hint.style, {
      position: 'absolute',
      left: '50%',
      bottom: '28px',
      transform: 'translateX(-50%)',
      padding: '6px 12px',
      borderRadius: '6px',
      background: 'rgba(0, 0, 0, 0.6)',
      color: '#e6f3ff',
      font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.04em',
      pointerEvents: 'none',
      zIndex: '5',
    });
    viewer.container.appendChild(_hint);
  }

  function setView(view) {
    _firstPerson = view === 'first';
    if (_model) _model.show = !_firstPerson && _groundReady;
  }

  function cartographic(lon = _lon, lat = _lat, height = 0) {
    return Cesium.Cartographic.fromDegrees(lon, lat, height);
  }

  function excluded() {
    return _model ? [_model] : [];
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

  /** Cheap per-sample ground read: rendered tiles first, then the globe. */
  function sampleGround(lon, lat) {
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

  /** Exact ground for a placement: waits for the most detailed tiles. */
  async function sampleGroundExact(lon, lat) {
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
    return sampleGround(lon, lat);
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

  async function place(lon, lat) {
    const epoch = ++_placeEpoch;
    _lon = lon;
    _lat = lat;
    _autopilot?.resolve?.(false);
    _autopilot = null;
    _groundReady = false;
    if (_model) _model.show = false;
    const exact = await sampleGroundExact(lon, lat);
    if (epoch !== _placeEpoch || !_viewer) return false;
    // Without an exact sample, start from the last height; the rationed
    // per-frame samples replace it (a jump restarts the smoother window).
    const height = Number.isFinite(exact) ? exact : (_smoother.value ?? 0);
    _height = height;
    _smoother.reset(height);
    _groundReady = true;
    _lastSampleAt = performance.now();
    if (_model) _model.show = !_firstPerson;
    return Number.isFinite(exact);
  }

  async function loadModel(url) {
    const epoch = ++_modelEpoch;
    const viewer = _viewer;
    const attempt = async (candidate) => {
      // Fetch and normalize skinned-node placement before Cesium parses it
      // (see glb.js); Cesium misplaces skins under transformed parents.
      const source = await loadAvatarSource(resolveAsset(candidate));
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
      if (url !== DEFAULT_AVATAR_URL) throw error;
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
        const removers = [
          model.readyEvent.addEventListener(() => {
            removers.forEach((remove) => remove());
            resolve();
          }),
          model.errorEvent.addEventListener((error) => {
            removers.forEach((remove) => remove());
            viewer.scene.primitives.remove(model);
            reject(error);
          }),
        ];
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
      0,
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

  function step(dt) {
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
    if (Number.isFinite(target))
      _height += (target - _height) * (1 - Math.exp(-dt / HEIGHT_EASE_S));
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
    const maxPitch = _firstPerson
      ? CAMERA_PITCH_MAX
      : Math.min(CAMERA_PITCH_MAX, Math.asin(Math.min(1, 1.2 / _camRange)));
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
        -_camRange,
        scratchDestination,
      );
      Cesium.Cartesian3.add(scratchEye, scratchDestination, scratchDestination);
    }
    viewer.camera.setView({
      destination: scratchDestination,
      orientation: { direction: scratchDirection, up: scratchUp },
    });
  }

  // Camera and pose mutate in preUpdate (before tiles select) — mutating in
  // preRender makes 3D Tiles refine against a stale view (see cockpit).
  function onPreUpdate() {
    if (!_enabled || !_viewer || _lon === null) return;
    const now = performance.now();
    // Clamped so a stalled tab does not teleport, loose enough that a slow
    // GPU still walks at the stated speed.
    const dt = clamp((now - (_lastFrameAt || now)) / 1000, 0, 0.25);
    _lastFrameAt = now;
    if (_groundReady) step(dt);
    if (_model) _model.modelMatrix = modelMatrix();
    updateCamera(_viewer);
  }

  // Sampling is a pick render, so it runs after the frame and is rationed.
  function onPostRender() {
    if (!_enabled || !_groundReady || _lon === null) return;
    const now = performance.now();
    const interval = _speed > 0 ? SAMPLE_MOVING_MS : SAMPLE_IDLE_MS;
    if (now - _lastSampleAt < interval) return;
    _lastSampleAt = now;
    _smoother.push(sampleGround(_lon, _lat));
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
    const controller = viewer?.scene?.screenSpaceCameraController;
    if (controller && _savedInputs !== null) {
      controller.enableInputs = _savedInputs;
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    }
    _savedInputs = null;
    render.releaseContinuousRender(RENDER_OWNER);
    document.body?.classList.remove('me-mode');
    window.dispatchEvent(
      new CustomEvent(MODE_EVENT, { detail: { active: false } }),
    );
  }

  const layer = {
    id: 'avatar',
    name: 'Me Mode',
    icon: '🚶',
    source: 'Local avatar',
    updateInterval: -1,

    init(viewer) {
      if (_viewer) throw new Error('Me Mode is already initialized');
      _viewer = viewer;
    },

    // Nothing to poll: the avatar is driven per frame while enabled.
    async update() {
      return _enabled;
    },

    attachDataManager(dataManager) {
      _dataManager = dataManager;
    },

    async enable(viewer = _viewer, { signal } = {}) {
      _viewer = viewer;
      _enabled = true;
      _error = null;
      _lastFrameAt = 0;
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
      render.holdContinuousRender(RENDER_OWNER);
      document.body?.classList.add('me-mode');
      installInput(viewer);
      showHint(viewer);
      window.dispatchEvent(
        new CustomEvent(MODE_EVENT, { detail: { active: true } }),
      );
      try {
        const placed = place(start.lon, start.lat);
        await loadModel(_modelUrl);
        await placed;
        pending?.resolve(layer.getPose());
        if (signal?.aborted || !_enabled) return false;
        return true;
      } catch (error) {
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
      _autopilot?.resolve?.(false);
      _autopilot = null;
      releaseControls(viewer);
      if (_model && viewer) viewer.scene.primitives.remove(_model);
      _model = null;
      _clipName = null;
      _groundReady = false;
      return true;
    },

    destroy(viewer = _viewer) {
      layer.disable(viewer);
      _pendingStart?.reject(new Error('Me Mode was destroyed'));
      _pendingStart = null;
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
    async setPosition(lon, lat) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat))
        throw new TypeError('Me Mode position needs longitude and latitude');
      if (!_enabled) {
        _pendingStart?.reject(new Error('Superseded by a newer position'));
        return new Promise((resolve, reject) => {
          _pendingStart = { lon, lat, resolve, reject };
        });
      }
      const grounded = await place(lon, lat);
      return { ...layer.getPose(), grounded };
    },

    /**
     * Walk to a nearby point in a straight line (no building avoidance).
     * Resolves true on arrival, false when interrupted by input or a teleport.
     */
    walkTo(lon, lat, { speed = WALK_SPEED_MPS } = {}) {
      if (!_enabled || _lon === null) return Promise.resolve(false);
      _autopilot?.resolve?.(false);
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
