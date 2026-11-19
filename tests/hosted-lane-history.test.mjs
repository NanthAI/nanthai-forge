// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs } from './convex-args.mjs';

const api = await import(moduleUrl('../convex/projectHostedLaneHistory.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const { hostedRecordValue } = await import(moduleUrl('../src/hosted-records.ts'));
const hex = c => c.repeat(64);

/** Indexed point reads only; no scan, no write. Counts the queries and documents read. */
function fixture() {
  const tables = Object.fromEntries(Object.keys(schema.tables).map(table => [table, []]));
  const meter = { queries: 0, gets: 0 };
  tables.hostedProjects.push({ _id: 'project', _creationTime: 0, owner: 'owner', visibility: 'public' });
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    db: {
      get: async key => {
        meter.gets++;
        for (const rows of Object.values(tables)) {
          const found = rows.find(row => row._id === key);
          if (found) return structuredClone(found);
        }
        return null;
      },
      query: table => {
        meter.queries++;
        let selected = [];
        const q = {
          withIndex(index, build) {
            const spec = schema.tables[table].export().indexes.find(row => row.indexDescriptor === index);
            assert(spec, `${table}.${index} is a real index`);
            let equality = 0;
            const predicates = [];
            const bounds = {
              eq(key, value) {
                assert.equal(key, spec.fields[equality++]);
                predicates.push(row => row[key] === value);
                return bounds;
              },
              // A range only on the next index field after the equalities.
              gte(key, value) {
                assert.equal(key, spec.fields[equality]);
                predicates.push(row => row[key] >= value);
                return bounds;
              },
              lt(key, value) {
                assert.equal(key, spec.fields[equality]);
                predicates.push(row => row[key] < value);
                return bounds;
              },
            };
            build(bounds);
            selected = tables[table].filter(row => predicates.every(p => p(row)));
            return q;
          },
          async take(n) {
            meter.gets += Math.min(n, selected.length);
            return structuredClone(selected.sort((x, y) => (x.key < y.key ? -1 : 1)).slice(0, n));
          },
          async unique() {
            assert(selected.length <= 1);
            return structuredClone(selected[0] ?? null);
          },
        };
        return q;
      },
    },
  };
  const laneId = randomUUID(),
    intentId = randomUUID();
  /** Write one immutable Lane version the way the record store does; the last one is the head. */
  const version = (n, { at, base, head = hex('c'), state = 'active' }) => {
    const { value, ref } = hostedRecordValue({
      kind: 'lane',
      id: laneId,
      version: n,
      at,
      intentId,
      actor: 'someone',
      base,
      head,
      sourceVersion: n,
      lifecycleVersion: 0,
      state,
      authorityEpoch: 0,
    });
    tables.projectHostedRecordBodies.push({
      _id: `body-${n}`,
      _creationTime: 0,
      projectId: 'project',
      value,
    });
    const row = {
      _id: `record-${n}`,
      _creationTime: n,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: intentId,
      status: state,
      version: n,
      bodyId: `body-${n}`,
      digest: ref.digest,
      bytes: ref.bytes,
    };
    tables.projectHostedRecords.push(row);
    tables.projectHostedRecordHeads = tables.projectHostedRecordHeads.filter(h => h.key !== laneId);
    tables.projectHostedRecordHeads.push({
      _id: 'head',
      _creationTime: 0,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: intentId,
      status: state,
      version: n,
      recordId: row._id,
    });
  };
  const read = async (id = laneId) => {
    const args = { projectId: 'project', laneId: id };
    checkArgs(api.read, args, 'projectHostedLaneHistory:read');
    return JSON.parse(await api.read._handler(ctx, args));
  };
  const resolve = async prefix => {
    const args = { projectId: 'project', prefix };
    checkArgs(api.resolveLaneId, args, 'projectHostedLaneHistory:resolveLaneId');
    return JSON.parse(await api.resolveLaneId._handler(ctx, args));
  };
  return { tables, meter, read, resolve, version, laneId, intentId, ctx };
}
const main = (c, r) => ({ head: hex(c), receiptId: r });

test('lane history: open time, start and last synced base, landing stamp, from stored rows', async () => {
  const f = fixture();
  f.version(0, { at: '2026-11-06T10:00:00.000Z', base: main('a', 'R1') });
  f.version(1, { at: '2026-11-06T10:30:00.000Z', base: main('a', 'R1'), head: hex('d') });
  f.version(2, { at: '2026-11-06T11:00:00.000Z', base: main('b', 'R7'), head: hex('e') });
  f.tables.projectHostedOverlapLanes.push({
    _id: 'overlap',
    _creationTime: 0,
    projectId: 'project',
    laneId: f.laneId,
    landed: { receiptId: 'R8', commit: hex('f'), laneHead: hex('e'), at: '2026-11-06T11:20:00.000Z' },
  });
  const queries = f.meter.queries;
  const history = await f.read();
  assert.equal(history.openedAt, '2026-11-06T10:00:00.000Z');
  assert.deepEqual(history.startBase, main('a', 'R1'));
  assert.deepEqual(history.lastSyncedBase, main('b', 'R7'));
  assert.equal(history.synced, true);
  assert.equal(history.lastActivityAt, '2026-11-06T11:00:00.000Z');
  assert.deepEqual(history.landing, {
    receiptId: 'R8',
    commit: hex('f'),
    head: hex('e'),
    at: '2026-11-06T11:20:00.000Z',
    current: true,
  });
  assert.equal(history.intentId, f.intentId);
  // Indexed point reads only: record head, lifecycle pointer, first record, overlap row.
  assert(f.meter.queries - queries <= 6, `queries ${f.meter.queries - queries}`);
});

test('lane history: never-synced, never-landed and a version-0 Lane; unknown Lane is NOT_FOUND', async () => {
  const f = fixture();
  f.version(0, { at: '2026-11-06T10:00:00.000Z', base: main('a', 'R1'), state: 'abandoned' });
  const history = await f.read();
  assert.equal(history.synced, false);
  assert.equal(history.landing, null);
  assert.equal(history.state, 'abandoned');
  assert.equal(history.openedAt, history.lastActivityAt);
  await assert.rejects(f.read(randomUUID()), e => e.data?.code === 'NOT_FOUND');
});

test('ad80e037: a short Lane id resolves from the record heads by one bounded range read, for any Lane of the project', async () => {
  const f = fixture();
  f.version(0, { at: '2026-11-19T10:00:00.000Z', base: main('a', 'R1') });
  const head = (key, kind = 'lane', projectId = 'project') =>
    f.tables.projectHostedRecordHeads.push({
      _id: `h-${key}-${kind}`,
      _creationTime: 0,
      projectId,
      kind,
      key,
    });
  head('b0000000-0000-4000-8000-000000000001');
  head('b0000000-0000-4000-8000-000000000002');
  head('c0000000-0000-4000-8000-000000000001', 'intent');
  head('d0000000-0000-4000-8000-000000000001', 'lane', 'other-project');
  const queries = f.meter.queries;
  assert.deepEqual(await f.resolve(f.laneId.slice(0, 8)), { ids: [f.laneId], more: false });
  assert.equal(f.meter.queries - queries, 1, 'one indexed range read');
  assert.deepEqual((await f.resolve('b0000000')).ids.length, 2, 'ambiguous: both candidates');
  assert.deepEqual(await f.resolve('c0000000'), { ids: [], more: false }, 'only Lanes, not other records');
  assert.deepEqual(await f.resolve('d0000000'), { ids: [], more: false }, 'only this project');
  for (let i = 3; i <= 8; i++) head(`b0000000-0000-4000-8000-00000000000${i}`);
  assert.deepEqual(await f.resolve('b0000000'), {
    ids: [1, 2, 3, 4, 5].map(i => `b0000000-0000-4000-8000-00000000000${i}`),
    more: true,
  });
  await assert.rejects(f.resolve('b000'), e => e.data?.code === 'BAD_ARGUMENT', 'too short');
  await assert.rejects(f.resolve('B0000000'), e => e.data?.code === 'BAD_ARGUMENT', 'lowercase only');
});
