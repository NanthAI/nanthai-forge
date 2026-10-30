// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { waitHostedAgentSource, sourceWaitSnapshot } from '../dist/hosted-agent-source-wait.js';

const dead = (jobId, status = 'retryable') => ({
  status,
  jobId,
  failedPhase: 'source-step:17',
  source: { jobId, status: 'running', phase: 'source-step:17', workerUntil: Date.now() + 60000 },
  error: { code: 'SOURCE_WORKER_STEP_FAILED', message: 'Synthetic worker stopped.' },
});

test('source failure closes the exact active wait immediately and retains useful progress', async t => {
  const s = agentFixture(t),
    operationId = randomUUID(),
    jobId = randomUUID();
  let closed = 0,
    unsubscribed = 0;
  const result = await waitHostedAgentSource(
    s.address,
    operationId,
    { status: 'submitted', jobId },
    undefined,
    () => ({
      onUpdate(_ref, args, update) {
        assert.equal(args.operationId, operationId);
        queueMicrotask(() =>
          update({
            ...dead(jobId),
            state: { status: 'submitted' },
            input: { private: 'input must not leak into reply' },
            terminal: null,
          }),
        );
        return () => unsubscribed++;
      },
      async close() {
        closed++;
      },
    }),
  );
  assert.equal(result.status, 'retryable');
  assert.equal(result.failedPhase, 'source-step:17');
  assert.equal(result.error.code, 'SOURCE_WORKER_STEP_FAILED');
  assert(!('state' in result));
  assert(!('input' in result));
  assert.deepEqual([closed, unsubscribed], [1, 1]);
  const immediate = await waitHostedAgentSource(s.address, operationId, result, undefined, () =>
    assert.fail('a known dead job never waits'),
  );
  assert.deepEqual(immediate, result);
});

test('wall time alone turns the latest retained lease into a retryable deadline reply', () => {
  const jobId = randomUUID();
  const latest = {
    status: 'submitted',
    jobId,
    source: { status: 'running', phase: 'source-step:9', workerUntil: 1000 },
  };
  assert.equal(sourceWaitSnapshot(latest, 999).status, 'submitted');
  const stopped = sourceWaitSnapshot(latest, 1000);
  assert.equal(stopped.status, 'retryable');
  assert.equal(stopped.failedPhase, 'source-step:9');
  assert.equal(stopped.error.code, 'SOURCE_JOB_STALLED');
  const completed = { terminal: { outcome: { status: 'completed', result: 'retained' } }, ...latest };
  assert.equal(sourceWaitSnapshot(completed, 1001).outcome.result, 'retained');
});

for (const status of ['submitted', 'retryable', 'failed'])
  test(`CLI/MCP ${status} reply retains exact normalized replay command and operation`, async t => {
    const s = agentFixture(t),
      operationId = randomUUID(),
      jobId = randomUUID();
    const original = s.exchange.client.mutation;
    s.exchange.client.mutation = async (ref, args) => {
      if (getFunctionName(ref) === 'projectHostedComposeJobs:submit')
        return JSON.stringify(dead(jobId, status));
      return original(ref, args);
    };
    const command = { laneId: s.lane.laneId, operationId, message: "Keep 'quoted' input" };
    const result = await s.transport().dispatch('compose', command);
    assert.equal(result.result.status, status);
    assert.equal(result.result.replay.operationId, operationId);
    assert.equal(result.result.replay.action, 'compose');
    assert.equal(result.result.replay.url, s.address.url);
    assert.match(result.result.replay.command, /nforge agent .* compose /);
    assert(result.result.replay.command.includes(operationId));
    assert.equal(result.result.failedPhase, 'source-step:17');
    if (status !== 'failed') assert.equal(result.result.next.operationId, operationId);
    else assert.notEqual(result.result.next.operationId, operationId);
    const again = await s.transport().dispatch('compose', command);
    assert.equal(
      again.result.next.operationId,
      result.result.next.operationId,
      'terminal advice is retained, never a fresh UUID on each replay',
    );
    const journal = JSON.parse(readFileSync(join(`${s.root}.forge-client`, 'agent', `${operationId}.json`)));
    assert.equal(JSON.parse(journal.identity).command.message, command.message);
    s.allow(false);
    await assert.rejects(s.transport().dispatch('compose', command), { code: 'PROJECT_UNAVAILABLE' });
  });

test('pending finish source child returns the public finish replay, never a child compose command', async t => {
  const s = agentFixture(t);
  s.pending(true);
  const operationId = randomUUID();
  const result = await s.transport().dispatch('finish', { operationId, laneId: s.lane.laneId });
  assert.equal(result.result.replay.action, 'finish');
  assert.equal(result.result.replay.operationId, operationId);
  assert.match(result.result.command, / finish /);
});

test('replaying a preparing finish reconciles its stalled compose child and exposes the same public operation', async t => {
  const s = agentFixture(t);
  s.pending(true);
  const operationId = randomUUID();
  const command = { operationId, laneId: s.lane.laneId };
  const first = await s.transport().dispatch('finish', command);
  const jobId = first.result.progress.jobId;
  const query = s.exchange.client.query,
    mutation = s.exchange.client.mutation;
  s.exchange.client.query = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name !== 'projectHostedCompose:progress') return query(ref, args);
    s.calls.push({ name, args });
    assert.equal(args.operationId, first.result.composeOperationId);
    return JSON.stringify({ ...dead(jobId), terminal: null });
  };
  s.exchange.client.mutation = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name !== 'projectHostedComposeJobs:submit') return mutation(ref, args);
    s.calls.push({ name, args });
    assert.equal(args.operationId, first.result.composeOperationId);
    return JSON.stringify(dead(jobId));
  };
  const count = s.calls.length;
  const replay = await s.transport().dispatch('finish', command);
  assert.equal(replay.operationId, operationId);
  assert.equal(replay.result.status, 'retryable');
  assert.equal(replay.result.failedPhase, 'source-step:17');
  assert.equal(replay.result.next.operationId, operationId);
  assert.equal(replay.result.next.action, 'finish');
  assert.equal(replay.result.composeOperationId, first.result.composeOperationId);
  assert.deepEqual(
    s.calls.slice(count).map(call => call.name),
    [
      'projectHostedAgent:capabilities',
      'projectHostedCompose:progress',
      'projectHostedComposeJobs:submit',
      'projectHostedLandingDesired:submit',
    ],
  );
});
