// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  buildWorkRecords,
  hashWorkRecords,
  recordMap,
  recordIdentity,
} from '../dist/work-exchange-records.js';
import {
  buildWorkDelta,
  validateWorkDelta,
  validateChangedRecords,
  applyWorkDelta,
} from '../dist/work-exchange-delta.js';
import { workSchema } from '../dist/work-types.js';
import { digest } from '../dist/hash.js';
import { workDeltaContext } from '../dist/work-exchange-context.js';
const head = 'a'.repeat(64);
const seed = () =>
  workSchema.parse({ schema: 15, revision: 0, nativeHead: head, intents: [], lanes: [], views: [] });
const intent = () => ({
  id: randomUUID(),
  base: head,
  outcome: 'Synthetic intent',
  constraints: '',
  status: 'active',
  notes: [],
  createdAt: '2026-01-01T00:00:00Z',
});
function pair(before, after) {
  const a = buildWorkRecords(before),
    b = buildWorkRecords(after),
    objects = new Map([...a.objects, ...b.objects]);
  return {
    a,
    b,
    delta: buildWorkDelta(a.root, b.root, a.pin.sha256, 7),
    read: async pin => objects.get(pin.sha256),
  };
}
test('record delta contains add/change/remove only and applies in original order', async () => {
  const before = seed();
  before.intents.push(intent(), intent(), intent());
  const after = structuredClone(before);
  after.revision++;
  after.intents[1].notes.push({ kind: 'comment', text: 'Changed', at: '2026-01-01T01:00:00Z' });
  after.intents.shift();
  after.intents.push(intent());
  const p = pair(before, after);
  assert.equal(p.delta.changes.length, 3);
  assert.ok(!p.delta.changes.some(c => c.key === before.intents[2].id));
  validateWorkDelta(p.a.root, p.b.root, p.delta, { root: p.a.pin.sha256, revision: 7 });
  const changed = await validateChangedRecords(p.a.root, p.b.root, p.delta.changes, p.read, new Set([head]));
  const values = new Map(changed.current.intents.map(i => [recordIdentity('intents', i.id), i]));
  assert.deepEqual(applyWorkDelta(before, p.b.root, values), after);
  assert.equal(changed.validated, 2);
});
test('segmented hashing preserves exact JSON bytes, key order, Unicode and unknown attributes', async () => {
  const data = { ...seed(), extension: { text: 'Snow 雪 and "quotes"\nnew line', list: [1, 2] } };
  data.intents.push({ ...intent(), opaque: { keep: true } });
  const encoded = buildWorkRecords(data);
  const actual = await hashWorkRecords(encoded.root, async pin => encoded.objects.get(pin.sha256));
  assert.deepEqual(actual, {
    sha256: digest(JSON.stringify(data, null, 2)),
    size: Buffer.byteLength(JSON.stringify(data, null, 2)),
  });
});
test('delta rejects stale checkpoint or journal revision and a bad prior hash', () => {
  const before = seed(),
    after = seed();
  after.intents.push(intent());
  const p = pair(before, after);
  assert.throws(
    () => validateWorkDelta(p.a.root, p.b.root, p.delta, { root: 'b'.repeat(64), revision: 7 }),
    e => e.code === 'WORK_STALE',
  );
  assert.throws(
    () => validateWorkDelta(p.a.root, p.b.root, p.delta, { root: p.a.pin.sha256, revision: 8 }),
    e => e.code === 'WORK_STALE',
  );
  const bad = structuredClone(p.delta);
  bad.changes[0].previous = 'c'.repeat(64);
  assert.throws(
    () => validateWorkDelta(p.a.root, p.b.root, bad, { root: p.a.pin.sha256 }),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
});
test('changed records reject dangling references, malformed records and missing State pins', async () => {
  const before = seed(),
    after = seed();
  after.lanes.push({
    id: randomUUID(),
    intentId: randomUUID(),
    name: 'Dangling',
    base: head,
    head,
    assignment: '',
    target: '',
    state: 'active',
    checkpoints: [],
  });
  let p = pair(before, after);
  await assert.rejects(
    () => validateChangedRecords(p.a.root, p.b.root, p.delta.changes, p.read, new Set([head])),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
  after.intents.push(intent());
  after.lanes[0].intentId = after.intents[0].id;
  p = pair(before, after);
  await assert.rejects(
    () => validateChangedRecords(p.a.root, p.b.root, p.delta.changes, p.read, new Set()),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
  after.lanes[0].state = 'invented';
  assert.throws(() => buildWorkRecords(after));
});
test('removal checks inbound references from unchanged retained records', () => {
  const before = seed();
  before.intents.push(intent());
  before.lanes.push({
    id: randomUUID(),
    intentId: before.intents[0].id,
    name: 'Retained',
    base: head,
    head,
    assignment: '',
    target: '',
    state: 'active',
    checkpoints: [],
  });
  const after = structuredClone(before);
  after.intents = [];
  const p = pair(before, after);
  assert.throws(
    () => validateWorkDelta(p.a.root, p.b.root, p.delta, { root: p.a.pin.sha256 }),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
});
test('unknown collections and repeated record identities select the full representation', () => {
  const data = seed();
  data.unknown = [{ id: randomUUID() }];
  assert.equal(buildWorkRecords(data), undefined);
  delete data.unknown;
  const one = intent();
  data.intents.push(one, one);
  assert.equal(buildWorkRecords(data), undefined);
});
test('record hashes and unchanged reference descriptors are independently verified', async () => {
  const before = seed();
  before.intents.push(intent());
  const after = structuredClone(before);
  after.revision++;
  const p = pair(before, after),
    damaged = structuredClone(p.b.root);
  const descriptor = recordMap(damaged).values().next().value.record;
  descriptor.refs.push({ collection: 'lanes', key: randomUUID() });
  assert.throws(
    () => validateWorkDelta(p.a.root, damaged, p.delta, { root: p.a.pin.sha256 }),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
  await assert.rejects(
    () => hashWorkRecords(p.b.root, async () => Buffer.from('corrupt')),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
});
test('large touched contexts select full validation before reading record bodies', async () => {
  const before = seed();
  before.intents.push({
    ...intent(),
    notes: Array.from({ length: 600 }, () => ({
      kind: 'comment',
      text: 'x'.repeat(4000),
      at: '2026-01-01T00:00:00Z',
    })),
  });
  const after = structuredClone(before);
  after.revision++;
  after.intents[0].notes.push({ kind: 'comment', text: 'Next', at: '2026-01-01T01:00:00Z' });
  const p = pair(before, after);
  assert.equal(
    await workDeltaContext(p.a.root, p.b.root, p.delta, async () => {
      throw Error('large optimization context should not load');
    }),
    undefined,
  );
});
test('changed Views resolve their Lane inputs within the same Intent', async () => {
  const before = seed(),
    after = seed();
  after.intents.push(intent(), intent());
  const laneId = randomUUID();
  after.lanes.push({
    id: laneId,
    intentId: after.intents[0].id,
    name: 'Input',
    base: head,
    head,
    assignment: '',
    target: '',
    state: 'active',
    checkpoints: [],
  });
  after.views.push({
    id: randomUUID(),
    intentId: after.intents[1].id,
    base: head,
    head,
    inputs: [{ laneId, head }],
    status: 'clean',
    details: '',
    at: '2026-01-01T00:00:00Z',
  });
  const p = pair(before, after);
  await assert.rejects(
    () => validateChangedRecords(p.a.root, p.b.root, p.delta.changes, p.read, new Set([head])),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
});
