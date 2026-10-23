// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { acceptanceFixture, pins, landingStore } from './hosted-acceptance-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { landingObservation } from '../dist/hosted-landing.js';
const prior = process.env.FORGE_HOSTED_CHECK_KEY_ID;
test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
});
test.after(() => {
  if (prior === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  else process.env.FORGE_HOSTED_CHECK_KEY_ID = prior;
});
async function compose(c, selection) {
  await c.prepare(selection);
  await c.stage(selection);
  await c.submit(selection);
  return (await c.publish(await c.work(selection))).outcome.result;
}
async function passing(f, candidate) {
  const run = await f.rawChecks.enqueue(
    f.rawChecks.selection({ candidateId: candidate.id, expectedHead: candidate.result.head }),
  );
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  return { kind: 'run', runId: run.id };
}

test('two concurrent exact-run landings preserve both source changes through an explicit named retry after the main race', async () => {
  const c = await composeFixture();
  const a = await c.lane(c.state([c.baseFile, c.hidden, c.file('one.txt', 'one\n')], [c.baseline.sha256]));
  const b = await c.lane(c.state([c.baseFile, c.hidden, c.file('two.txt', 'two\n')], [c.baseline.sha256]));
  const selections = [c.selection([a]), c.selection([b])];
  const candidates = [];
  for (const selection of selections) candidates.push(await compose(c, selection));
  const f = await acceptanceFixture({
    store: c,
    projectId: c.projectId,
    candidate: candidates[0],
    state: { sha256: candidates[0].result.head, size: c.objects.get(candidates[0].result.head).length },
  });
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
  const requests = [];
  for (const [i, candidate] of candidates.entries()) {
    requests.push(
      await f.ready(
        { candidate, pages: selections[i].pages },
        { agent: true, check: await passing(f, candidate) },
      ),
    );
  }
  const outcomes = await Promise.allSettled(requests.map(r => f.accept(r.state)));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled' && r.value.status === 'landed').length, 1);
  const lostIndex = outcomes.findIndex(r => r.status === 'rejected');
  assert(lostIndex >= 0);
  assert.equal(outcomes[lostIndex].reason.data?.code ?? outcomes[lostIndex].reason.code, 'CHANNEL_CHANGED');
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  const lost = requests[lostIndex],
    oldAttempt = (await f.status(lost.state.id)).attempt;
  const firstReceipt = f.currentMain().receipt.id;
  const latest = f.currentMain();
  // H15 will drive this named recompose/recheck. H14 does not silently replace
  // the original Candidate/run or reuse its evidence on another source.
  const retrySelection = c.selection([[a, b][lostIndex]], [], {
    expectedMain: { head: latest.head, receiptId: latest.receipt.id },
  });
  const retryCandidate = await compose(c, retrySelection);
  const retryCheck = await passing(f, retryCandidate);
  const attemptId = randomUUID();
  const attempt = await f.runAcceptance('acceptanceRetryPins', pins.pinLandingAttempt, {
    projectId: f.projectId,
    actor: oldAttempt.actor,
    request: {
      ...lost.request,
      expectedMain: { head: latest.head, receiptId: latest.receipt.id },
      candidateId: retryCandidate.id,
      expectedHead: retryCandidate.result.head,
      check: retryCheck,
    },
    submissionId: lost.state.id,
    attemptId,
    parentAttemptId: oldAttempt.id,
    number: 1,
    at: new Date().toISOString(),
    operations: { check: randomUUID(), accept: randomUUID() },
  });
  await f.runAcceptance(
    'acceptanceRetryInstall',
    async ctx => {
      const { row, state } = await landingStore.loadLanding(ctx, {
        projectId: f.projectId,
        submissionId: lost.state.id,
      });
      await landingStore.insertLandingAttempt(ctx, attempt);
      await landingStore.writeLanding(
        ctx,
        row,
        {
          ...state,
          version: state.version + 1,
          attemptId,
          phase: 'ready',
          observation: landingObservation('queued'),
          error: null,
        },
        false,
      );
    },
    {},
  );
  const retryState = (await f.status(lost.state.id)).request;
  await f.stageAcceptance(retryState, retrySelection.pages);
  const result = await f.accept(retryState);
  assert.equal(result.status, 'landed');
  assert.equal(result.receipt.previous.receiptId, firstReceipt);
  assert.notEqual(result.receipt.check.runId, oldAttempt.check.runId);
  assert.equal(f.tables.projectHostedAcceptances.size, 2);
  assert.equal(f.tables.projectHostedLandingAttempts.size, 3);
  const files = JSON.parse(c.objects.get(f.currentMain().head).toString()).files;
  assert(files.some(x => x.path === 'one.txt'));
  assert(files.some(x => x.path === 'two.txt'));
  assert(files.some(x => x.path === 'hidden.bin'));
  const current = f.currentMain();
  const replay = await f.accept(retryState);
  assert.deepEqual(replay, result);
  assert.deepEqual(f.currentMain(), current);
  assert.equal((await f.enqueue(lost.request)).attemptId, attemptId);
  assert.equal(f.tables.projectHostedCheckRuns.size, 3);
});
