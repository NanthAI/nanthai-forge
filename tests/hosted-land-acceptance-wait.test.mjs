// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { assertAgentResponseShape } from './agent-response-shape.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { landTerminal, landSummary } from '../dist/hosted-land-summary.js';
import { landWaitCommand } from '../dist/hosted-land-wait.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, checkOnly = false) {
  const calls = [],
    events = [],
    err = [];
  const operationId = randomUUID();
  let accepted = false,
    release,
    sourcePending = false,
    timeout = false,
    conflictRecovery,
    terminalFailure,
    stalePending,
    sourceStatus;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  // Retained unrelated history never becomes a client read or observer.
  const retained = Array.from({ length: 575 }, () => ({ operationId: randomUUID() }));
  const response = () => ({
    schema: 1,
    transport: 'hosted',
    action: 'finish',
    operationId,
    result: sourcePending
      ? { phase: 'sync', progress: { status: 'submitted' }, command: 'exact source continuation' }
      : checkOnly
        ? { phase: 'check', run: { id: 'run', status: accepted ? 'passed' : 'running' } }
        : {
            phase: 'finish',
            ...(stalePending ?? {}),
            submission: {
              phase:
                conflictRecovery || terminalFailure
                  ? 'terminal-failed'
                  : sourceStatus
                    ? 'composing'
                    : accepted
                      ? 'landed'
                      : 'ready',
              observation: {
                state:
                  conflictRecovery || terminalFailure
                    ? 'terminal-failed'
                    : sourceStatus
                      ? 'pending'
                      : accepted
                        ? 'landed'
                        : 'pending',
              },
              ...(terminalFailure ? { error: terminalFailure } : {}),
              ...(conflictRecovery
                ? { error: { code: 'COMPOSITION_CONFLICT', message: 'shared.txt has conflicting edits' } }
                : {}),
              ...(accepted && !sourceStatus && !conflictRecovery && !terminalFailure
                ? { acceptance: { receiptId: 'accepted', head: 'head' } }
                : {}),
            },
          },
  });
  const key = `__landTest${randomUUID().replaceAll('-', '')}`;
  globalThis[key] = {
    HostedAgentTransport: class {},
    hostedAgentCli: async (_root, _action, command) => {
      calls.push(command);
      return response();
    },
    observeHostedSubmissions: async (_transport, command, _signal, emit) => {
      assert.deepEqual(command.operationIds, [operationId]);
      assert.equal(command.until, 'acceptance');
      assert(!retained.some(row => command.operationIds.includes(row.operationId)));
      events.push('subscription');
      emit({
        type: 'submission',
        terminal: false,
        submission: response().result.submission,
        wouldConflict: { predecessor: { head: 'speculative' }, paths: ['shared.txt'] },
      });
      await gate;
      accepted = !timeout;
      if (accepted) emit({ type: 'submission', terminal: true, submission: response().result.submission });
      return {
        result: {
          status: timeout ? 'timeout' : 'terminal',
          submissions: [
            {
              submission: response().result.submission,
              ...(conflictRecovery ? { recovery: conflictRecovery } : {}),
            },
          ],
        },
      };
    },
    observeHostedRun: async () => {
      events.push('run-subscription');
      await gate;
      accepted = true;
      return { result: { status: 'terminal', run: response().result.run } };
    },
  };
  const stubs = {
    './hosted-agent-transport.js': 'HostedAgentTransport',
    './hosted-agent-cli.js': 'hostedAgentCli',
    './hosted-agent-submission-wait.js': 'observeHostedSubmissions',
    './hosted-agent-observe.js': 'observeHostedRun',
  };
  const source = readFileSync(new URL('../dist/hosted-land-cli.js', import.meta.url), 'utf8').replace(
    /from '([^']+)'/g,
    (match, path) => {
      if (stubs[path])
        return `from '${'data:text/javascript,' + encodeURIComponent(`export const ${stubs[path]} = globalThis.${key}.${stubs[path]};`)}'`;
      return path.startsWith('.')
        ? `from '${new URL(`../dist/${path.slice(2)}`, import.meta.url).href}'`
        : match;
    },
  );
  const cli = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const oldOut = process.stdout.write,
    oldErr = process.stderr.write,
    oldExit = process.exitCode;
  const output = [];
  process.stdout.write = (chunk, ...args) => {
    if (typeof chunk === 'string' && chunk.startsWith('{')) {
      output.push(chunk);
      return true;
    }
    return oldOut.call(process.stdout, chunk, ...args);
  };
  process.stderr.write = chunk => {
    err.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
    process.exitCode = oldExit;
    delete globalThis[key];
  });
  const run = () =>
    cli.hostedLandCli(
      '/synthetic',
      { message: 'Land' },
      { url: 'https://fixture.invalid', projectId: 'synthetic' },
      { detach: false, wait: true },
    );
  return {
    calls,
    events,
    err,
    output,
    release,
    run,
    operationId,
    response,
    stale: selection => {
      stalePending = {
        status: 'submitted',
        progress: { status: 'submitted', jobId: 'retained' },
        next: { action: 'finish', operationId },
        command: 'obsolete continuation',
        error: { code: 'STALE_SOURCE_RETRY', message: 'Old pending source advice' },
        failedPhase: 'source-compose',
        recovery: { status: 'submitted', next: { action: 'finish', operationId } },
        source: { status: 'submitted', jobId: 'retained' },
        replay: { operationId },
        waitCommand: 'obsolete wait',
        inProgress: true,
        replayParameters: { ...selection, operationId },
      };
    },
    fail: () => {
      terminalFailure = { code: 'SYNTHETIC_FAILURE', message: 'Retained terminal failure' };
    },
    conflict: recovery => {
      conflictRecovery = recovery;
    },
    timeout: () => {
      timeout = true;
    },
    pendingSource: () => {
      sourcePending = true;
    },
    sourceStatus: status => {
      sourceStatus = status;
      const nextId = status === 'retryable' ? operationId : randomUUID();
      const parameters = { message: 'Land', operationId: nextId };
      stalePending = {
        status,
        progress: { status, jobId: 'retained' },
        next: { action: 'finish', ...parameters },
        command: `nforge agent '/synthetic' finish '${JSON.stringify(parameters)}'`,
        replayParameters: { message: 'Land', operationId },
      };
    },
  };
}

test('land stays waiting at ready and returns the observed outcome without replaying finish', async t => {
  const s = await fixture(t);
  let done = false;
  const pending = s.run().then(result => {
    done = true;
    return result;
  });
  await turn();
  assert.equal(done, false);
  assert.equal(s.calls.length, 1, 'one submission while idle, no final read yet');
  assert.deepEqual(s.events, ['subscription']);
  const advice = s.output.map(line => JSON.parse(line)).find(event => event.wouldConflict);
  assert.equal(advice.terminal, false);
  assert.equal(advice.wouldConflict.predecessor.head, 'speculative');
  assert(landWaitCommand('/synthetic', s.response()));
  assert.equal(landTerminal(s.response()), false);
  await turn();
  assert.equal(s.calls.length, 1, '575 unrelated records add zero idle calls');
  s.release();
  const result = await pending;
  assert.equal(result.result.submission.acceptance.receiptId, 'accepted');
  assert.equal(s.calls.length, 1, 'no replay after the authoritative terminal read');
  assert(s.err.join('').includes('LANDED receipt accepted'));
  t.diagnostic(
    '575-record history: 1 selected subscription, 0 idle calls, 0 final replays; no history hydration',
  );
});

test('check-only still waits only for its run and returns CHECK PASSED without acceptance', async t => {
  const s = await fixture(t, true);
  const pending = s.run();
  await turn();
  assert.deepEqual(s.events, ['run-subscription']);
  s.release();
  const result = await pending;
  assert.equal(result.result.run.status, 'passed');
  assert.equal(landTerminal(result), true);
  assert.deepEqual(landSummary(result), ['CHECK PASSED (check only; this command does not land)']);
  assert.equal(s.calls.length, 1);
});

test('land exposes an unfinished source handoff and returns a pending exit status', async t => {
  const s = await fixture(t);
  s.pendingSource();
  const result = await s.run();
  assert.equal(result.result.phase, 'sync');
  assert.equal(process.exitCode, 3);
  assert.deepEqual(s.events, []);
  assert.equal(s.calls.length, 1);
  assert(s.err.join('').includes('SOURCE PENDING'));
  assert(s.err.join('').includes('exact source continuation'));
});

test('retryable source returns its same-operation recovery without opening an observer', async t => {
  const s = await fixture(t);
  s.sourceStatus('retryable');
  const pending = s.run();
  await turn();
  const observed = [...s.events];
  s.release();
  const response = await pending;
  assert.deepEqual(observed, []);
  assert.equal(s.calls.length, 1);
  assert.equal(process.exitCode, 3);
  assert.equal(response.result.next.operationId, s.operationId);
  assert.equal(response.result.waitCommand, undefined);
  assert(s.err.join('').includes('SOURCE NEEDS RECOVERY'));
  assert(s.err.join('').includes('Continue recovery: ' + response.result.command));
});

test('failed source child remains waiting until its canonical parent fails', async t => {
  const s = await fixture(t);
  s.sourceStatus('failed');
  let complete = false;
  const pending = s.run().then(value => {
    complete = true;
    return value;
  });
  await turn();
  const early = complete,
    observed = [...s.events],
    command = landWaitCommand('/synthetic', s.response());
  s.fail();
  s.release();
  const response = await pending;
  assert.equal(early, false);
  assert.deepEqual(observed, ['subscription']);
  assert.equal(typeof command, 'string');
  assert(s.err.join('').includes(command));
  assert.equal(s.calls.length, 1);
  assert.equal(process.exitCode, 2);
  assert.equal(response.result.submission.observation.state, 'terminal-failed');
  assert.equal(response.result.next.operationId, undefined);
  assert.equal(response.result.next.retry, true);
  assert.equal(response.result.waitCommand, undefined);
});

test('land observation deadline returns IN PROGRESS with the exact wait command and no finish replay', async t => {
  const s = await fixture(t);
  s.timeout();
  s.release();
  const result = await s.run();
  assert.equal(result.result.inProgress, true);
  assert.equal(result.result.waitStatus, 'timeout');
  assert.equal(process.exitCode, 3);
  assert.equal(s.calls.length, 1);
  const stderr = s.err.join('');
  assert(stderr.includes('IN PROGRESS; wait deadline reached'));
  assert(stderr.includes(landWaitCommand('/synthetic', result)));
  assert(!stderr.includes('FAILED'));
});

test('land returns observed composition conflict details and sync instead of a finish replay', async t => {
  const s = await fixture(t);
  const pending = s.run();
  await turn();
  const recovery = {
    conflict: {
      candidateId: randomUUID(),
      paths: ['shared.txt'],
      next: { action: 'sync' },
      command: "nforge agent '/synthetic' sync '{}'",
    },
  };
  s.conflict(recovery);
  s.release();
  const result = await pending;
  assert.deepEqual(result.result.recovery, recovery);
  assert.equal(result.result.recovery.conflict.next.action, 'sync');
  assert.deepEqual(result.result.recovery.conflict.paths, ['shared.txt']);
  assert.equal(result.result.submission.error.code, 'COMPOSITION_CONFLICT');
  assert.equal(s.calls.length, 1, 'no finish replay to discover recovery');
  assert.equal(process.exitCode, 2);
  assert(s.err.join('').includes('Continue recovery: ' + recovery.conflict.command));
});

for (const outcome of ['failure', 'landed', 'conflict'])
  test(`response-shape guard: first waited ${outcome} clears stale source advice with zero post-wait calls`, async t => {
    const s = await fixture(t);
    const selection = {
      message: "Keep 'original' selection",
      inputs: [{ laneId: randomUUID(), expected: { head: 'pinned' } }],
      dependencies: [{ candidateId: randomUUID() }],
      after: null,
      accept: true,
      keepOpen: true,
    };
    s.stale(selection);
    const pending = s.run();
    await turn();
    if (outcome === 'failure') s.fail();
    if (outcome === 'conflict')
      s.conflict({
        conflict: {
          next: { action: 'sync', operationId: 'retained-conflict' },
          command: `nforge agent '/synthetic' sync '{"operationId":"retained-conflict"}'`,
        },
      });
    s.release();
    const response = await pending;
    const next = assertAgentResponseShape(response, '/synthetic');
    assert.equal(s.calls.length, 1, 'normalization adds zero calls, reads or finish mutations');
    assert.equal(response.result.progress, undefined);
    assert.equal(response.result.replay, undefined);
    assert.equal(response.result.waitCommand, undefined);
    assert.equal(response.result.source, undefined);
    assert.equal(response.result.error, undefined);
    assert.equal(response.result.failedPhase, undefined);
    if (outcome === 'failure') {
      assert.deepEqual(next.body, { ...selection, retry: true, reason: 'other' });
      assert.equal(response.result.next.operationId, undefined);
      assert.equal(response.result.recovery, undefined);
      assert.equal(response.result.source, undefined);
      assert.equal(response.result.retryCommand, response.result.command);
      assert.equal(response.result.replayParameters.operationId, s.operationId);
      assert(s.err.join('').includes('Retry: ' + response.result.command));
      assert.equal(process.exitCode, 2);
    } else if (outcome === 'conflict') {
      assert.equal(next.action, 'sync');
      assert.equal(next.body.operationId, 'retained-conflict');
    } else {
      assert.equal(response.result.submission.acceptance.receiptId, 'accepted');
      assert.equal(response.result.next, undefined);
    }
  });

for (const count of [560, 1120])
  test(`response normalization budget: ${count} pinned inputs adds zero calls or source reads`, async t => {
    const s = await fixture(t);
    const selection = {
      inputs: Array.from({ length: count }, () => ({
        laneId: randomUUID(),
        expected: { head: 'a'.repeat(64), version: 1 },
      })),
      dependencies: [],
      message: 'Synthetic selection',
      accept: true,
    };
    s.stale(selection);
    const pending = s.run();
    await turn();
    s.fail();
    const started = performance.now();
    s.release();
    const response = await pending;
    const elapsedMs = performance.now() - started;
    const next = assertAgentResponseShape(response, '/synthetic');
    assert.deepEqual(next.body.inputs, selection.inputs);
    assert.equal(s.calls.length, 1);
    assert.equal(s.events.length, 1, 'one selected observation, no history hydration');
    t.diagnostic(
      JSON.stringify({
        inputs: count,
        extraConvexCalls: 0,
        extraDbReads: 0,
        extraDbWrites: 0,
        sourceReads: 0,
        idleCalls: 0,
        elapsedMs,
        rssBytes: process.memoryUsage().rss,
        retryBytes: Buffer.byteLength(response.result.command),
      }),
    );
  });
