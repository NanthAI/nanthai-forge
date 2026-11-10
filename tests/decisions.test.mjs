// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideInputSchema } from '../dist/decision-types.js';

test('prepared Phase 5 decisions are ten unique project record requests and remain unapplied', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/phase5-owner-decisions.json', 'utf8'));
  assert.equal(fixture.records.length, 10);
  assert.equal(new Set(fixture.records.map(record => record.operationId)).size, 10);
  for (const record of fixture.records) {
    assert.equal(record.action, 'decide');
    assert.deepEqual(decideInputSchema.parse(record).target, { kind: 'project' });
    assert.equal(record.decidedBy, 'Owner');
    assert.ok(record.why);
    if (record.overrides) assert.ok(record.overrides.description);
  }
  assert.match(fixture.records[9].what, /7-day/);
});
