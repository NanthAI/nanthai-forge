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

function fixture(count = 20) {
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
          path: j < 2 ? `shared-${j}.ts` : `${i}/file-${j}.ts`,
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
