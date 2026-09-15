import assert from 'node:assert/strict';
import test from 'node:test';
import { createNdjsonParser } from './ndjson.js';

test('records split across chunks are reassembled in order', () => {
  const seen = [];
  const parser = createNdjsonParser((record) => seen.push(record));
  parser.push('{"type":"start","tiles":2}\n{"type":"ti');
  parser.push('le","i":0,"rows":[[1,2,"a","v",0,0]]}\n');
  parser.push('{"type":"done"}');
  parser.end();
  assert.deepEqual(
    seen.map((record) => record.type),
    ['start', 'tile', 'done'],
  );
  assert.deepEqual(seen[1].rows, [[1, 2, 'a', 'v', 0, 0]]);
});

test('a malformed line is reported and skipped', () => {
  const seen = [];
  const errors = [];
  const parser = createNdjsonParser(
    (record) => seen.push(record),
    (error, line) => errors.push(line),
  );
  parser.push('not json\n{"ok":true}\n\n');
  parser.end();
  assert.deepEqual(seen, [{ ok: true }]);
  assert.deepEqual(errors, ['not json']);
});
