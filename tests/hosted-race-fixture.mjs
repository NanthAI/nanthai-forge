// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { hostedAcceptanceSchema } from '../dist/hosted-acceptance.js';

/** Shared main-race helpers for hosted finish fixtures. */
const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
export function useSyntheticHostedEnv(test) {
  const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
  test.before(() => Object.assign(process.env, synthetic));
  test.after(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}
export async function passWithSelection(f, id, selection) {
  const prepared = await f.rawChecks.prepare(id, 2, { selection });
  await f.rawChecks.control(id, { kind: 'reserve', owner: prepared.owner, token: prepared.token });
  const running = await f.rawChecks.control(id, {
    kind: 'observe',
    owner: prepared.owner,
    token: prepared.token,
    result: { status: 'accepted', executionId: 'synthetic-passed-full' },
  });
  await f.rawChecks.pass(running.run);
  return f.rawChecks.status(id);
}
export async function seedFullMain(f, selection, previousMain = f.main) {
  const main = f.currentMain();
  const item = await f.makeCandidate([], [], {
    result: { status: 'clean', head: main.head },
    base: { head: previousMain.head, receiptId: previousMain.receipt.id },
  });
  const queued = await f.rawChecks.enqueue(
    f.rawChecks.selection({
      candidateId: item.candidate.id,
      expectedHead: main.head,
      expectedConfiguration: f.rawChecks.configuration.digest,
    }),
  );
  const run = await passWithSelection(f, queued.id, selection);
  const candidateRow = [...f.tables.projectHostedRecords.values()].find(row => row.key === item.candidate.id);
  const id = main.receipt.id;
  const receipt = hostedAcceptanceSchema.parse({
    schema: 1,
    id,
    projectId: f.projectId,
    channel: 'main',
    submissionId: randomUUID(),
    operationId: randomUUID(),
    attemptId: randomUUID(),
    at: new Date().toISOString(),
    authorityEpoch: 1,
    previous: { head: previousMain.head, receiptId: previousMain.receipt.id },
    candidate: {
      id: item.candidate.id,
      digest: candidateRow.digest,
      head: main.head,
      inputs: item.candidate.inputs,
      dependencies: item.candidate.dependencies,
      algorithm: item.candidate.algorithm,
    },
    actor: { kind: 'agent', id: 'owner' },
    policyDigest: 'a'.repeat(64),
    check: {
      runId: run.id,
      checkId: run.check.id,
      definition: run.check.definition,
      configuration: run.request.expectedConfiguration,
      environment: run.request.expectedEnvironment,
      terminalDigest: run.terminalDigest,
      planDigest: run.planDigest,
      executionId: run.executionId,
    },
    snapshot: { id, previousId: previousMain.snapshotId, revision: previousMain.sourceRevision + 1 },
    completion: { root: 'b'.repeat(64), pages: 0, lanes: 0, enabled: false },
    automatic: true,
    undo: { kind: 'revert', receiptId: id },
  });
  f.insert('projectHostedAcceptances', {
    projectId: f.projectId,
    receiptId: id,
    submissionId: receipt.submissionId,
    attemptId: receipt.attemptId,
    sequence: receipt.snapshot.revision,
    value: JSON.stringify(receipt),
  });
  f.patch('projectHostedChannels', f.mainId, {
    selection: JSON.stringify({ ...main, snapshotId: id, sourceRevision: receipt.snapshot.revision }),
  });
  return run;
}
