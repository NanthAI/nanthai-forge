// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostedRecoveryFixture } from './recovery-hosted-fixture.mjs';
import { restoreRecoverySource } from '../dist/recovery-source.js';
import { mkdirSync, renameSync } from 'node:fs';

// Portable archive/fold tests exercise independent snapshot restoration. Route B
// itself is covered by recovery-owner and recovery-runner and creates no owner.
async function recoverSnapshot(target, request, transport) {
  const directory = `${target}-snapshot-stage`,
    stage = join(directory, 'snapshot');
  mkdirSync(directory, { recursive: true });
  const { selection } = await transport.prepare();
  const coverage = await restoreRecoverySource(
    directory,
    existsSync(target) ? target : stage,
    request,
    selection,
    transport,
  );
  if (!existsSync(target)) renameSync(stage, target);
  return { coverage, reconnected: false, connection: null };
}
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { exportNativeWork, restoreNativeWork } from '../dist/native-backup.js';
import { hostedRecoveryRows, hostedRecoveryObjects } from '../dist/recovery-hosted.js';
import { readHostState } from '../dist/host-binding.js';

for (const archive of [false, true])
  test(`${archive ? 'archive' : 'object'} checkpoint folds hosted-only main, exact pending completions, queue and stale returns, without hosted writes`, async t => {
    const f = await hostedRecoveryFixture(t, { archive });
    f.transport.reconnect = async () => {
      assert.fail('hosted recovery must never reconnect/write hosted');
    };
    const result = await recoverSnapshot(f.target, f.request, f.transport);
    assert.equal(result.coverage.main.head, f.head);
    assert.equal(result.coverage.main.moveId, f.acceptedReceipts.at(-1).id);
    assert.equal(result.reconnected, false);
    assert.equal(result.connection, null);
    assert.equal(readHostState(f.store()).binding, undefined);
    const source = new NativeSource(f.target),
      recovery = f.store().load().hostedRecovery;
    assert.equal(source.object(source.state(f.head).files[0].blob).toString(), 'accepted only on hosted\n');
    const rows = table => [...hostedRecoveryRows(source, recovery, table)];
    assert.deepEqual(rows('projectHostedAcceptancePlans'), f.tables.projectHostedAcceptancePlans);
    assert.deepEqual(rows('projectHostedAcceptancePages'), f.tables.projectHostedAcceptancePages);
    assert.deepEqual(rows('projectHostedAcceptances'), f.tables.projectHostedAcceptances);
    assert.deepEqual(rows('projectReturnSupersessions'), [f.stale]);
    assert.deepEqual(rows('projectHostedLandingRequests'), f.tables.projectHostedLandingRequests);
    assert.equal(
      result.coverage.hosted.rows,
      Object.values(f.tables).reduce((n, rows) => n + rows.length, 0),
    );
    const before = f.store().snapshotBytes();
    // A completed fold from the prior recovery implementation has no queue
    // completion flag. Retrying it must preserve its original portable root.
    const progressPath = join(`${f.target}-snapshot-stage`, 'hosted-fold.json');
    const legacy = JSON.parse(readFileSync(progressPath, 'utf8'));
    delete legacy.sourceComplete;
    writeFileSync(progressPath, JSON.stringify(legacy));
    await recoverSnapshot(f.target, f.request, f.transport);
    assert(f.store().snapshotBytes().equals(before));
    assert.equal(f.counters().reconnects, 0);
    assert.equal(f.receipts.size, 0, 'no new acceptance or reconnect receipt');
    // Existing archive machinery carries the exact page/object closure to another clean machine.
    const exported = (await exportNativeWork(f.store(), f.store().revision(), true)).result;
    const independent = join(f.directory, 'independent');
    await restoreNativeWork(exported.archive.path, independent);
    const copy = new WorkStore(independent),
      copySource = new NativeSource(independent);
    assert.deepEqual(copy.load().hostedRecovery, recovery);
    assert.deepEqual(
      [...hostedRecoveryRows(copySource, recovery, 'projectHostedAcceptances')],
      rows('projectHostedAcceptances'),
    );
    assert.equal(copySource.object(f.blob).toString(), 'accepted only on hosted\n');
  });

test('an interrupted page resumes its saved cursor, never duplicates receipts or loses queue outcomes', async t => {
  const f = await hostedRecoveryFixture(t, { accepted: 150 });
  const page = f.transport.hostedPage;
  let interrupted = false;
  f.transport.hostedPage = async (selection, table, cursor) => {
    if (!interrupted && table === 'projectHostedAcceptances' && cursor) {
      interrupted = true;
      throw Object.assign(new Error('Synthetic interrupted page'), { code: 'EXCHANGE_REQUEST_FAILED' });
    }
    return page(selection, table, cursor);
  };
  await assert.rejects(recoverSnapshot(f.target, f.request, f.transport), {
    code: 'EXCHANGE_REQUEST_FAILED',
  });
  assert(!existsSync(f.target));
  const expectedCursor = String(f.calls.find(call => call.table === 'projectHostedAcceptances').rows);
  f.calls.length = 0;
  const result = await recoverSnapshot(f.target, f.request, f.transport);
  assert.equal(f.calls[0].table, 'projectHostedAcceptances');
  assert.equal(f.calls[0].cursor, expectedCursor);
  const source = new NativeSource(f.target);
  const rows = [...hostedRecoveryRows(source, result.coverage.hosted, 'projectHostedAcceptances')];
  assert.equal(rows.length, 150);
  assert.equal(new Set(rows.map(row => row.receiptId)).size, 150);
  assert.equal(f.counters().reconnects, 0);
});

for (const fault of [
  'cross-project',
  'no-progress',
  'missing-body',
  'bad-receipt',
  'bad-page',
  'changed-during-scan',
  'corrupt-object',
])
  test(`hosted folding preserves staging and refuses ${fault} before publication`, async t => {
    const f = await hostedRecoveryFixture(t);
    const page = f.transport.hostedPage;
    if (fault === 'missing-body') f.tables.projectHostedRecords[0].bodyId = 'missing';
    if (fault === 'bad-receipt') f.tables.projectHostedAcceptanceSnapshots[0].head = 'a'.repeat(64);
    if (fault === 'bad-page') f.tables.projectHostedAcceptancePages[0].digest = 'a'.repeat(64);
    if (fault === 'corrupt-object') {
      const download = f.transport.download;
      f.transport.download = pin => (pin.sha256 === f.head ? Buffer.from('corrupt') : download(pin));
    }
    let changed = false;
    f.transport.hostedPage = async (selection, table, cursor) => {
      if (fault === 'changed-during-scan' && table === 'projectReturnSupersessions' && !changed) {
        changed = true;
        f.tables.projectHostedLandingRequests[0].phase = 'terminal-failed';
      }
      const result = await page(selection, table, cursor);
      if (fault === 'cross-project' && result.rows.length) {
        const row = JSON.parse(result.rows[0]);
        row.projectId = 'other';
        result.rows[0] = JSON.stringify(row);
      }
      if (fault === 'no-progress') {
        result.done = false;
        result.cursor = cursor;
      }
      return result;
    };
    await assert.rejects(recoverSnapshot(f.target, f.request, f.transport));
    assert(!existsSync(f.target));
    assert.equal(f.counters().reconnects, 0);
    assert.equal(f.receipts.size, 0);
  });

test('thousands of accepted entries use bounded pages and retain every original receipt (synthetic measurement)', async t => {
  const f = await hostedRecoveryFixture(t, { accepted: 2000 });
  const started = performance.now(),
    baselineHeapBytes = process.memoryUsage().heapUsed;
  let peakHeapBytes = baselineHeapBytes;
  const page = f.transport.hostedPage;
  f.transport.hostedPage = async (...args) => {
    peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
    return page(...args);
  };
  const result = await recoverSnapshot(f.target, f.request, f.transport);
  const elapsedMs = Math.round(performance.now() - started),
    recovered = result.coverage.hosted;
  assert(f.calls.every(call => call.rows <= 64));
  assert.equal(recovered.counts.projectHostedAcceptances, 2000);
  assert(
    !f.manifest.files.some(file => file.sha256 === f.head),
    'seed backup omits the hosted-only accepted head',
  );
  assert.equal(recovered.counts.projectHostedLandingRequests, 2001);
  assert.equal(recovered.counts.projectHostedAcceptanceSnapshots, 2000);
  assert.equal(recovered.counts.projectHostedAcceptancePlans, 2000);
  assert.equal(f.counters().reconnects, 0);
  t.diagnostic(
    JSON.stringify({
      accepted: 2000,
      restoredRows: recovered.rows,
      capturedPageBytes: recovered.bytes,
      maxPageBytes: recovered.maxPageBytes,
      baselineHeapBytes,
      peakHeapBytes,
      elapsedMs,
      pageCalls: f.calls.length,
      droppedAcceptedReceipts: 2000 - recovered.counts.projectHostedAcceptances,
    }),
  );
});

test('opaque source bytes identical to an inventory node do not suppress its metadata traversal', async t => {
  const f = await hostedRecoveryFixture(t),
    source = new NativeSource(f.root);
  const put = value => {
    const bytes = Buffer.from(JSON.stringify(value));
    return { sha256: source.put(bytes), size: bytes.length };
  };
  const shared = put({
    kind: 'forge-hosted-recovery-object',
    previous: null,
    object: { sha256: f.blob, size: source.object(f.blob).length },
    nested: false,
  });
  // LIFO traversal reads the opaque object first, then the same bytes as metadata.
  const root = put({ kind: 'forge-hosted-recovery-object', previous: shared, object: shared, nested: false });
  const ids = [...hostedRecoveryObjects(source, { hostedRecovery: { objects: root, pages: null } })];
  assert(ids.includes(f.blob));
});
