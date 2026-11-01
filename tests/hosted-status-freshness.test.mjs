// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { readFileSync } from 'node:fs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { enrichHostedQueueAhead } from '../dist/queue-ahead-hosted.js';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
import { queuedConflict } from '../dist/hosted-agent-finish.js';
const deferred = () => {
  let resolve;
  return {
    promise: new Promise(r => {
      resolve = r;
    }),
    resolve: (...args) => resolve(...args),
  };
};
const selection = () => ({
  main: 'a'.repeat(64),
  mine: 'b'.repeat(64),
  more: false,
  ahead: [
    {
      id: randomUUID(),
      head: 'c'.repeat(64),
      inputs: { sha256: 'd'.repeat(64), size: 1 },
      status: 'checking',
    },
  ],
});

test('finite status advice is cache-only: a cold selection performs zero source or Convex calls', t => {
  const f = agentFixture(t);
  let downloads = 0;
  f.exchange.downloadBatch = async () => {
    downloads++;
    throw Error('status must never download advice');
  };
  const before = f.calls.length;
  const snapshot = { submission: { phase: 'queued' }, queueAheadSelection: selection() };
  const result = enrichHostedQueueAhead(f.transport(), snapshot);
  assert.equal(typeof result?.then, 'undefined', 'cache attachment has no asynchronous critical path');
  assert.equal(result.submission, snapshot.submission);
  assert.equal(result.queueAheadUnavailable, true);
  assert.equal(downloads, 0);
  assert.equal(f.calls.length, before);
});

for (const action of ['observe', 'status', 'landing']) {
  test(`${action}: incident replay settles on the server while a client read is in flight`, async t => {
    const f = agentFixture(t);
    const operationId = randomUUID();
    const admitted = await f
      .transport()
      .dispatch('finish', { operationId, laneId: f.lane.laneId, message: 'Synthetic queued work' });
    const queued = admitted.result.submission;
    const entered = deferred(),
      release = deferred();
    const original = f.exchange.client.query;
    let readCalls = 0,
      downloads = 0;
    f.exchange.client.query = async (ref, args) => {
      if (getFunctionName(ref) === 'projectHostedFinishObserve:page') {
        readCalls++;
        entered.resolve();
        await release.promise;
        const value = JSON.parse(await original(ref, args));
        return JSON.stringify({ ...value, queueAheadSelection: selection() });
      }
      return original(ref, args);
    };
    f.exchange.downloadBatch = async () => {
      downloads++;
      await new Promise(() => {});
    };
    const pending = f.transport().dispatch(action, { operationId });
    await entered.promise;
    f.operations.set(operationId, {
      ...queued,
      phase: 'terminal-failed',
      version: queued.version + 1,
      observation: { state: 'terminal-failed', pendingReason: null, cause: 'conflict' },
      error: { code: 'COMPOSITION_CONFLICT', message: 'Synthetic settlement during read' },
    });
    // Keep conflict metadata local to this test; the terminal state must survive
    // even when no Candidate path advice can be attached.
    const settled = f.operations.get(operationId);
    release.resolve();
    // Canonical terminal conflict advice is a separate bounded metadata path.
    // Stub its exact status/Candidate lookup without source work.
    f.exchange.client.query = async (ref, args) => {
      const name = getFunctionName(ref);
      if (name === 'projectHostedLanding:status')
        return JSON.stringify({ request: settled, attempt: { candidate: { id: f.candidate.id } } });
      if (name === 'projectHostedCompose:candidate') return JSON.stringify(f.candidate);
      return original(ref, args);
    };
    const response = await pending;
    assert.equal(response.result.submission.phase, 'terminal-failed');
    assert.equal(response.result.submission.error.code, 'COMPOSITION_CONFLICT');
    assert.equal(readCalls, 1);
    assert.equal(downloads, 0);
    assert.equal(response.result.submission.id, queued.id);
  });
}

test('enqueue replay uses the refreshed canonical submission, never the stale pre-read receipt', async () => {
  const pending = { id: randomUUID(), phase: 'queued', error: null };
  const settled = { ...pending, phase: 'terminal-failed', error: { code: 'COMPOSITION_CONFLICT' } };
  const result = await queuedConflict(
    { query: async () => ({ request: settled, queue: null, queuePosition: null }) },
    pending,
  );
  assert.deepEqual(result.submission, settled);
  assert.equal(result.queuePosition, null);
});

test('finite wait receipts preserve current queue and early conflict metadata without source advice', async t => {
  const f = agentFixture(t),
    operationId = randomUUID();
  await f
    .transport()
    .dispatch('finish', { operationId, laneId: f.lane.laneId, message: 'Synthetic wait metadata' });
  const query = f.exchange.client.query;
  const queue = { position: 3, total: 7, entriesAhead: 2, message: 'Queued, position 3 of 7' };
  const wouldConflict = { paths: ['synthetic.ts'], next: 'sync-and-land' };
  f.exchange.client.query = async (ref, args) => {
    const value = await query(ref, args);
    return getFunctionName(ref) === 'projectHostedFinishObserve:page'
      ? JSON.stringify({ ...JSON.parse(value), queue, wouldConflict })
      : value;
  };
  const result = await observeHostedSubmissions(f.transport(), {
    operationIds: [operationId],
    timeoutSeconds: 0,
  });
  assert.deepEqual(result.result.submissions[0].queue, queue);
  assert.deepEqual(result.result.submissions[0].wouldConflict, wouldConflict);
});

test('verify guard: finite response and bound hosted read may attach cached advice but never call preview composition', () => {
  for (const file of ['src/hosted-agent-transport.ts', 'src/hosted-agent-bound-read.ts']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert(!/await\s+enrichHostedQueueAhead/.test(source), file);
    assert(!/\bhostedQueueAhead\(/.test(source), file);
  }
  const enrichment = readFileSync(new URL('../src/queue-ahead-hosted.ts', import.meta.url), 'utf8').split(
    'export function enrichHostedQueueAhead',
  )[1];
  assert(enrichment);
  assert(!/\bawait\b|hostedQueueAhead\(|download|composeQueueAhead\(/.test(enrichment));
});
