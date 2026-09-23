import assert from 'node:assert/strict';
import test from 'node:test';
import { shapeForValue } from './objects3d.js';

test('signs and unknown furniture become sprite faces on a pole', () => {
  assert.deepEqual(shapeForValue('regulatory--stop--g1'), {
    kind: 'face',
    poleHeight: 2.3,
    faceSize: 0.75,
  });
  assert.equal(shapeForValue('object--mailbox').kind, 'face');
  assert.equal(shapeForValue('object--mailbox').poleHeight, 1.4);
});

test('dedicated shapes exist for the common street objects', () => {
  assert.equal(shapeForValue('object--fire-hydrant').kind, 'hydrant');
  assert.equal(shapeForValue('object--street-light').kind, 'streetlight');
  assert.equal(shapeForValue('object--support--utility-pole').kind, 'pole');
  assert.equal(shapeForValue('object--bench').kind, 'bench');
  assert.equal(
    shapeForValue('object--traffic-light--general-upright').kind,
    'trafficlight',
  );
  assert.equal(shapeForValue('object--manhole').kind, 'disc');
  assert.equal(shapeForValue('marking--discrete--stop-line').color, '#f2f2f2');
});
