import assert from 'node:assert/strict';
import test from 'node:test';
import {
  categoryOf,
  groupCountsByLabel,
  colorForValue,
  createValueMatcher,
  humanizeValue,
  isSignValue,
  normalizeValuePattern,
} from './values.js';

test('normalizeValuePattern folds case, spaces and stray characters', () => {
  assert.equal(
    normalizeValuePattern(' Object--Fire Hydrant '),
    'object--fire-hydrant',
  );
  assert.equal(
    normalizeValuePattern('regulatory--stop--*'),
    'regulatory--stop--*',
  );
  assert.equal(normalizeValuePattern('drop table;'), 'drop-table');
  assert.equal(normalizeValuePattern(null), '');
});

test('createValueMatcher matches exact values and wildcards only', () => {
  const matches = createValueMatcher([
    'object--fire-hydrant',
    'regulatory--stop--*',
  ]);
  assert.equal(matches('object--fire-hydrant'), true);
  assert.equal(matches('regulatory--stop--g1'), true);
  assert.equal(matches('regulatory--stop--g3'), true);
  assert.equal(matches('regulatory--stop-ahead--g1'), false);
  assert.equal(matches('object--bench'), false);
  assert.equal(matches(undefined), false);
});

test('an empty pattern list matches everything', () => {
  const matches = createValueMatcher([]);
  assert.equal(matches('anything--at-all'), true);
});

test('a wildcard only spans the segment it is placed in', () => {
  const matches = createValueMatcher(['object--sign--*']);
  assert.equal(matches('object--sign--store'), true);
  assert.equal(matches('object--signal'), false);
  // Regex metacharacters are stripped by normalization, never interpreted.
  assert.equal(
    createValueMatcher(['object--sign.*'])('object--sign--store'),
    true,
  );
});

test('isSignValue and categoryOf split the taxonomy by family', () => {
  assert.equal(isSignValue('regulatory--stop--g1'), true);
  assert.equal(isSignValue('warning--pedestrians-crossing--g4'), true);
  assert.equal(isSignValue('object--fire-hydrant'), false);
  assert.equal(categoryOf('object--fire-hydrant'), 'object');
  assert.equal(categoryOf('marking--discrete--stop-line'), 'marking');
  assert.equal(categoryOf('information--general-directions--g1'), 'sign');
});

test('humanizeValue produces readable labels', () => {
  assert.equal(humanizeValue('object--fire-hydrant'), 'Fire hydrant');
  assert.equal(humanizeValue('regulatory--stop--g1'), 'Stop (regulatory)');
  assert.equal(
    humanizeValue('object--traffic-light--general-upright'),
    'Traffic light · General upright',
  );
  assert.equal(humanizeValue(''), 'Unknown');
});

test('colorForValue is stable and category-shifted', () => {
  assert.equal(colorForValue('object--bench'), colorForValue('object--bench'));
  assert.match(colorForValue('regulatory--stop--g1'), /^hsl\(\d+ 90% 60%\)$/);
});

test('groupCountsByLabel merges regional sign variants under one label', () => {
  const groups = groupCountsByLabel([
    ['regulatory--stop--g1', 100],
    ['object--bench', 30],
    ['regulatory--stop--g3', 5],
  ]);
  assert.deepEqual(
    groups.map(({ label, count, values }) => ({ label, count, values })),
    [
      {
        label: 'Stop (regulatory)',
        count: 105,
        values: ['regulatory--stop--g1', 'regulatory--stop--g3'],
      },
      { label: 'Bench', count: 30, values: ['object--bench'] },
    ],
  );
});
