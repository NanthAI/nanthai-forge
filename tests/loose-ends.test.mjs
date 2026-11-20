// SPDX-License-Identifier: Apache-2.0
// Item fc1831eb: one compact read of loose ends. Dormant Lanes and Lanes quiet for over 90 minutes are listed oldest
// first from presence rows (no per-Lane reads); groups with no data yet say "not reported" with the reason; only the
// owner gets the authority to set Lanes aside; another account cannot read it. The page words each set-aside result,
// and only a failed call is retried.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';
import { meterReads } from './hosted-read-set.mjs';
const { digest } = await import(moduleUrl('../src/state/hash.ts'));

const loose = await import(moduleUrl('../convex/projectLooseEnds.ts'));
const { looseEndsView, setAsideWord } = await import(moduleUrl('../web/src/app/needs/loose-ends.ts'));
const { liveLanes } = await import('../dist/hosted-live-lanes.js');
const day = 24 * 60 * 60 * 1000;
/** A Lane record as the server keeps it (shape of a real resolution Lane), with its origin when it resolves one. */
const laneRecord = (laneId, origin) =>
  JSON.stringify({
    schema: 2,
    projectId: 'project',
    laneId,
    intentId: 'intent-dormant',
    head: 'a'.repeat(64),
    version: 3,
    sourceVersion: 3,
    lifecycleVersion: 0,
    state: 'active',
    authorship: { kind: 'agent' },
    agentClient: 'claude-code:synthetic-model',
    agentRun: 'quiet-otter',
    base: { head: 'b'.repeat(64), receiptId: '00000000-0000-4000-8000-000000000001' },
    authority: { mode: 'server', epoch: 1 },
    at: new Date().toISOString(),
    ...(origin
      ? {
          resolution: {
            origin: { laneId: origin, head: 'c'.repeat(64), sourceVersion: 6 },
            left: 'c'.repeat(64),
            right: 'd'.repeat(64),
            status: 'resolved',
          },
        }
      : {}),
  });

function fixture() {
  const s = state([]);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project' }));
  const now = Date.now();
  const lanes = [
    ['dormant-old', now - 9 * day, 'Try streaming decoder'],
    ['dormant', now - 3 * day, 'Fix flaky retry timer'],
    ['quiet', now - 3 * 60 * 60 * 1000, 'Docs: migration guide'],
    ['busy', now - 5 * 60 * 1000, 'Working right now'],
  ];
  for (const [laneId, at, goal] of lanes)
    s.tables.projectHostedPresence.set(`presence-${laneId}`, {
      _id: `presence-${laneId}`,
      _creationTime: 1,
      projectId: 'project',
      laneId,
      intentId: `intent-${laneId}`,
      actor: 'owner',
      agent: 'quiet-otter',
      goal,
      paths: ['src/a.ts'],
      pathCount: 1,
      at,
    });
  return s;
}
const read = async (s, subject, args = {}) => {
  s.ctx.auth.getUserIdentity = async () => ({ subject });
  return JSON.parse(await loose.read._handler(s.ctx, { projectId: 'project', ...args }));
};

test('one read lists dormant and quiet Lanes oldest first and names the groups it cannot report yet', async () => {
  const s = fixture();
  const result = await read(s, 'owner');
  assert.deepEqual(
    result.groups.idle.rows.map(row => row.laneId),
    ['dormant-old', 'dormant'],
  );
  assert.deepEqual(
    result.groups.stopped.rows.map(row => row.laneId),
    ['quiet'],
  );
  for (const key of ['checked', 'projects', 'dated']) {
    assert.equal(result.groups[key].reported, false);
    assert.ok(result.groups[key].why.length > 10, `${key} says why`);
  }
  assert.equal(typeof result.setAside.authorityEpoch, 'number', 'the owner may set Lanes aside');
  const view = looseEndsView(result, result.at);
  assert.equal(view.listed, 3);
  assert.match(view.sentence.rest, /Nothing here is deleted\. 3 of 5 groups are not reported yet/);
  assert.equal(view.groups[0].rows[0].who, 'owner/quiet-otter');
});

test('another account cannot read loose ends', async () => {
  const s = fixture();
  await assert.rejects(read(s, 'stranger'), error => error.data?.code === 'PROJECT_UNAVAILABLE');
});

test('77d2e8bc: a CLI tidy pass reaches every stopped Lane once across timestamp ties and a removed boundary', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const s = fixture();
  const presence = s.tables.projectHostedPresence;
  const first = presence.get('presence-quiet');
  const expected = [first.laneId];
  for (let n = 2; n <= 55; n++) {
    const laneId = `quiet-${String(n).padStart(2, '0')}`;
    expected.push(laneId);
    presence.set(`presence-${laneId}`, {
      ...first,
      _id: `presence-${laneId}`,
      _creationTime: Math.ceil(n / 4),
      at: n > 50 ? first.at + 10 : first.at,
      laneId,
      intentId: `intent-${laneId}`,
    });
  }
  const reads = meterReads(s.ctx);
  let calls = 0;
  const transport = {
    query: async (name, args) => {
      assert.equal(name, 'projectLooseEnds:read');
      calls++;
      return read(s, 'owner', args);
    },
  };
  const seen = [];
  let cursor;
  for (const pageSize of [25, 25, 5]) {
    let result;
    const cost = await reads.cost(async () => {
      ({ result } = await liveLanes(transport, { view: 'loose-ends', ...(cursor ? { cursor } : {}) }));
    });
    if (cursor) assert.deepEqual(Object.keys(result.groups), ['stopped']);
    else assert.equal(result.groups.idle.rows.length, 2);
    const { rows, more, continueCursor } = result.groups.stopped;
    assert.equal(rows.length, pageSize);
    assert.equal(more, pageSize === 25);
    assert.equal(Boolean(continueCursor), more);
    const lookahead = more ? 1 : 0;
    assert.ok(
      cost.documents <= pageSize + lookahead + (cursor ? 1 : 3),
      `bounded page: ${cost.documents} documents`,
    );
    t.diagnostic(`stopped page: ${rows.length} rows, ${cost.documents} documents, ${cost.bytes} fixture B`);
    seen.push(...rows.map(row => row.laneId));
    if (!cursor) {
      presence.delete(`presence-${rows.at(-1).laneId}`);
      // The existing rows would age out of stopped if the time range were recomputed.
      now += 2 * day;
      presence.get('presence-busy').at = now - 3 * 60 * 60 * 1000;
      await assert.rejects(
        read(s, 'stranger', { cursor: continueCursor }),
        error => error.data?.code === 'PROJECT_UNAVAILABLE',
      );
    }
    cursor = continueCursor;
  }
  reads.restore();
  assert.equal(cursor, null);
  assert.equal(calls, 3, 'one hosted call per requested page');
  assert.deepEqual(seen, expected);
});

test('a malformed stopped cursor explains how to restart the tidy pass', async () => {
  await assert.rejects(
    read(fixture(), 'owner', { cursor: 'forge-loose-ends-stopped-v1:{' }),
    error => error.data?.code === 'BAD_ARGUMENT' && /continueCursor/.test(error.data.message),
  );
});

test('a Lane that changed meanwhile is skipped and named; only a failed call is retried', () => {
  assert.equal(setAsideWord('abandoned').done, true);
  assert.equal(setAsideWord('not-dormant').word, 'Skipped: it was saved meanwhile');
  assert.equal(setAsideWord('has-saved-work').retry, false);
  assert.equal(setAsideWord('failed').retry, true);
});

test('d9e1ac62: a quiet Lane whose Item has a live Lane says what replaced it and how its agent abandons it', async () => {
  const s = fixture();
  const now = Date.now();
  // 'quiet' and 'busy' are two open Lanes of one Item; 'busy' saved five minutes ago.
  s.tables.projectHostedPresence.get('presence-busy').intentId = 'intent-quiet';
  for (const laneId of ['quiet', 'busy', 'dormant'])
    s.tables.projectHostedRecordHeads.set(`head-${laneId}`, {
      _id: `head-${laneId}`,
      _creationTime: laneId === 'busy' ? 3 : 2,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: `intent-${laneId === 'busy' ? 'quiet' : laneId}`,
      status: 'active',
      recordId: `record-${laneId}`,
      at: now,
    });
  const result = await read(s, 'owner');
  const [quiet] = result.groups.stopped.rows;
  assert.equal(quiet.replacedBy, 'busy');
  assert.equal(quiet.next, 'nforge x ROOT abandon {"laneId":"quiet","reason":"Replaced by Lane busy"}');
  // A Lane alone on its Item is never called replaced.
  assert.equal(result.groups.idle.rows.find(row => row.laneId === 'dormant').replacedBy, undefined);
});

test('d9e1ac62 (real case, Item 1dd4e095): a quiet Lane whose quiet resolution Lane is listed reads replaced by it', async () => {
  const s = fixture();
  const now = Date.now();
  // 'dormant' conflicted and 'quiet' is its resolution Lane; both are quiet, so the live-Lane rule names nobody.
  s.tables.projectHostedPresence.get('presence-quiet').intentId = 'intent-dormant';
  // The origin is read from the Lane record the head points at (Item 77d2e8bc), never from the overlap row.
  for (const laneId of ['quiet', 'dormant']) {
    s.tables.projectHostedRecordHeads.set(`head-${laneId}`, {
      _id: `head-${laneId}`,
      _creationTime: 2,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: 'intent-dormant',
      status: 'active',
      recordId: `record-${laneId}`,
      at: now,
    });
    const inline = laneRecord(laneId, laneId === 'quiet' ? 'dormant' : null);
    s.tables.projectHostedRecords.set(`record-${laneId}`, {
      _id: `record-${laneId}`,
      _creationTime: 2,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: 'intent-dormant',
      status: 'active',
      version: 3,
      inline,
      bodyId: `body-${laneId}`,
      digest: digest(inline),
      bytes: new TextEncoder().encode(inline).length,
    });
  }
  // What the read used to open per listed quiet Lane: the overlap row, whose `changes` grow with the Lane's edits
  // (dogfood shape: 30 changed paths with their line ranges).
  const overlap = {
    _id: 'overlap-quiet',
    _creationTime: 1,
    projectId: 'project',
    laneId: 'quiet',
    resolutionOrigin: 'somewhere-else',
    changes: JSON.stringify(
      Array.from({ length: 30 }, (_, n) => ({
        path: `web/src/app/synthetic/area-${n}/module.tsx`.padEnd(60, 'y'),
        lines: Array.from({ length: 6 }, (_, k) => [k * 40 + 1, k * 40 + 12]),
      })),
    ),
  };
  s.tables.projectHostedOverlapLanes.set('overlap-quiet', overlap);
  const query = s.ctx.db.query.bind(s.ctx.db);
  s.ctx.db.query = table => {
    assert.notEqual(table, 'projectHostedOverlapLanes', 'no overlap row is read');
    return query(table);
  };
  const meter = meterReads(s.ctx);
  let result;
  const cost = await meter.cost(async () => {
    result = await read(s, 'owner');
  });
  meter.restore();
  const origin = result.groups.idle.rows.find(row => row.laneId === 'dormant');
  assert.equal(origin.replacedBy, 'quiet');
  assert.equal(origin.next, 'nforge x ROOT abandon {"laneId":"dormant","reason":"Replaced by Lane quiet"}');
  assert.equal(result.groups.stopped.rows[0].replacedBy, undefined, 'the resolution Lane is not replaced');
  const record = JSON.stringify(s.tables.projectHostedRecords.get('record-quiet')).length;
  const before = JSON.stringify(overlap).length;
  assert.ok(
    record < before / 3,
    `a Lane record (${record} B) is far smaller than an overlap row (${before} B)`,
  );
  console.log(
    `loose-ends origin: ${record} B Lane record vs ${before} B overlap row per listed quiet Lane; read ${cost.documents} documents, ${cost.bytes} B`,
  );

  // The stopped page keeps its 26th row for replacement advice, even though it displays only 25.
  const presence = s.tables.projectHostedPresence;
  const resolution = presence.get('presence-quiet');
  for (let n = 0; n < 25; n++) {
    const laneId = `earlier-${n}`;
    presence.set(`presence-${laneId}`, {
      ...resolution,
      _id: `presence-${laneId}`,
      at: resolution.at - 1,
      laneId,
      intentId: laneId,
    });
  }
  const firstPage = await read(s, 'owner');
  assert.equal(firstPage.groups.idle.rows.find(row => row.laneId === 'dormant').replacedBy, 'quiet');
  assert.equal(firstPage.groups.stopped.rows.length, 25);
  assert.ok(firstPage.groups.stopped.continueCursor);

  presence.delete('presence-earlier-0');
  const exactPage = (await read(s, 'owner')).groups.stopped;
  assert.equal(exactPage.rows.length, 25);
  assert.equal(exactPage.more, false);
  assert.equal(exactPage.continueCursor, null);
});

test('an Item with one listed quiet Lane reads no Lane record: a resolution needs both Lanes listed', async () => {
  const s = fixture();
  s.tables.projectHostedPresence.get('presence-busy').intentId = 'intent-quiet';
  s.tables.projectHostedPresence.get('presence-busy').at = Date.now() - 5 * 60 * 1000;
  for (const laneId of ['quiet', 'busy'])
    s.tables.projectHostedRecordHeads.set(`head-${laneId}`, {
      _id: `head-${laneId}`,
      _creationTime: laneId === 'busy' ? 3 : 2,
      projectId: 'project',
      kind: 'lane',
      key: laneId,
      parent: 'intent-quiet',
      status: 'active',
      recordId: `record-${laneId}`,
      at: Date.now(),
    });
  const get = s.ctx.db.get.bind(s.ctx.db);
  const opened = [];
  s.ctx.db.get = async id => (opened.push(id), get(id));
  const result = await read(s, 'owner');
  assert.equal(result.groups.stopped.rows[0].replacedBy, 'busy');
  assert.deepEqual(
    opened.filter(id => String(id).startsWith('record-')),
    [],
  );
});
