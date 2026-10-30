// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { finishFixture, api } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
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
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const turn = () => new Promise(resolve => setImmediate(resolve));
function client(f) {
  const subscriptions = new Map(),
    events = [];
  let opens = 0,
    closes = 0,
    calls = 0;
  const transport = {
    address: { url: 'https://fixture.invalid', projectId: f.projectId },
    async dispatch() {
      return {
        schema: 1,
        transport: 'hosted',
        action: 'capabilities',
        operationId: null,
        result: { actor: 'owner' },
      };
    },
    async query(name, args) {
      calls++;
      return JSON.parse(
        await f.tx(
          name.endsWith(':page') ? 'finishWaitPage' : 'finishWaitInputs',
          name.endsWith(':page') ? observe.page : api.inputs,
          { ...args, projectId: f.projectId },
        ),
      );
    },
  };
  const subscribe = () => {
    opens++;
    return {
      onUpdate(ref, args, next, fail) {
        const key = `${getFunctionName(ref)}:${args.attemptId ?? args.operationId}:${args.index ?? ''}`;
        subscriptions.set(key, { next, fail });
        return () => subscriptions.delete(key);
      },
      async close() {
        closes++;
      },
    };
  };
  return {
    events,
    subscriptions,
    counts: () => ({ opens, closes, calls }),
    wait: input => observeHostedSubmissions(transport, input, undefined, e => events.push(e), subscribe),
    wake: () => {
      for (const s of subscriptions.values()) s.next(null);
    },
  };
}

test('pending recompose attempts remain visible and do not settle from the old stale-head inputs', async t => {
  const f = await finishFixture(t),
    request = f.request(),
    state = await f.enqueue(request),
    c = client(f);
  await f.drain();
  f.moveMain();
  await f.passChecks();
  while (!(await f.current(state.id)).pendingAttempt) await f.execute();
  const pending = (await f.current(state.id)).pendingAttempt;
  const first = await c.wait({ operationIds: [request.operationId], timeoutSeconds: 0 });
  assert.equal(first.result.status, 'timeout');
  assert(c.events.some(e => e.pendingAttempt?.id === pending.id));
  assert.equal(c.counts().opens, 0);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const second = await c.wait({ operationIds: [request.operationId], cursor: first.result.cursor });
  assert.equal(second.result.status, 'terminal');
  assert.equal(second.result.successful, true);
  assert.equal(f.tables.projectHostedLandingAttempts.size, 2);
  const versions = c.events.filter(e => e.type === 'submission').map(e => e.version);
  assert.equal(new Set(versions).size, versions.length);
});

test('a later saved Lane supersedes a staged input during live wait without changing or cancelling the request', async t => {
  const f = await finishFixture(t),
    request = f.request(),
    state = await f.enqueue(request),
    c = client(f);
  await f.drain();
  await f.passChecks();
  // Stop once the original input page is staged, before final acceptance.
  for (let i = 0; i < 30; i++) {
    const page = JSON.parse(
      await f.tx('finishWaitSetupInputs', api.inputs, {
        projectId: f.projectId,
        submissionId: state.id,
        attemptId: state.attemptId,
        index: 0,
      }),
    );
    if (page.staged) break;
    await f.execute();
    assert(i < 29, 'input staging is finite');
  }
  const waiting = c.wait({ operationIds: [request.operationId], timeoutSeconds: 2 });
  await turn();
  assert([...c.subscriptions.keys()].some(k => k.startsWith('projectHostedFinish:inputs')));
  const old = await f.readLane(f.lane.laneId);
  await f.changeLane(old.id, { head: 'e'.repeat(64), sourceVersion: old.sourceVersion + 1 });
  c.wake();
  const result = await waiting;
  assert.equal(result.result.status, 'terminal');
  assert.equal(result.result.successful, false);
  const input = c.events.filter(e => e.type === 'submission-input').at(-1);
  assert.equal(input.state, 'superseded');
  assert.equal(input.outcome, 'pending');
  assert.equal(input.complete, false);
  assert.equal((await f.current(state.id)).submission.observation.state, 'pending');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(c.counts().closes, 1);
  const calls = c.counts().calls;
  await turn();
  assert.equal(c.counts().calls, calls);
});
