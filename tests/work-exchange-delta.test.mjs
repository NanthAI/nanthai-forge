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
  supportsWorkDelta,
  validateWorkDelta,
  validateChangedRecords,
  applyWorkDelta,
  channelMetadataChanges,
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

test('only post-accept check links inherit validated receipt dependencies; altered acceptance pins do not', async () => {
  const before = seed();
  before.channelMoves.push({
    id: randomUUID(),
    channel: 'main',
    viewId: randomUUID(),
    head,
    previous: null,
    at: 'now',
    status: 'accepted',
    provenance: 'user-declared-local',
  });
  const after = structuredClone(before);
  after.revision++;
  after.channelMoves[0].postAcceptRunId = randomUUID();
  after.channelMoves[0].postAcceptAuditRunId = randomUUID();
  let p = pair(before, after);
  assert.deepEqual(
    [...(await channelMetadataChanges(p.a.root, p.b.root, p.delta.changes, p.read))],
    [recordIdentity('channelMoves', before.channelMoves[0].id)],
  );
  for (const field of ['head', 'viewId', 'at']) {
    const forged = structuredClone(after);
    forged.channelMoves[0][field] =
      field === 'head' ? 'b'.repeat(64) : field === 'viewId' ? randomUUID() : 'changed';
    p = pair(before, forged);
    assert.equal((await channelMetadataChanges(p.a.root, p.b.root, p.delta.changes, p.read)).size, 0, field);
  }
  await assert.rejects(
    channelMetadataChanges(p.a.root, p.b.root, p.delta.changes, async () => Buffer.from('corrupt')),
    e => e.code === 'INVALID_WORK_BACKUP',
  );
});

test('compatible format promotions reuse unchanged validated records; unrelated format changes do not', async () => {
  const { convertWorkTo18 } = await import('../dist/work-intent-converter.js');
  for (const [from, to] of [
    [17, 19],
    [18, 20],
    [21, 23],
    [22, 24],
  ]) {
    const before =
      from % 2 === 0 ? convertWorkTo18({ ...seed(), schema: from - 1 }) : { ...seed(), schema: from };
    before.intents = [];
    const after = { ...before, schema: to, revision: before.revision + 1 };
    const p = pair(before, after);
    assert.equal(supportsWorkDelta(p.a.root, p.b.root), true);
    validateWorkDelta(p.a.root, p.b.root, p.delta, { root: p.a.pin.sha256 });
    assert.equal(
      (await validateChangedRecords(p.a.root, p.b.root, p.delta.changes, p.read, new Set([head]))).validated,
      0,
    );
    assert.equal(supportsWorkDelta(p.b.root, p.a.root), false, 'a downgrade does not inherit interpretation');
  }
  assert.equal(
    supportsWorkDelta(buildWorkRecords(seed()).root, buildWorkRecords({ ...seed(), schema: 19 }).root),
    false,
  );
});

test('publication context pages bounded record reads while source-return keeps its smaller window', async () => {
  const before = seed();
  before.intents = Array.from({ length: 250 }, () => ({
    ...intent(),
    notes: Array.from({ length: 3 }, () => ({ kind: 'comment', text: 'x'.repeat(3000), at: 'now' })),
  }));
  const after = structuredClone(before);
  for (const item of after.intents) item.status = 'completed';
  const p = pair(before, after);
  assert.equal(await workDeltaContext(p.a.root, p.b.root, p.delta, p.read), undefined);
  let calls = 0;
  const options = {
    maxBytes: 8 * 1024 * 1024,
    readMany: async pins => {
      calls++;
      assert(pins.length <= 100);
      assert(pins.reduce((size, pin) => size + pin.size, 0) <= 2 * 1024 * 1024);
      return Promise.all(pins.map(p.read));
    },
  };
  const context = await workDeltaContext(p.a.root, p.b.root, p.delta, p.read, [], new Set(), options);
  assert.deepEqual(context.previous.intents, before.intents);
  assert.deepEqual(context.current.intents, after.intents);
  assert.equal(calls, 6, 'three pages per catalog, rather than one call per record');
  const authenticated = await workDeltaContext(p.a.root, p.b.root, p.delta, p.read, [], new Set(), {
    ...options,
    prefetchOnly: true,
  });
  assert.equal(authenticated.recordsRead, 250);
  assert.deepEqual(authenticated.previous.intents, []);
  assert.deepEqual(authenticated.current.intents, []);
  const corrupt = new Map();
  await workDeltaContext(p.a.root, p.b.root, p.delta, p.read, [], new Set(), {
    ...options,
    prefetchOnly: true,
    readMany: async pins =>
      pins.map(pin => {
        const bytes = Buffer.from('corrupt');
        corrupt.set(pin.sha256, bytes);
        return bytes;
      }),
  });
  await assert.rejects(
    validateChangedRecords(
      p.a.root,
      p.b.root,
      p.delta.changes,
      async pin => corrupt.get(pin.sha256),
      new Set([head]),
    ),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
  await assert.rejects(
    workDeltaContext(p.a.root, p.b.root, p.delta, p.read, [], new Set(), {
      ...options,
      readMany: async pins => pins.map(() => Buffer.from('corrupt')),
    }),
    error => error.code === 'INVALID_WORK_BACKUP',
  );
});
