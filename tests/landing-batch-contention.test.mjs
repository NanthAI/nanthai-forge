// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { checkEnvironment } from '../dist/check-environment.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkRecordTransaction } from '../dist/work-record-transaction.js';
import { prepareRunRegistration } from '../dist/work-run-preparation.js';
import { historyFixture } from './landing-starvation-fixture.mjs';
import { batchEdit } from '../dist/landing-batch-store.js';
import { prepareLandingRecords } from '../dist/landing-records-index.js';
import { ForgeError } from '../dist/errors.js';
import { withWorkLockOptions } from '../dist/work-lock.js';

test('selected batch edits progress through continuously committed peer writes, including the locked third attempt', async t => {
  let child;
  t.after(async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  });
  const f = await historyFixture(t, { journals: false });
  const checkId = f.store.page('checks', 0, 1).records[0].id;
  const tx = f.store.readRecords();
  await prepareLandingRecords(f.store, tx);
  tx.dispose();
  const module = new URL('../dist/work-store.js', import.meta.url).href;
  child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { WorkStore } from ${JSON.stringify(module)};
    const store = new WorkStore(process.argv[1]); let count = 0, pending = [];
    process.on('message', barrier => pending.push(barrier));
    const tick = () => {
      try { store.locked(() => { const tx = store.records(), check = tx.find('checks', process.argv[2]); check.record.environmentLabel = 'peer-' + (++count); tx.replace('checks', check.position, check.record); store.commitRecords(tx); }, { waitMs: 0 }); for (const barrier of pending.splice(0)) process.send({ barrier, count }); }
      catch (error) { if (!['WORK_BUSY', 'WORK_STALE'].includes(error.code)) throw error; }
      setTimeout(tick, 0);
    }; tick();`,
      f.root,
      checkId,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let barriers = 0;
  const nextCommit = () =>
    new Promise((resolve, reject) => {
      if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
        reject(new Error('Concurrent writer is no longer running'));
        return;
      }
      const barrier = ++barriers;
      const cleanup = () => {
        child.off('message', listener);
        child.off('exit', stopped);
        child.off('error', failed);
        child.off('disconnect', disconnected);
      };
      const failed = error => {
        cleanup();
        reject(error);
      };
      const stopped = (code, signal) => failed(new Error(`Concurrent writer stopped: ${code}/${signal}`));
      const disconnected = () => failed(new Error('Concurrent writer disconnected before committing'));
      const listener = value => {
        if (value.barrier !== barrier) return;
        cleanup();
        resolve(value.count);
      };
      child.on('message', listener);
      child.once('exit', stopped);
      child.once('error', failed);
      child.once('disconnect', disconnected);
      child.send(barrier, error => {
        if (error) failed(error);
      });
    });
  await nextCommit();
  const locked = f.store.lockedAsync.bind(f.store);
  let underLock = false;
  t.mock.method(f.store, 'lockedAsync', async task => {
    // Force a publication between each optimistic prepare and admission. The
    // child continues committing throughout the operation, rather than stopping
    // after a fixed number of conflicts.
    await nextCommit();
    return locked(() => {
      underLock = true;
      try {
        return task();
      } finally {
        underLock = false;
      }
    });
  });
  t.mock.method(f.store, 'load', () => assert.fail('Indexed batch editing must never load all Work'));
  const attempts = [];
  const began = performance.now();
  await batchEdit(
    f.work,
    f.batch.id,
    data => {
      attempts.push(underLock);
      data.landingBatches.find(batch => batch.id === f.batch.id).timing.selectedAt =
        '2026-10-26T12:14:00.000Z';
    },
    undefined,
    undefined,
    { selectedOnly: true },
  );
  const elapsed = performance.now() - began;
  assert.deepEqual(attempts, [false, false, true]);
  // Three attempts bound algorithmic progress independently of OS scheduling.
  assert.equal(barriers, 4, 'one startup commit and one peer commit before each admission');
  assert.equal(f.store.select('landingBatches', f.batch.id).timing.selectedAt, '2026-10-26T12:14:00.000Z');
  assert.ok(Number(f.store.select('checks', checkId).environmentLabel.slice(5)) >= 3);
  assert.ok(await nextCommit(), 'Peer writer continues after the landing edit');
  t.diagnostic(
    `550 entries / 450 batches; 3 attempts, third selected under lock; progress ${elapsed.toFixed(2)} ms`,
  );
});

test('a slow second stale preparation still reaches selected FIFO admission', async t => {
  const f = await historyFixture(t, { journals: false });
  const locked = f.store.lockedAsync.bind(f.store);
  let admissions = 0;
  t.mock.method(f.store, 'lockedAsync', async (task, options) => {
    if (++admissions <= 2) {
      // Model peer commits invalidating both optimistic preparations. The
      // second CAS reply arrives after the phase's contention window, so a
      // further retry cannot be relied on to reach the locked fallback.
      if (admissions === 2) await new Promise(resolve => setTimeout(resolve, 25));
      throw new ForgeError('WORK_STALE', 'Synthetic peer publication.');
    }
    return locked(task, options);
  });
  t.mock.method(f.store, 'load', () => assert.fail('Fallback must retain selected-record reads'));
  await withWorkLockOptions({ waitMs: 10 }, () =>
    batchEdit(
      f.work,
      f.batch.id,
      data => {
        data.landingBatches.find(batch => batch.id === f.batch.id).timing.selectedAt =
          '2026-10-27T06:00:00.000Z';
      },
      undefined,
      undefined,
      { selectedOnly: true },
    ),
  );
  assert.equal(admissions, 3);
  assert.equal(f.store.select('landingBatches', f.batch.id).timing.selectedAt, '2026-10-27T06:00:00.000Z');
});

test('main audit selection reads only selected records while holding the owner lock', async t => {
  const { randomUUID } = await import('node:crypto');
  const { selectPostAccept } = await import('../dist/post-accept-edit.js');
  const f = await historyFixture(t, { journals: false });
  const checkId = f.store.page('checks', 0, 1).records[0].id;
  const id = randomUUID();
  const view = f.store.select('views', f.store.select('landingEntries', f.batch.entryIds[0]).viewId);
  f.store.locked(() => {
    const tx = f.store.records();
    tx.append('channelMoves', {
      id,
      channel: 'main',
      viewId: view.id,
      head: view.head,
      previous: null,
      status: 'accepted',
      provenance: 'user-declared-local',
      at: new Date().toISOString(),
      postAccept: { checkId, mode: 'full', reason: 'scoped-check' },
    });
    f.store.commitRecords(tx);
  });
  const noLoad = t.mock.method(f.store, 'load', () =>
    assert.fail('Main audit selection must never load whole Work'),
  );
  const selected = await selectPostAccept(f.store);
  assert.equal(selected.view.head, view.head);
  assert.equal(selected.check.id, checkId);
  assert.equal(f.store.select('channelMoves', id).postAcceptAuditRunId, selected.runId);
  const versionAt = WorkRecordTransaction.prototype.versionAt;
  let batchHeaderReads = 0;
  const versionReads = t.mock.method(
    WorkRecordTransaction.prototype,
    'versionAt',
    function (collection, position) {
      if (collection === 'landingBatches') batchHeaderReads++;
      return versionAt.call(this, collection, position);
    },
  );
  const registration = prepareRunRegistration(new WorkStore(f.root), {
    action: 'run-check',
    operationId: selected.runId,
    viewId: selected.view.id,
    expectedHead: selected.view.head,
    checkId,
    expectedDefinition: selected.check.definition,
    expectedEnvironment: checkEnvironment().fingerprint,
  });
  assert.ok(registration?.run, registration?.error?.message ?? 'Main audit registration prepared');
  assert.equal(batchHeaderReads, 0, 'A fresh audit controller must not rediscover unrelated landing history');
  versionReads.mock.restore();
  registration.tx.dispose();
  f.store.locked(() => {
    const tx = f.store.records();
    const failed = { ...registration.run, status: 'failed', exitCode: 1, endedAt: new Date().toISOString() };
    tx.append('runs', failed);
    const move = tx.find('channelMoves', id);
    move.record.postAcceptRunId = failed.id;
    move.record.postAcceptAuditRunId = failed.id;
    tx.replace('channelMoves', move.position, move.record);
    tx.manifest.fields.autonomyPolicy.acceptance.landing = 'optimistic';
    f.store.commitRecords(tx);
  });
  assert.deepEqual(
    await selectPostAccept(f.store),
    { wait: true },
    'A failure published between observation and selection must reach recovery before the drain can report idle',
  );
  noLoad.mock.restore();
  // Remove the synthetic request before fixture teardown; this test covers
  // admission, while the optimistic and integration suites execute audits.
  f.store.locked(() => {
    const tx = f.store.records(),
      move = tx.find('channelMoves', id);
    for (const run of tx.all('runs', 'failed', 'status')) {
      const found = tx.find('runs', run.id);
      delete found.record.mainCheck;
      tx.replace('runs', found.position, found.record);
    }
    delete move.record.postAccept;
    delete move.record.postAcceptAuditRunId;
    delete move.record.postAcceptRunId;
    tx.replace('channelMoves', move.position, move.record);
    f.store.commitRecords(tx);
  });
});

test('selected batch edit includes an explicitly named terminal non-batch run and retains unrelated evidence', async t => {
  const { fixture } = await import('./landing-batch-fixture.mjs');
  const f = await fixture(t, { remote: false });
  const candidate = await f.candidate('non-batch.txt', 'saved\n', false);
  const executed = (await f.agent.dispatch({ action: 'run', viewId: candidate.view.id })).result;
  const id = executed.runId;
  const retained = f.store.select('runs', id);
  const unrelated = { ...retained, id: globalThis.crypto.randomUUID() };
  f.store.locked(() => {
    const tx = f.store.records();
    tx.append('runs', unrelated);
    f.store.commitRecords(tx);
  });
  t.mock.method(f.store, 'load', () => assert.fail('An exact terminal run edit must not load whole Work'));
  await batchEdit(
    f.work,
    'exact-terminal-run',
    data => {
      assert.deepEqual(
        data.runs.map(run => run.id),
        [id],
      );
      const run = data.runs[0];
      assert.deepEqual(run, retained, 'selected replacement starts with complete evidence');
      run.status = 'interrupted';
      run.exitCode = null;
      run.error = { code: 'SYNTHETIC_INFRA', message: 'Selected terminal run interruption' };
    },
    undefined,
    undefined,
    { selectedOnly: true, runs: [id] },
  );
  assert.equal(f.store.select('runs', id).status, 'interrupted');
  assert.deepEqual(f.store.select('runs', unrelated.id), unrelated);
});
