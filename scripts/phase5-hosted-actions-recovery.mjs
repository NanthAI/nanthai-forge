// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HostedCheckoutDownloads } from '../dist/hosted-checkout-downloads.js';
import { cloneHostedProject } from '../dist/hosted-clone-cli.js';
import { nativeOwner, NativeSource } from '../dist/native-source.js';
import { foldHostedRecoveryCache, hostedRecoveryRows } from '../dist/recovery-hosted.js';
import { deleteHostedProject } from '../dist/host-delete.js';
import { saveActionsDrillLane } from './phase5-hosted-actions-context.mjs';

export async function waitForCancellationCheck(context, finishOperationId, submissionId) {
  await context.waitSelected(
    'projectHostedFinishObserve:page',
    { operationId: finishOperationId, nextVersion: 0 },
    value => !value.submission.preparing,
  );
  // Batch membership may return to queued while its selected check runs.
  return context.waitSelected(
    'projectHostedLanding:status',
    { submissionId },
    value => !!value.attempt.check,
  );
}

export async function finalizeActionsDrill(context) {
  const { report, directory, address, exchange, step, query, agent, save, waitSelected } = context;
  report.finalizationRoot ??= join(directory, `finalization-${randomUUID()}`);
  const finalizationRoot = report.finalizationRoot;
  mkdirSync(finalizationRoot, { recursive: true });
  save();
  const current = await query('projectHostedChannels:current');
  const clone = async root => {
    const ex = exchange(),
      downloads = new HostedCheckoutDownloads(ex);
    return cloneHostedProject(root, address, {
      current: () => ex.current(),
      objects: ids => downloads.objects(ids),
      downloadToFile: (pin, path) => downloads.downloadToFile(pin, path),
      downloadFiles: files => downloads.downloadFiles(files),
    });
  };
  await step('clone accepted main and compare source and acceptance pins', async () => {
    const root = join(finalizationRoot, 'accepted-clone');
    report.cloned = await clone(root);
    assert.equal(report.cloned.head, current.head);
    assert.deepEqual(report.cloned.receipt, current.receipt);
    assert.equal(readFileSync(join(root, 'q4.txt'), 'utf8'), 'Q4 saved before Mac offline\n');
  });
  await step('cancel and abandon disposable scratch work', async () => {
    const root = join(finalizationRoot, 'cancel-mac');
    const cancelBytes = `Q4 retained cancelled source ${randomUUID()}\n`;
    const started = await agent(root).dispatch('start', {
      operationId: randomUUID(),
      outcome: 'Q4 cancelled work',
    });
    const laneId = started.result.lane.laneId;
    await agent(root).dispatch('open', { operationId: randomUUID(), laneId });
    writeFileSync(join(root, 'q4-cancel.txt'), cancelBytes);
    await saveActionsDrillLane(context, root, {
      operationId: randomUUID(),
      laneId,
      message: 'Q4 cancel source',
    });
    const finishOperationId = randomUUID();
    const finish = await agent(root).dispatch('finish', {
      operationId: finishOperationId,
      laneId,
      message: 'Q4 cancelled finish',
      accept: true,
      check: { checkId: report.checkId },
    });
    const submissionId = finish.result.submission.id;
    report.cancelWork = { root, laneId, finishOperationId, submissionId, cancelBytes };
    save();
    const selected = await waitForCancellationCheck(context, finishOperationId, submissionId);
    const runId = selected.attempt.check.runId;
    const cancel = await agent(root).dispatch('cancel', { operationId: randomUUID(), submissionId });
    assert.equal(cancel.result.phase, 'terminal-failed');
    await agent(root).dispatch('abandon', {
      operationId: randomUUID(),
      laneId,
      reason: 'Q4 disposable work',
    });
    const lane = await query('projectHostedLanes:detail', { laneId });
    assert.equal(lane.state, 'abandoned');
    const completed = await waitSelected(
      'projectHostedCheckRead:status',
      { runId },
      value => !['queued', 'preparing', 'dispatching', 'running', 'unknown'].includes(value.status),
    );
    const after = await query('projectHostedLanding:status', { submissionId });
    assert.equal(after.request.phase, 'terminal-failed');
    assert.deepEqual(await query('projectHostedChannels:current'), current);
    assert.equal(readFileSync(join(root, 'q4-cancel.txt'), 'utf8'), cancelBytes);
    report.cancelled = {
      laneId,
      laneState: lane.state,
      submissionId,
      runId,
      runStatus: completed.status,
      phase: after.request.phase,
    };
  });
  await recoverActionsDrillCache(context);
  report.result = 'passed';
  save();
}
export async function recoverActionsDrillCache(context) {
  const { report, address, exchange, step, query, save } = context;
  const finalizationRoot = report.finalizationRoot;
  const current = await query('projectHostedChannels:current');
  assert.equal(current.head, report.cloned.head);
  assert.deepEqual(current.receipt, report.cloned.receipt);
  const clone = async root => {
    const ex = exchange(),
      downloads = new HostedCheckoutDownloads(ex);
    return cloneHostedProject(root, address, {
      current: () => ex.current(),
      objects: ids => downloads.objects(ids),
      downloadToFile: (pin, path) => downloads.downloadToFile(pin, path),
      downloadFiles: files => downloads.downloadFiles(files),
    });
  };
  await step('recover source and receipt-preserving hosted cache', async () => {
    const root = join(finalizationRoot, 'recovered-cache');
    await clone(root);
    report.recoveryOperationId ??= randomUUID();
    save();
    const operationId = report.recoveryOperationId;
    const { selection } = await query('projectRecovery:prepare', { operationId });
    assert.equal(selection.hostedMain.head, current.head);
    const journal = join(finalizationRoot, 'recovery-journal');
    mkdirSync(journal, { recursive: true });
    const ex = exchange(operationId);
    const transport = Object.assign(ex, {
      hostedPage: (selected, table, cursor) =>
        query('projectRecoveryHosted:page', { selection: JSON.stringify(selected), table, cursor }),
    });
    const recovered = await foldHostedRecoveryCache(journal, root, selection, transport);
    assert.equal(nativeOwner(root), null);
    assert.equal(recovered.main.head, current.head);
    assert.deepEqual(recovered.main.receipt, current.receipt);
    const source = new NativeSource(root);
    const acceptances = [...hostedRecoveryRows(source, recovered, 'projectHostedAcceptances')];
    for (const entry of report.cases)
      assert.equal(acceptances.filter(row => row.receiptId === entry.evidence.receipt.receiptId).length, 1);
    const requests = [...hostedRecoveryRows(source, recovered, 'projectHostedLandingRequests')].map(row =>
      JSON.parse(row.value),
    );
    assert.equal(requests.filter(row => !['landed', 'terminal-failed'].includes(row.phase)).length, 0);
    report.recovered = {
      head: recovered.main.head,
      receipt: recovered.main.receipt,
      rows: recovered.rows,
      bytes: recovered.bytes,
      counts: recovered.counts,
      stranded: 0,
      receipts: acceptances.length,
    };
  });
  report.result = 'passed';
  delete report.errorCode;
  save();
}
export async function cleanupActionsDrill(context) {
  const { directory, report, client, step, save } = context;
  const deleted = await step('normal scratch deletion and tombstone confirmation', () =>
    deleteHostedProject(
      join(directory, 'seed-owner'),
      {
        projectId: report.project.projectId,
        deployment: context.address.url,
        confirm: new URL(report.project.projectUrl).pathname.split('/').at(-1),
        allowBoundProject: true,
      },
      { client, pollAttempts: 40, pollIntervalMs: 500 },
    ),
  );
  assert(deleted.purgeComplete);
  report.cleanup = 'deleted';
  report.cleanupProof = { operationId: deleted.operationId, project: deleted.project };
  save();
}
