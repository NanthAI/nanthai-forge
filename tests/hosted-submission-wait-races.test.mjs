// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
import { landingFixture } from './hosted-landing-fixture.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));

// Hold an old attempt's second input page while canonical observations advance.
// There are no timers, scheduler races or network calls in this interleaving.
async function fixture(phase) {
  const f = await landingFixture();
  const seed = await f.enqueue(f.request());
  const originalAttempt = seed.attemptId,
    conflictCandidateId = randomUUID();
  let current = {
    ...seed,
    phase,
    request: { ...seed.request, finish: { composeOperationId: randomUUID(), after: null } },
    observation: {
      state: 'pending',
      pendingReason: phase === 'checking' ? 'checking' : 'queued',
      cause: null,
    },
  };
  const history = [current],
    events = [],
    subscriptions = new Set(),
    calls = [];
  const lanes = [randomUUID(), randomUUID()];
  let gate,
    settled = false,
    opens = 0,
    closes = 0,
    dispatches = 0;
  const transport = {
    root: '/synthetic',
    address: { url: 'https://fixture.invalid', projectId: seed.projectId },
    async dispatch() {
      dispatches++;
      return {
        schema: 1,
        transport: 'hosted',
        action: 'capabilities',
        operationId: null,
        result: { actor: 'owner' },
      };
    },
    async query(name, args) {
      calls.push({ name, ...args });
      if (name === 'projectHostedFinishObserve:page') {
        assert.equal(args.operationId, seed.operationId);
        return {
          projectId: seed.projectId,
          operationId: seed.operationId,
          authority: { mode: 'server', epoch: 1 },
          submission: current,
          pendingAttempt: null,
          events: history
            .filter(state => state.version >= args.nextVersion)
            .map(submission => ({ submission, pendingAttempt: null })),
          nextVersion: current.version + 1,
          isDone: true,
          resnapshot: false,
          // Conflict evidence is already embedded by the selected observation.
          ...(current.error ? { conflict: { candidateId: conflictCandidateId } } : {}),
        };
      }
      assert.equal(name, 'projectHostedFinish:inputs');
      assert.equal(args.submissionId, seed.id);
      assert(args.index === 0 || args.index === 1);
      if (gate && args.index === 1) {
        const selected = gate;
        gate = undefined;
        selected.entered.resolve(args);
        await selected.release.promise;
      }
      return {
        staged: true,
        nextIndex: args.index === 0 ? 1 : null,
        entries: [
          {
            submissionId: seed.id,
            operationId: seed.operationId,
            attemptId: args.attemptId,
            laneId: lanes[args.index],
            terminal: settled || args.attemptId !== current.attemptId,
            complete: current.observation.state === 'landed' && args.attemptId === current.attemptId,
          },
        ],
      };
    },
  };
  const subscribe = () => {
    opens++;
    return {
      onUpdate(ref, args, next) {
        const name = getFunctionName(ref);
        assert(['projectHostedFinishObserve:page', 'projectHostedFinish:inputs'].includes(name));
        const entry = { name, args, next };
        subscriptions.add(entry);
        return () => {
          subscriptions.delete(entry);
        };
      },
      async close() {
        closes++;
      },
    };
  };
  const advance = (phase, attemptId = current.attemptId) => {
    current = {
      ...current,
      phase,
      attemptId,
      version: current.version + 1,
      observation:
        phase === 'landed'
          ? { state: 'landed', pendingReason: null, cause: null }
          : phase === 'terminal-failed'
            ? { state: 'terminal-failed', pendingReason: null, cause: 'conflict' }
            : { state: 'pending', pendingReason: 'queued', cause: null },
      ...(phase === 'landed' ? { acceptance: { receiptId: randomUUID(), head: 'a'.repeat(64) } } : {}),
      error:
        phase === 'terminal-failed'
          ? { code: 'COMPOSITION_CONFLICT', message: 'Synthetic replacement conflict' }
          : null,
    };
    history.push(current);
  };
  return {
    events,
    calls,
    subscriptions,
    originalAttempt,
    advance,
    current: () => current,
    settle: () => {
      settled = true;
    },
    counts: () => ({ opens, closes, dispatches, calls: calls.length }),
    hold: () => {
      gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      return { entered: gate.entered.promise, release: gate.release.resolve };
    },
    wake: () => {
      // Canonical query updates are hints, not an extra query or a payload cache.
      for (const entry of subscriptions)
        if (entry.name === 'projectHostedFinishObserve:page') entry.next(null);
    },
    wait: (options = {}) =>
      observeHostedSubmissions(
        transport,
        { operationIds: [seed.operationId], ...options },
        undefined,
        event => events.push(event),
        subscribe,
      ),
  };
}

for (const timing of ['before Ready', 'during Ready', 'after Ready']) {
  for (const outcome of ['landed', 'terminal-failed']) {
    test(`original operation returns the replacement's ${outcome} result ${timing}`, async () => {
      const s = await fixture(timing === 'before Ready' ? 'checking' : 'ready');
      let done = false;
      let gate = timing === 'after Ready' ? undefined : s.hold();
      if (gate) s.settle();
      const waiting = s.wait().then(value => {
        done = true;
        return value;
      });
      if (!gate) {
        await turn();
        assert.equal(done, false);
        assert(s.events.some(e => e.type === 'submission' && e.submission.phase === 'ready'));
        gate = s.hold();
        s.settle();
        s.wake();
      }
      const selected = await gate.entered;
      assert.equal(selected.attemptId, s.originalAttempt);
      const replacement = randomUUID();
      s.advance('composing', replacement);
      s.advance(outcome);
      // Include the active-read lost-wake case as well as registration reread.
      s.wake();
      gate.release();
      const result = await waiting;
      assert.equal(result.result.status, 'terminal');
      assert.equal(result.result.successful, outcome === 'landed');
      assert.deepEqual(result.result.submissions[0].submission, s.current());
      const final = s.events.filter(e => e.type === 'submission' && e.terminal);
      assert.equal(final.length, 1, 'emit the canonical terminal version once');
      assert.equal(final[0].submission.attemptId, replacement);
      assert.equal(final[0].version, s.current().version);
      assert.equal(s.counts().dispatches, 1);
      assert.equal(s.counts().opens, 1);
      assert.equal(s.counts().closes, 1);
      assert.equal(s.subscriptions.size, 0);
      const calls = s.calls.length;
      await turn();
      assert.equal(s.calls.length, calls, 'zero idle calls after terminal settlement');
      // Each canonical drain retains exactly its existing two input-page reads.
      const pages = s.calls.filter(call => call.name === 'projectHostedFinishObserve:page').length;
      assert.equal(calls, pages * 3, 'no added finalization query per refresh');
    });
  }
}

test('settled source pages keep Ready pending until the same attempt publishes its canonical receipt', async () => {
  const s = await fixture('ready'),
    gate = s.hold();
  s.settle();
  let done = false;
  const waiting = s.wait().then(value => {
    done = true;
    return value;
  });
  await gate.entered;
  s.settle();
  gate.release();
  await turn();
  await turn();
  assert.equal(done, false, 'input settlement alone must never finalize a cached Ready payload');
  const idle = s.calls.length;
  await turn();
  assert.equal(s.calls.length, idle, 'zero calls while no server event occurs');
  assert.equal(idle, 6, 'initial read and register-then-reread, each with two input pages');
  s.advance('landed');
  s.wake();
  const result = await waiting;
  assert.deepEqual(result.result.submissions[0].submission, s.current());
  assert.equal(result.result.successful, true);
  assert.equal(s.current().attemptId, s.originalAttempt);
  assert.equal(s.events.filter(e => e.type === 'submission' && e.terminal).length, 1);
  assert.equal(s.calls.length, 9, 'one event refresh and its existing two input pages');
});

test('replacement stays pending, drops old input subscriptions, and resumes its terminal version once', async () => {
  const s = await fixture('ready');
  let done = false;
  const waiting = s.wait().then(value => {
    done = true;
    return value;
  });
  await turn();
  const gate = s.hold();
  s.settle();
  s.wake();
  await gate.entered;
  const replacement = randomUUID();
  s.advance('composing', replacement);
  s.wake();
  gate.release();
  await turn();
  assert.equal(done, false);
  const inputs = [...s.subscriptions].filter(s => s.name === 'projectHostedFinish:inputs');
  assert.equal(inputs.length, 2);
  assert(inputs.every(s => s.args.attemptId === replacement));
  const calls = s.calls.length;
  await turn();
  assert.equal(s.calls.length, calls, 'replacement adds no idle polling');
  s.advance('landed');
  s.wake();
  const result = await waiting;
  const count = s.events.length;
  const replay = await s.wait({ cursor: result.result.cursor, timeoutSeconds: 0 });
  assert.deepEqual(replay.result.submissions, result.result.submissions);
  assert.equal(s.events.length, count, 'cursor replay emits no duplicate terminal version');
  assert.equal(s.subscriptions.size, 0);
});
