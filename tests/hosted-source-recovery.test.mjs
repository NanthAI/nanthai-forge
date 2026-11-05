// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { waitHostedAgentSource, sourceWaitSnapshot } from '../dist/hosted-agent-source-wait.js';
import { landAnnouncement } from '../dist/hosted-land-wait.js';
import { submitHostedLand } from '../dist/hosted-land-cli.js';

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
    const tools = new Map();
    t.after(
      registerHostedAgentWorkflow(
        {
          registerTool(name, config, call) {
            tools.set(name, { config, call });
          },
        },
        s.transport(),
      ),
    );
    const task = tools.get('forge_task');
    // Parse through the actual registered MCP schema before invoking its handler.
    const next = task.config.inputSchema.command.parse(result.result.next);
    const response = await task.call({ command: next }, { signal: new AbortController().signal });
    assert(!response.isError, response.content[0].text);
    assert.equal(JSON.parse(response.content[0].text).operationId, result.result.next.operationId);
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

test('an admitted pending finish source child waits on the public operation, never a child compose', async t => {
  const s = agentFixture(t);
  s.pending(true);
  const operationId = randomUUID();
  const result = await s.transport().dispatch('finish', { operationId, laneId: s.lane.laneId });
  assert.deepEqual(result.result.next, {
    action: 'wait',
    operationIds: [operationId],
    until: 'acceptance',
  });
  assert.equal(result.result.replayParameters.operationId, operationId);
  assert.equal(result.result.command, result.result.waitCommand);
  assert(!result.result.command.includes(result.result.composeOperationId));
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
  assert.equal(replay.result.waitCommand, undefined);
  assert.equal(replay.result.inProgress, undefined);
  assert(landAnnouncement(s.root, {}, replay).join('\n').includes(replay.result.command));
  assert.equal(replay.result.composeOperationId, first.result.composeOperationId);
  assert.deepEqual(
    s.calls.slice(count).map(call => call.name),
    [
      'projectHostedAgent:capabilities',
      'projectHostedLandingDesired:submit',
      'projectHostedCompose:progress',
      'projectHostedComposeJobs:submit',
    ],
  );
});

test('failed source waits for canonical parent failure before offering a fresh retry', async t => {
  const s = agentFixture(t),
    operationId = randomUUID(),
    jobId = randomUUID();
  s.pending(true);
  const mutation = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) =>
    getFunctionName(ref) === 'projectHostedComposeJobs:submit'
      ? JSON.stringify(dead(jobId, 'failed'))
      : mutation(ref, args);
  const transport = s.transport();
  const err = [],
    write = process.stderr.write;
  process.stderr.write = chunk => {
    err.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = write;
  });
  const first = await submitHostedLand(
    s.root,
    { operationId, laneId: s.lane.laneId },
    s.address,
    transport,
    0,
  );
  assert.equal(first.result.submission.observation.state, 'pending');
  assert.equal(first.result.progress.status, 'failed');
  assert.equal(first.result.next.action, 'wait');
  assert.deepEqual(first.result.next.operationIds, [operationId]);
  assert.equal(first.result.next.operationId, undefined);
  assert.equal(first.result.command, first.result.waitCommand);
  assert(err.join('').includes(first.result.command), 'the announcement reuses the selected canonical root');

  s.exchange.client.mutation = async (ref, args) => {
    const name = getFunctionName(ref);
    if (name !== 'projectHostedLandingDesired:submit') return mutation(ref, args);
    s.calls.push({ name, args });
    return JSON.stringify({
      ...first.result.submission,
      phase: 'terminal-failed',
      observation: { state: 'terminal-failed' },
      error: { code: 'SOURCE_WORKER_FAILED', message: 'Synthetic source failure' },
    });
  };
  const before = s.calls.length;
  const terminal = await transport.dispatch('finish', first.result.replayParameters);
  assert.equal(terminal.result.terminal, true);
  assert.equal(terminal.result.next.action, 'finish');
  assert.equal(terminal.result.next.retry, true);
  assert.equal(terminal.result.next.operationId, undefined);
  assert.equal(terminal.result.waitCommand, undefined);
  assert.equal(terminal.result.progress, undefined);
  assert.equal(s.calls.length - before, 2, 'discovery and original admission only; no old source read');
});

test('source observation reconnects after a transient network error without resubmitting source work', async t => {
  const s = agentFixture(t),
    operationId = randomUUID(),
    jobId = randomUUID();
  let subscriptions = 0,
    closes = 0;
  const original = process.stderr.write;
  const progress = [];
  process.stderr.write = chunk => {
    progress.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });
  const result = await waitHostedAgentSource(
    s.address,
    operationId,
    { status: 'submitted', jobId },
    undefined,
    () => ({
      onUpdate(_ref, _args, update, error) {
        subscriptions++;
        queueMicrotask(() =>
          subscriptions === 1
            ? error(new TypeError('fetch failed synthetic private text'))
            : update({ terminal: { outcome: { status: 'completed', result: 'same operation' } } }),
        );
        return () => {};
      },
      async close() {
        closes++;
      },
    }),
  );
  assert.equal(result.outcome.status, 'completed');
  assert.equal(subscriptions, 2);
  assert.equal(closes, 2);
  assert.equal(s.calls.length, 0, 'no source dispatch or extra HTTP call');
  assert(!progress.join('').includes('private text'));
});
