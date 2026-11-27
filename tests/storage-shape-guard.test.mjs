// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { storageShapeCandidates, storageShapeFindings } from '../scripts/check-storage-shapes.mjs';

const file = 'convex/work.ts';
const shape = `const stored = v.union(
  v.object({ format: v.literal(1), text: v.string() }),
  v.object({ format: v.literal(2), body: v.string() }),
);`;
const reader = 'function readLegacyItem(row: { text: string }) { return row.text; }';
const dispatch = 'const load = row => row.formatVersion === 1 ? fromV1(row) : fromV2(row);';

test('the storage shape guard requires dates for a second shape and compatibility readers', () => {
  const findings = storageShapeFindings(file, [shape, reader, dispatch].join('\n'), {});
  assert.deepEqual(
    findings.map(line => line.split(': ')[1]),
    [
      'competing record shapes needs a nearby @remove-after YYYY-MM-DD line.',
      'compatibility reader needs a nearby @remove-after YYYY-MM-DD line.',
      'compatibility dispatch needs a nearby @remove-after YYYY-MM-DD line.',
    ],
  );
  const dated = [shape, reader, dispatch].map(code => '// @remove-after 2027-01-15\n' + code).join('\n');
  assert.deepEqual(storageShapeFindings(file, dated, {}), []);
  assert.equal(storageShapeFindings(file, '// @remove-after 2027-02-30\n' + reader, {}).length, 1);
});

test('the storage shape guard permits domain variants and only the original count of a known shape', () => {
  const domain = `const change = v.union(
    v.object({ kind: v.literal('text'), id: v.string(), text: v.string() }),
    v.object({ kind: v.literal('link'), id: v.string(), url: v.string() }),
  );`;
  const [known] = storageShapeCandidates(file, shape);
  const baseline = { [file]: { [known.key]: 1 } };
  assert.deepEqual(storageShapeFindings(file, domain, {}), []);
  assert.deepEqual(storageShapeFindings(file, shape, baseline), []);
  assert.equal(storageShapeFindings(file, shape.repeat(2), baseline).length, 1);
  assert.equal(storageShapeFindings('convex/copy.ts', shape, baseline).length, 1);
});

test('retiring a shape also retires its exception so the old shape cannot return undated', () => {
  const [known] = storageShapeCandidates(file, shape);
  const baseline = { [file]: { [known.key]: 1 } };
  assert.match(storageShapeFindings(file, '', baseline).join('\n'), /unused storage shape baseline/);
  assert.deepEqual(storageShapeFindings(file, '', {}), []);
  assert.match(storageShapeFindings(file, shape, {}).join('\n'), /needs a nearby @remove-after/);
});
