import * as Cesium from 'cesium';
import { OBJECTS_3D_BATCH, OBJECTS_3D_LIMIT } from './policy.js';
import { isSignValue } from './values.js';

/**
 * Procedural 3D stand-ins for Mapillary map features. Signs and most street
 * furniture become a pole with the feature's own sprite as a textured face,
 * oriented by Mapillary's `aligned_direction`; a few classes get dedicated
 * shapes. Pure description here; Cesium entities are built by the factory.
 * @param {string} value
 * @returns {{kind: string, faceSize?: number, poleHeight?: number, color?: string}}
 */
export function shapeForValue(value) {
  const text = String(value || '');
  if (isSignValue(text))
    return { kind: 'face', poleHeight: 2.3, faceSize: 0.75 };
  if (text === 'object--fire-hydrant') return { kind: 'hydrant' };
  if (text === 'object--street-light') return { kind: 'streetlight' };
  if (text.startsWith('object--support--')) return { kind: 'pole' };
  if (text === 'object--bench') return { kind: 'bench' };
  if (text === 'object--trash-can') return { kind: 'trashcan' };
  if (text === 'object--traffic-cone') return { kind: 'cone' };
  if (text.startsWith('object--traffic-light--'))
    return { kind: 'trafficlight' };
  if (
    text === 'object--manhole' ||
    text === 'object--catch-basin' ||
    text === 'object--water-valve' ||
    text.startsWith('marking--') ||
    text.startsWith('construction--flat--')
  )
    return {
      kind: 'disc',
      color: text.startsWith('marking--') ? '#f2f2f2' : '#3a3f45',
    };
  return { kind: 'face', poleHeight: 1.4, faceSize: 0.6 };
}

/** Kinds whose orientation follows the feature's aligned direction. */
const ORIENTED_KINDS = new Set(['face', 'bench', 'trafficlight']);

function css(color) {
  return Cesium.Color.fromCssColorString(color);
}

/** Offset a position by metres in the local east/north/up frame. */
function offset(position, east, north, up) {
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  return Cesium.Matrix4.multiplyByPoint(
    frame,
    new Cesium.Cartesian3(east, north, up),
    new Cesium.Cartesian3(),
  );
}

function headingQuaternion(position, headingDeg) {
  return Cesium.Transforms.headingPitchRollQuaternion(
    position,
    new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(headingDeg || 0), 0, 0),
  );
}

/** Rasterize a sprite SVG onto a square transparent canvas for a sign face. */
function faceTexture(svgText, size = 256) {
  const sized = svgText.replace(
    /<svg\b([^>]*)>/i,
    (match, attributes) =>
      `<svg${attributes
        .replace(/\swidth="[^"]*"/i, '')
        .replace(/\sheight="[^"]*"/i, '')} width="${size}" height="${size}">`,
  );
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      resolve(canvas);
    };
    image.onerror = () => resolve(null);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  });
}

/** Build and own the 3D object entities for the current query result. */
export function createObjects3d({ state, source, parts }) {
  const { render } = state.services;
  let dataSource = null;
  let generation = 0;
  /** @type {Map<string, Promise<HTMLCanvasElement|null>>} */
  const textures = new Map();

  function requestRender() {
    render?.governorRequestRender?.('mapillary-objects3d');
  }

  function notify() {
    state.notify?.();
  }

  function ensureDataSource() {
    if (!dataSource && state.viewer) {
      dataSource = new Cesium.CustomDataSource('mapillary-objects');
      state.viewer.dataSources.add(dataSource);
    }
    return dataSource;
  }

  function texture(value) {
    let pending = textures.get(value);
    if (!pending) {
      pending = parts.features
        .spriteSvg(value)
        .then((svg) => (svg ? faceTexture(svg) : null))
        .catch(() => null);
      textures.set(value, pending);
    }
    return pending;
  }

  async function groundHeights(rows) {
    const scene = state.viewer.scene;
    const cartos = rows.map(([lon, lat]) =>
      Cesium.Cartographic.fromDegrees(lon, lat),
    );
    let sampled = null;
    try {
      if (scene.sampleHeightSupported && scene.sampleHeightMostDetailed)
        sampled = await scene.sampleHeightMostDetailed(cartos);
    } catch {
      sampled = null;
    }
    return cartos.map((carto, index) => {
      const fromScene = sampled?.[index]?.height;
      if (Number.isFinite(fromScene)) return fromScene;
      const fromGlobe = scene.globe?.getHeight?.(carto);
      return Number.isFinite(fromGlobe) ? fromGlobe : 0;
    });
  }

  function addShape(entities, row, ground, textureCanvas) {
    const [lon, lat, id, value] = row;
    const shape = shapeForValue(value);
    const base = Cesium.Cartesian3.fromDegrees(lon, lat, ground);
    const at = (up) => Cesium.Cartesian3.fromDegrees(lon, lat, ground + up);
    const pickId = `mly:obj:${id}`;
    const created = [];
    const add = (options) => {
      const entity = entities.add({ ...options, name: value });
      entity.addProperty('mlyFeatureId');
      entity.mlyFeatureId = id;
      created.push(entity);
      return entity;
    };
    const grey = css('#5b6168');
    switch (shape.kind) {
      case 'hydrant':
        add({
          id: `${pickId}:body`,
          position: at(0.38),
          cylinder: {
            length: 0.76,
            topRadius: 0.13,
            bottomRadius: 0.15,
            material: css('#d0312d'),
          },
        });
        add({
          id: `${pickId}:cap`,
          position: at(0.82),
          ellipsoid: {
            radii: new Cesium.Cartesian3(0.15, 0.15, 0.1),
            material: css('#d0312d'),
          },
        });
        break;
      case 'streetlight':
        add({
          id: `${pickId}:pole`,
          position: at(4),
          cylinder: {
            length: 8,
            topRadius: 0.06,
            bottomRadius: 0.1,
            material: grey,
          },
        });
        add({
          id: `${pickId}:lamp`,
          position: at(8.1),
          ellipsoid: {
            radii: new Cesium.Cartesian3(0.28, 0.28, 0.16),
            material: css('#ffd54f'),
          },
        });
        break;
      case 'pole':
        add({
          id: `${pickId}:pole`,
          position: at(4.5),
          cylinder: {
            length: 9,
            topRadius: 0.12,
            bottomRadius: 0.16,
            material: css('#7a5a3a'),
          },
        });
        break;
      case 'bench':
        add({
          id: `${pickId}:seat`,
          position: at(0.3),
          orientation: headingQuaternion(base, 0),
          box: {
            dimensions: new Cesium.Cartesian3(1.6, 0.5, 0.45),
            material: css('#8b6b45'),
          },
        });
        break;
      case 'trashcan':
        add({
          id: `${pickId}:bin`,
          position: at(0.45),
          cylinder: {
            length: 0.9,
            topRadius: 0.28,
            bottomRadius: 0.26,
            material: css('#2f4f3f'),
          },
        });
        break;
      case 'cone':
        add({
          id: `${pickId}:cone`,
          position: at(0.35),
          cylinder: {
            length: 0.7,
            topRadius: 0.04,
            bottomRadius: 0.18,
            material: css('#ff7f11'),
          },
        });
        break;
      case 'trafficlight': {
        add({
          id: `${pickId}:pole`,
          position: at(2.2),
          cylinder: {
            length: 4.4,
            topRadius: 0.07,
            bottomRadius: 0.09,
            material: grey,
          },
        });
        add({
          id: `${pickId}:head`,
          position: at(4.2),
          orientation: headingQuaternion(base, 0),
          box: {
            dimensions: new Cesium.Cartesian3(0.32, 0.28, 0.95),
            material: css('#1f2226'),
          },
        });
        const lights = [
          ['#ff3b30', 0.3],
          ['#ffcc00', 0],
          ['#34c759', -0.3],
        ];
        for (const [color, up] of lights)
          add({
            id: `${pickId}:light${up}`,
            position: offset(at(4.2 + up), 0, -0.15, 0),
            ellipsoid: {
              radii: new Cesium.Cartesian3(0.09, 0.05, 0.09),
              material: css(color),
            },
          });
        break;
      }
      case 'disc':
        add({
          id: `${pickId}:disc`,
          position: at(0.04),
          ellipse: {
            semiMajorAxis: 0.45,
            semiMinorAxis: 0.45,
            height: ground + 0.04,
            material: css(shape.color).withAlpha(0.9),
          },
        });
        break;
      default: {
        const poleHeight = shape.poleHeight || 1.5;
        const faceSize = shape.faceSize || 0.6;
        add({
          id: `${pickId}:pole`,
          position: at(poleHeight / 2),
          cylinder: {
            length: poleHeight,
            topRadius: 0.035,
            bottomRadius: 0.045,
            material: grey,
          },
        });
        add({
          id: `${pickId}:face`,
          position: at(poleHeight - faceSize / 2 + 0.05),
          orientation: headingQuaternion(base, 0),
          plane: {
            plane: new Cesium.Plane(Cesium.Cartesian3.UNIT_Y, 0),
            dimensions: new Cesium.Cartesian2(faceSize, faceSize),
            material: textureCanvas
              ? new Cesium.ImageMaterialProperty({
                  image: textureCanvas,
                  transparent: true,
                })
              : css('#e8eaed'),
          },
        });
      }
    }
    return { created, oriented: ORIENTED_KINDS.has(shape.kind), base };
  }

  /** Orient entities that follow aligned_direction once the batch answers arrive. */
  async function applyDirections(oriented, gen, signal) {
    const ids = [...oriented.keys()];
    for (let i = 0; i < ids.length; i += OBJECTS_3D_BATCH) {
      if (gen !== generation || signal.aborted) return;
      const chunk = ids.slice(i, i + OBJECTS_3D_BATCH);
      let payload = {};
      try {
        payload = await source.getMapFeaturesBatch(chunk, { signal });
      } catch {
        continue;
      }
      if (gen !== generation) return;
      for (const id of chunk) {
        const heading = Number(payload?.[id]?.aligned_direction);
        if (!Number.isFinite(heading)) continue;
        const target = oriented.get(id);
        const quaternion = headingQuaternion(target.base, heading);
        for (const entity of target.entities)
          if (entity.orientation) entity.orientation = quaternion;
      }
      requestRender();
    }
  }

  /** Rebuild the 3D scene from the current rows (no-op while disabled). */
  async function rebuild() {
    clear();
    const objects = state.objects3d;
    if (!objects.enabled || !state.viewer) return;
    const rows = state.features.rows;
    if (!rows.length) {
      objects.active = false;
      objects.error = null;
      notify();
      return;
    }
    if (rows.length > OBJECTS_3D_LIMIT) {
      objects.active = false;
      objects.error = `3D objects render up to ${OBJECTS_3D_LIMIT.toLocaleString()} results (${rows.length.toLocaleString()} here) — zoom in or narrow the query.`;
      notify();
      return;
    }
    const gen = ++generation;
    const controller = new AbortController();
    objects.abort = controller;
    objects.building = true;
    objects.error = null;
    notify();
    try {
      const values = [...new Set(rows.map((row) => row[3]))];
      const [heights, textureList] = await Promise.all([
        groundHeights(rows),
        Promise.all(values.map((value) => texture(value))),
      ]);
      if (gen !== generation) return;
      const textureByValue = new Map(
        values.map((value, index) => [value, textureList[index]]),
      );
      const entities = ensureDataSource().entities;
      entities.suspendEvents();
      const oriented = new Map();
      rows.forEach((row, index) => {
        const result = addShape(
          entities,
          row,
          heights[index],
          textureByValue.get(row[3]),
        );
        if (result.oriented)
          oriented.set(row[2], { entities: result.created, base: result.base });
      });
      entities.resumeEvents();
      objects.count = rows.length;
      objects.active = true;
      parts.features.setIconsHidden(true);
      requestRender();
      notify();
      await applyDirections(oriented, gen, controller.signal);
    } catch (error) {
      if (gen === generation)
        objects.error = error?.message || '3D objects failed';
    } finally {
      if (gen === generation) {
        objects.building = false;
        objects.abort = null;
        notify();
      }
    }
  }

  function clear() {
    generation++;
    state.objects3d.abort?.abort();
    state.objects3d.abort = null;
    dataSource?.entities.removeAll();
    state.objects3d.active = false;
    state.objects3d.count = 0;
    state.objects3d.building = false;
    parts.features.setIconsHidden(false);
    requestRender();
  }

  function setEnabled(enabled) {
    state.objects3d.enabled = enabled === true;
    if (state.objects3d.enabled) rebuild();
    else {
      clear();
      state.objects3d.error = null;
      notify();
    }
  }

  function destroy(viewer) {
    clear();
    if (dataSource) {
      viewer?.dataSources?.remove(dataSource, true);
      dataSource = null;
    }
  }

  return { setEnabled, rebuild, clear, destroy };
}
