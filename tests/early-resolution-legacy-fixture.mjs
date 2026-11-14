// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { batchesFixture, states } from './hosted-landing-batches-fixture.mjs';
import { syncFixture } from './hosted-sync-fixture.mjs';
import { compose } from './hosted-finish-fixture.mjs';
import { drainReady, retainLegacyCleanSync } from './early-resolution-replay.mjs';

export async function internalConflict(t, beforeCompose) {
  const f = await batchesFixture(t, {
    count: 0,
    batchMaxSize: 3,
    fileCount: 2,
    baselineFiles: [['shared.txt', 'alpha\nmiddle\nomega\n']],
    memberPaths: ['root.txt', 'shared.txt', 'shared.txt'],
    memberContents: ['root', 'alpha-a\nmiddle\nomega\n', 'alpha-c\nmiddle\nomega-c\n'],
  });
  const OriginalDate = Date,
    clock = Date.now;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [clock()]));
    }
    static now() {
      return clock();
    }
  };
  t.after(() => {
    globalThis.Date = OriginalDate;
  });
  await f.add(0);
  await drainReady(f);
  await f.add(1);
  await f.add(2);
  await beforeCompose?.(f);
  await drainReady(f);
  return f;
}

/** Hydrate only the historical clean-sync/side-branch metadata. The merges, source jobs,
 * checks, cancellation, retry, sync, resolve and acceptance all use production controllers. */
export async function legacySideBranch(t) {
  const f = await internalConflict(t);
  const root = states(f)[0];
  const rootAttempt = [...f.tables.projectHostedLandingAttempts.values()]
    .map(r => JSON.parse(r.value))
    .find(a => a.id === root.attemptId);
  const predecessor = {
    submissionId: root.id,
    head: rootAttempt.candidate.head,
    receiptId: rootAttempt.operations.accept,
  };
  const s = await syncFixture({ store: { ...f.c, call: (name, fn, args) => f.tx(name, fn, args) } });
  const original = f.entries[2].lane;
  const lane = await retainLegacyCleanSync({ f, s, original, predecessor });
  const selection = f.c.selection([lane]);
  selection.request.expectedMain = { head: f.currentMain().head, receiptId: f.currentMain().receipt.id };
  const candidate = await compose(f.c, selection);
  const request = f.request({
    candidateId: candidate.id,
    expectedHead: candidate.result.head,
    expectedMain: selection.request.expectedMain,
    governanceVersion: 1,
    finish: { composeOperationId: selection.request.operationId, after: null },
  });
  const state = await f.enqueue(request);
  for (let n = 0; n < 100; n++) {
    const member = (await f.current(state.id)).submission;
    if (member.batchId) {
      const row = [...f.tables.projectHostedLandingBatches.values()].find(r => r.batchId === member.batchId);
      f.patch('projectHostedLandingBatches', row._id, {
        value: JSON.stringify({ ...JSON.parse(row.value), predecessor }),
      });
      break;
    }
    const task = f.pending().find(t => !/LandingStall|CheckLease:expire/.test(t.name));
    assert(task, 'legacy cohort reserved before source work');
    await f.execute(task);
  }
  await drainReady(f);
  const run = f.runs().find(r => r.request.expectedHead === candidate.result.head);
  assert(run, 'retained side branch has its original check');
  return { f, s, lane, selection, candidate, request, state, run };
}
