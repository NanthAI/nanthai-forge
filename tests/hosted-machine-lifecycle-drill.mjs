// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, api } from './hosted-finish-fixture.mjs';

export const machineInterruptions = [
  { name: 'restart', offlineMs: 0 },
  { name: 'sleep', offlineMs: 30 * 60_000 },
  { name: 'wifi-loss', offlineMs: 10 * 60_000 },
];

/** Provider IO is fake; the queue, checks, acceptance and repair are production handlers.
 * Advancing time models a disconnected client, not a suspended hosted scheduler. */
export async function hostedMachineLifecycleDrill(t, interruption, history = false) {
  const start = performance.now();
  const f = await finishFixture(t, { fileCount: history ? 2538 : 3 });
  if (history) {
    // Twice the recorded dogfood acceptance history. These unrelated receipts
    // must not enter a selected finish or its reconnect repair read set.
    for (let i = 0; i < 1150; i++)
      f.insert('projectHostedAcceptances', {
        projectId: f.projectId,
        receiptId: randomUUID(),
        submissionId: randomUUID(),
        attemptId: randomUUID(),
        sequence: 1000 + i,
        value: JSON.stringify({ syntheticHistory: true }),
      });
    for (let i = 0; i < 32000; i++) f.c.put(`unrelated synthetic object ${i}`);
  }
  const begin = f.counts.length;
  const request = f.request();
  const submission = await f.enqueue(request);
  await f.drain();
  assert.equal((await f.current(submission.id)).submission.phase, 'checking');
  const runIds = [...f.tables.projectHostedCheckRuns.keys()];
  assert.equal(runIds.length, 1);
  const active = await f.rawChecks.activate(
    JSON.parse([...f.tables.projectHostedCheckRuns.values()][0].value).id,
  );
  assert.equal(active.status, 'running');
  // The requesting Mac disappears while the hosted check is running. Its
  // independent provider completes without any client status/resume calls.
  const countBeforeOffline = f.counts.length;
  f.advanceClock(interruption.offlineMs);
  assert.equal(f.counts.length, countBeforeOffline, 'disconnection makes no client calls');
  await f.rawChecks.pass(active);
  const passed = [...f.tables.projectHostedCheckRuns.values()].map(row => row.value);
  assert.equal(JSON.parse(passed[0]).status, 'passed');
  if (interruption.name === 'restart') {
    // Kill the acceptance driver after its durable step. The replacement
    // invocation sees only retained server records, never a client journal.
    while (f.pending()[0]?.name !== 'projectHostedFinishDriver:drive') await f.execute();
    await assert.rejects(f.execute(f.pending()[0], 'after-step'), /synthetic crash/);
    await f.tx('machineRestartResume', api.resume, { projectId: f.projectId, submissionId: submission.id });
  }
  await f.drain();
  const landed = (await f.current(submission.id)).submission;
  assert.equal(landed.phase, 'landed');
  assert.deepEqual([...f.tables.projectHostedCheckRuns.keys()], runIds, 'no new check run');
  assert.deepEqual(
    [...f.tables.projectHostedCheckRuns.values()].map(row => row.value),
    passed,
  );
  const receiptCount = f.tables.projectHostedAcceptances.size;
  assert.equal(receiptCount, history ? 1151 : 1);
  const main = f.currentMain();
  // A fresh process/root can reconnect with the original public operation pins.
  // Repeated delivery must preserve the actual acceptance, even after completion.
  assert.deepEqual(await f.enqueue(request), landed);
  await f.tx('machineReconnectResume', api.resume, { projectId: f.projectId, submissionId: submission.id });
  await f.drain();
  assert.deepEqual(f.currentMain(), main);
  assert.equal(f.tables.projectHostedAcceptances.size, receiptCount);
  assert.equal(f.pending().length, 0, 'no stranded entry or idle repair task');
  const counts = f.counts.slice(begin);
  return {
    synthetic: true,
    interruption,
    files: history ? 2538 : 3,
    unrelatedObjects: history ? 32000 : 0,
    retainedAcceptances: history ? 1150 : 0,
    functionTransactions: counts.length,
    documentsRead: counts.reduce((sum, count) => sum + count.documents, 0),
    documentsWritten: counts.reduce((sum, count) => sum + count.writes, 0),
    maxDocumentsPerTransaction: Math.max(...counts.map(count => count.documents)),
    peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024),
    wallMs: Math.round(performance.now() - start),
    receiptId: landed.acceptance.receiptId,
    metrics: {
      5.3: { submitted: 1, landed: 1, stranded: 0 },
      5.5: { reconnectRepairs: interruption.name === 'restart' ? 1 : 0, queueNudges: 0 },
      5.6: { checkRuns: 1, repeatedPassedChecks: 0 },
    },
  };
}
