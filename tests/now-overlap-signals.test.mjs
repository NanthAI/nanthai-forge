// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const nowApi = await import(moduleUrl('../convex/projectNowOverlaps.ts'));
const { NOW_OVERLAP_VIEW_BUDGET, readViewSignals } = await import(moduleUrl('../src/now-overlap-view.ts'));
// Overlap answers are gone (Issue 853fcde3): the Now page's one read carries the bounded signals only.
const now = async (s, name, ...actor) => {
  const raw = await s.call(name, nowApi.now, { projectId: s.projectId }, ...actor);
  const reply = JSON.parse(raw);
  return { raw, reply, signals: readViewSignals(reply.signals) };
};

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
  return { ...s, projectId };
}
test('one authorized Now read uses bounded indexed signals at dogfood size, without writes', async t => {
  const s = fixture();
  const start = performance.now();
  const { signals } = await now(s, 'Now');
  const measured = s.counts.at(-1);
  assert.equal(signals.edits.length, 20);
  assert.equal(signals.complete, true, 'twenty open Lanes fit one window');
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
  await assert.rejects(now(s, 'unauthorized', null), error => error.data?.code === 'PROJECT_UNAVAILABLE');
  await assert.rejects(now(s, 'outsider', 'outsider'), error => error.data?.code === 'PROJECT_UNAVAILABLE');
});
test('closed/stale canonical headers and partial windows never claim complete current coverage', async () => {
  const s = fixture(110);
  let { signals } = await now(s, 'partial');
  assert.equal(signals.complete, false);
  assert.ok(signals.edits.length < 100, 'byte-bounded page');
  const first = [...s.tables.projectHostedRecordHeads.values()][0];
  s.patch('projectHostedRecordHeads', first._id, { version: 2 });
  ({ signals } = await now(s, 'stale'));
  assert.ok(!signals.edits.some(row => row.laneId === first.key));
});
test('paused and ready canonical Lanes stay open; missing lifecycle markers remain unknown', async () => {
  const s = fixture(2);
  const headers = [...s.tables.projectHostedRecordHeads.values()];
  s.patch('projectHostedRecordHeads', headers[0]._id, { status: 'paused' });
  s.patch('projectHostedRecordHeads', headers[1]._id, { status: 'ready' });
  assert.equal((await now(s, 'open states')).signals.edits.length, 2);
  const row = [...s.tables.projectHostedOverlapLanes.values()][0];
  // A missing or cross-project lifecycle receipt is unknown, never proof of an open Lane.
  s.patch('projectHostedOverlapLanes', row._id, { lifecyclePlanId: 'projectHostedLifecyclePlans-missing' });
  const missing = (await now(s, 'missing marker')).signals;
  assert.equal(missing.edits.length, 1);
  assert.equal(missing.complete, false);
});
test('the Now read: one call, no writes, shared paths only, the same for a reader, under the byte budget', async t => {
  // Two of the 20 open Lanes share files, as on dev; every Lane saved 200 paths.
  const s = fixture(20, 2);
  const { raw, reply, signals } = await now(s, 'Now');
  const measured = s.counts.at(-1);
  t.diagnostic(JSON.stringify({ nowBytes: Buffer.byteLength(raw), ...measured }));
  assert.ok(Buffer.byteLength(raw) < NOW_OVERLAP_VIEW_BUDGET);
  assert.equal(measured.writes, 0);
  assert.equal(reply.answered, undefined, 'no answers are read or sent');
  assert.equal(signals.edits.length, 20, 'every open Lane keeps its pin');
  assert.deepEqual(
    reply.signals.paths.sort(),
    ['shared-0.ts', 'shared-1.ts'],
    'only paths two Lanes share are sent',
  );
  const busy = fixture(20);
  assert.ok(Buffer.byteLength((await now(busy, 'busy')).raw) < NOW_OVERLAP_VIEW_BUDGET);
  s.insert('projectReaders', { projectId: s.projectId, reader: 'reader' });
  assert.deepEqual((await now(s, 'reader', 'reader')).reply, reply);
  assert.equal(s.counts.at(-1).writes, 0);
});
