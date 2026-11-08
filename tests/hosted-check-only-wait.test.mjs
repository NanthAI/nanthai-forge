// SPDX-License-Identifier: Apache-2.0
// Issue 17cce1b3: a wait on a check-only landing must never report "no check run" while compose is
// done but the run is not reserved yet; that gap is in progress, the same as every landing step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { ForgeError } from '../dist/errors.js';
import { landWaitContinuation } from '../dist/hosted-land-wait.js';
import { localOperation } from '../dist/hosted-agent-wait-local.js';
import { HostedAgentJournal } from '../dist/hosted-agent-journal.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

/** The server has no landing row for a check-only id; its run is observed as passed. */
function checkOnlyTransport(t, s) {
  const transport = s.transport();
  const query = transport.query.bind(transport),
    dispatch = transport.dispatch.bind(transport);
  transport.dispatch = async (action, input) =>
    action === 'observe' && input.runId
      ? {
          schema: 1,
          transport: 'hosted',
          action: 'observe',
          operationId: null,
          resolved: null,
          result: { id: input.runId, projectId: s.address.projectId, status: 'passed' },
        }
      : dispatch(action, input);
  transport.query = async (name, args) => {
    if (name === 'projectHostedFinishObserve:page')
      throw new ForgeError('NOT_FOUND', 'Select one hosted landing operation.');
    return query(name, args);
  };
  const oldExit = process.exitCode;
  t.after(() => {
    process.exitCode = oldExit;
  });
  return transport;
}
const enqueues = s => s.calls.filter(call => call.name === 'projectHostedChecks:enqueue').length;

test('a check-only finish whose submit already published the compose reserves its run in the same call', async t => {
  const s = agentFixture(t),
    transport = s.transport();
  await transport.dispatch('open', { laneId: s.lane.laneId });
  // source-run-publish: the submit action replies `{terminal, state}` once its step published.
  const mutation = transport.mutation.bind(transport);
  transport.mutation = async (name, args) => {
    const value = await mutation(name, args);
    return name === 'projectHostedComposeJobs:submit' && value?.outcome
      ? { terminal: value, state: {} }
      : value;
  };
  const submitted = await transport.dispatch('finish', { laneId: s.lane.laneId, accept: false });
  assert.equal(submitted.result.phase, 'check', 'a published compose is complete: no compose-phase stop');
  assert.equal(typeof submitted.result.run.id, 'string');
  assert.equal(enqueues(s), 1);
  const submit = s.calls.findIndex(call => call.name === 'projectHostedComposeJobs:submit');
  assert.deepEqual(
    s.calls.slice(submit + 1).filter(call => call.name === 'projectHostedCompose:progress'),
    [],
    'the published reply is the outcome: no progress read or wait after the submit',
  );
});

test('wait across the compose -> reserve gap is in progress, then follows the reserved run', async t => {
  const s = agentFixture(t),
    transport = checkOnlyTransport(t, s);
  await transport.dispatch('open', { laneId: s.lane.laneId });
  // The compose outlives land's budget: the receipt stops at compose with a waitable id.
  s.pending(true);
  transport.waitUntil = Date.now();
  const submitted = await transport.dispatch('finish', { laneId: s.lane.laneId, accept: false });
  assert.equal(submitted.result.phase, 'compose');
  assert.equal(submitted.result.run, undefined);
  const resume = landWaitContinuation(s.root, submitted);
  assert(resume, 'the exit-3 receipt names a wait');
  assert.deepEqual(resume.next.operationIds, [submitted.operationId]);
  const wait = () =>
    hostedAgentCli(
      s.root,
      'wait',
      { operationIds: [submitted.operationId], until: 'acceptance', timeoutSeconds: 0 },
      s.address,
      transport,
    );
  // Still composing: in progress (the same wait), never "no check run".
  const still = await wait();
  assert.notEqual(still.result.status, 'terminal', JSON.stringify(still.result));
  assert.doesNotMatch(JSON.stringify(still.result), /no check run/);
  assert.equal(process.exitCode, 3, 'IN PROGRESS');
  assert.deepEqual(still.result.next?.operationIds, [submitted.operationId], 'the same wait resumes it');
  assert.equal(enqueues(s), 0);
  // Compose done, run not reserved yet: the wait reserves it by replay and follows that run.
  s.pending(false);
  const done = await wait();
  assert.equal(done.result.status, 'terminal', JSON.stringify(done.result));
  assert.equal(done.result.run.status, 'passed');
  process.exitCode = undefined;
  assert.equal(enqueues(s), 1);
  // A repeat follows the same run (now recorded), never a second reservation.
  const again = await wait();
  assert.equal(again.result.run.id, done.result.run.id);
  assert.equal(enqueues(s), 1);
});

test('a check-only finish still in source preparation (save or compose) is a finish to continue, not "no run"', async t => {
  const s = agentFixture(t);
  const command = { laneId: s.lane.laneId, accept: false };
  const journal = new HostedAgentJournal(s.root, s.address, 'owner', 'finish', command);
  await journal.retain('finish-context', () => ({ command, clean: null }));
  assert.deepEqual(localOperation(s.root, journal.operationId), { kind: 'finish', command });
  // Ended before any run: only then is "no check run" the answer.
  await journal.retain('finish-source-failed', () => true);
  assert.deepEqual(localOperation(s.root, journal.operationId), { kind: 'check-only' });
});

test('a land receipt stopped in save or compose carries its wait when only its progress says submitted', () => {
  const operationId = randomUUID();
  for (const phase of ['save', 'compose']) {
    const resume = landWaitContinuation('/fixture/lane', {
      operationId,
      result: { phase, progress: { status: 'submitted', jobId: randomUUID() } },
    });
    assert.deepEqual(resume?.next.operationIds, [operationId], phase);
  }
  // Retryable or failed source keeps its own recovery.
  assert.equal(
    landWaitContinuation('/fixture/lane', {
      operationId,
      result: { phase: 'compose', progress: { status: 'retryable', jobId: randomUUID() } },
    }),
    undefined,
  );
});
