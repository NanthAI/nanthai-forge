// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { readOverlapInbox } from '../dist/overlap-inbox.js';
import { digest } from '../dist/portable-hash.js';
const acks = await import(moduleUrl('../convex/projectHostedOverlapAcks.ts'));

function fixture(count = 20, shared = count) {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  for (let i = 0; i < 560; i++) {
    const laneId = `lane-${i}`,
      open = i < count;
    s.insert('projectHostedOverlapLanes', {
      projectId,
      laneId,
      intentId: `intent-${i}`,
      actor: 'owner',
      intent: 'Synthetic change',
      head: 'b',
      baseHead: 'a',
      baseReceiptId: 'receipt',
      baseSequence: 1,
      recordVersion: 1,
      open,
      changes: JSON.stringify(
        Array.from({ length: 200 }, (_, j) => ({
          path: j < 2 && i < shared ? `shared-${j}.ts` : `${i}/file-${j}.ts`,
          before: null,
          after: { blob: 'b'.repeat(64), mode: 'file' },
        })),
      ),
      complete: true,
    });
    if (open)
      s.insert('projectHostedRecordHeads', {
        projectId,
        kind: 'lane',
        key: laneId,
        parent: `intent-${i}`,
        status: 'active',
        version: 1,
        recordId: 'projectHostedRecords-synthetic',
      });
  }
  s.insert('projectHostedChannels', {
    projectId,
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify({ head: 'a', sourceRevision: 1 }),
  });
  for (let i = 0; i < 100; i++)
    s.insert('projectHostedOverlapAcks', {
      projectId,
      actor: 'owner',
      id: randomUUID(),
      request: 'request',
      laneId: `lane-${i}`,
      noticeId: 'old',
      value: JSON.stringify({ laneId: `lane-${i}`, noticeId: 'old', at: '2026-10-14T10:00:00Z' }),
    });
  return { ...s, projectId };
}
test('one authorized shared read uses bounded indexed signals and ack windows at dogfood size, without writes', async t => {
  const s = fixture();
  const start = performance.now();
  const result = JSON.parse(
    await s.call('Now', acks.list, { projectId: s.projectId, cursor: null, signals: true }),
  );
  const measured = s.counts.at(-1);
  assert.equal(result.page.length, 100);
  assert.equal(result.signals.edits.length, 20);
  assert.equal(result.signals.complete, false, 'per-Lane display notice limit is explicit');
  assert.equal(
    result.signals.notices[0].noticeId,
    digest(JSON.stringify(['first-write', ['lane-0', 'lane-1'], 'shared-0.ts'])),
  );
  assert.equal(result.signals.notices[0].at, undefined, 'a detection is not a delivery timestamp');
  assert.ok(measured.documents <= 150, JSON.stringify(measured));
  assert.ok(measured.ranges <= 10);
  assert.ok(measured.readBytes < 1200 * 1024);
  assert.equal(measured.writes, 0);
  assert.ok(
    !measured.touched.some(table =>
      ['projectHostedRecordBodies', 'projectWorkRecords', 'projectObjects'].includes(table),
    ),
  );
  t.diagnostic(
    JSON.stringify({
      functions: 1,
      ...measured,
      wallMs: performance.now() - start,
      rss: process.memoryUsage().rss,
      peakRssKiB: process.resourceUsage().maxRSS,
    }),
  );
  await assert.rejects(
    s.call('unauthorized', acks.list, { projectId: s.projectId, cursor: null, signals: true }, null),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    s.call('outsider', acks.list, { projectId: s.projectId, cursor: null, signals: true }, 'outsider'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
});
test('closed/stale canonical headers and partial windows never claim complete current coverage', async () => {
  const s = fixture(110);
  let result = JSON.parse(
    await s.call('partial', acks.list, { projectId: s.projectId, cursor: null, signals: true }),
  );
  assert.equal(result.signals.complete, false);
  assert.ok(result.signals.edits.length < 100, 'byte-bounded page');
  const first = [...s.tables.projectHostedRecordHeads.values()][0];
  s.patch('projectHostedRecordHeads', first._id, { version: 2 });
  result = JSON.parse(
    await s.call('stale', acks.list, { projectId: s.projectId, cursor: null, signals: true }),
  );
  assert.ok(!result.signals.edits.some(row => row.laneId === first.key));
});
test('paused and ready canonical Lanes stay open; missing lifecycle markers remain unknown', async () => {
  const s = fixture(2);
  const headers = [...s.tables.projectHostedRecordHeads.values()];
  s.patch('projectHostedRecordHeads', headers[0]._id, { status: 'paused' });
  s.patch('projectHostedRecordHeads', headers[1]._id, { status: 'ready' });
  const reply = JSON.parse(
    await s.call('open states', acks.list, { projectId: s.projectId, cursor: null, signals: true }),
  );
  assert.equal(reply.signals.edits.length, 2);
  const row = [...s.tables.projectHostedOverlapLanes.values()][0];
  // A missing or cross-project lifecycle receipt is unknown, never proof of an open Lane.
  s.patch('projectHostedOverlapLanes', row._id, { lifecyclePlanId: 'projectHostedLifecyclePlans-missing' });
  const missing = JSON.parse(
    await s.call('missing marker', acks.list, { projectId: s.projectId, cursor: null, signals: true }),
  );
  assert.equal(missing.signals.notices.length, 0);
  assert.equal(missing.signals.complete, false);
});
test('retained hook inbox publishes twenty newest exact deliveries, ignores unrelated files and uses no network', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-now-inbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readOverlapInbox(root, 'lane'), []);
  mkdirSync(join(root, 'overlap-inbox/lane'), { recursive: true });
  for (let i = 0; i < 25; i++) {
    const noticeId = i.toString(16).padStart(64, '0');
    writeFileSync(
      join(root, 'overlap-inbox/lane', `${noticeId}.json`),
      JSON.stringify({
        noticeId,
        file: `file-${i}`,
        lanes: ['lane', 'peer'],
        at: new Date(1700000000000 + i * 1000).toISOString(),
        text: 'private detail never published',
        regions: [],
      }),
    );
  }
  writeFileSync(join(root, 'overlap-inbox/lane/unrelated.txt'), 'ignored');
  const rows = readOverlapInbox(root, 'lane');
  assert.equal(rows.length, 20);
  assert.equal(rows[0].file, 'file-24');
  assert.equal(rows[19].file, 'file-5');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'file', 'lanes', 'noticeId']);
});
test('a read-only reader gets the same bounded read; a reader still cannot record an answer', async () => {
  const s = fixture(3);
  s.insert('projectReaders', { projectId: s.projectId, reader: 'reader' });
  const owner = JSON.parse(
    await s.call('owner', acks.list, { projectId: s.projectId, cursor: null, signals: true }),
  );
  const reader = JSON.parse(
    await s.call('reader', acks.list, { projectId: s.projectId, cursor: null, signals: true }, 'reader'),
  );
  assert.deepEqual(reader.signals, owner.signals);
  assert.equal(reader.page.length, owner.page.length);
  assert.equal(s.counts.at(-1).writes, 0);
  const before = s.tables.projectHostedOverlapAcks.size;
  await assert.rejects(
    s.call('reader append', acks.append, { projectId: s.projectId, request: '{}' }, 'reader'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
    'a reader still cannot record an answer',
  );
  assert.equal(s.tables.projectHostedOverlapAcks.size, before);
});
test('signals share one query function with the ack page: only one paginate() runs, on any ack page', async () => {
  const s = fixture(20);
  const first = JSON.parse(
    await s.call('page one', acks.list, { projectId: s.projectId, cursor: null, signals: true }),
  );
  assert.equal(first.isDone, true);
  // Convex rejects a second paginate() in one query function; the fake now does too (2026-11-05 dev failure).
  const twice = {
    isQuery: true,
    _handler: async ctx => {
      const q = () =>
        ctx.db
          .query('projectHostedOverlapAcks')
          .withIndex('by_project_and_id', x => x.eq('projectId', s.projectId));
      await q().paginate({ cursor: null, numItems: 1 });
      return q().paginate({ cursor: null, numItems: 1 });
    },
  };
  await assert.rejects(s.call('two paginates', twice, {}), /multiple paginated queries/);
  const withCursor = JSON.parse(
    await s.call('page two', acks.list, {
      projectId: s.projectId,
      cursor: '50',
      signals: true,
    }),
  );
  assert.equal(withCursor.page.length, 50);
  assert.deepEqual(withCursor.signals, first.signals);
});
test('the Now read: one call, no writes, answers of open Lanes only, the caller’s times, under the byte budget', async t => {
  // Two of the 20 open Lanes share files, as on dev; every Lane saved 200 paths.
  const s = fixture(20, 2);
  const { NOW_OVERLAP_VIEW_BUDGET, readViewSignals, noticeKey } = await import(
    moduleUrl('../src/now-overlap-view.ts')
  );
  const legacy = await s.call('list', acks.list, { projectId: s.projectId, cursor: null, signals: true });
  const raw = await s.call('Now', acks.now, { projectId: s.projectId });
  const measured = s.counts.at(-1);
  const reply = JSON.parse(raw);
  t.diagnostic(
    JSON.stringify({ listBytes: Buffer.byteLength(legacy), nowBytes: Buffer.byteLength(raw), ...measured }),
  );
  assert.ok(Buffer.byteLength(legacy) > NOW_OVERLAP_VIEW_BUDGET, 'the old read replays the incident size');
  assert.ok(Buffer.byteLength(raw) < NOW_OVERLAP_VIEW_BUDGET);
  assert.equal(measured.writes, 0);
  // 20 open Lanes: their 20 answers are read; the 80 answers on closed Lanes are not.
  assert.deepEqual(
    Object.keys(reply.answered).sort(),
    Array.from({ length: 20 }, (_, i) => `lane-${i}`).sort(),
  );
  assert.deepEqual(reply.answered['lane-0'], [noticeKey('old')]);
  assert.equal(reply.mine.length, 20, 'every answer here is the owner’s');
  assert.equal(reply.complete, true);
  assert.equal(reply.signals.edits.length, 20, 'every open Lane keeps its pin');
  assert.deepEqual(
    reply.signals.paths.sort(),
    ['shared-0.ts', 'shared-1.ts'],
    'only paths two Lanes share are sent',
  );
  assert.deepEqual(readViewSignals(reply.signals).notices, JSON.parse(legacy).signals.notices);
  assert.equal(reply.signals.notices.length, 2, 'two shared files, one pair each');
  // The busiest synthetic shape (all 20 Lanes share both files) still sends far less than the old read.
  const busy = fixture(20);
  const busyLegacy = await busy.call('list', acks.list, {
    projectId: busy.projectId,
    cursor: null,
    signals: true,
  });
  const busyNow = await busy.call('Now', acks.now, { projectId: busy.projectId });
  t.diagnostic(
    JSON.stringify({
      busyListBytes: Buffer.byteLength(busyLegacy),
      busyNowBytes: Buffer.byteLength(busyNow),
    }),
  );
  assert.ok(Buffer.byteLength(busyNow) * 3 < Buffer.byteLength(busyLegacy));
  const reader = 'reader';
  s.insert('projectReaders', { projectId: s.projectId, reader });
  const read = JSON.parse(await s.call('reader', acks.now, { projectId: s.projectId }, reader));
  assert.deepEqual(read.answered, reply.answered);
  assert.deepEqual(read.mine, [], 'another viewer’s answers are not theirs');
  await assert.rejects(
    s.call('outsider', acks.now, { projectId: s.projectId }, 'outsider'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
});
