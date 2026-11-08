// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { assertAgentResponseShape } from './agent-response-shape.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { landTerminal, landSummary } from '../dist/hosted-land-summary.js';
import { landWaitCommand } from '../dist/hosted-land-wait.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, checkOnly = false) {
  const calls = [],
    events = [],
    err = [],
    budgets = [];
  const operationId = randomUUID();
  let accepted = false,
    release,
    sourcePending = false,
    timeout = false,
    conflictRecovery,
    terminalFailure,
    stalePending,
    sourceStatus,
    pendingPhase = 'ready';
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
                      : pendingPhase,
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
      budgets.push(command.timeoutSeconds);
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
  const run = (root = '/synthetic', options = { detach: false, wait: true }) =>
    cli.hostedLandCli(
      root,
      { message: 'Land' },
      { url: 'https://fixture.invalid', projectId: 'synthetic' },
      options,
    );
  return {
    calls,
    events,
    budgets,
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
    pendingPhase: phase => {
      pendingPhase = phase;
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
  // Source preparation outlived the land budget: one explicit IN_PROGRESS line with its resume.
  assert(s.err.join('').includes('land: IN PROGRESS; resume with: exact source continuation'));
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
  // Issue 0fe39d02: the default budget is the agent wait's 540 s from command start (not 5400 s),
  // so a foreground land returns before a 600 s agent shell backgrounds it.
  assert.equal(s.budgets.length, 1);
  assert(s.budgets[0] > 530 && s.budgets[0] <= 540, `budget ${s.budgets[0]}`);
});

// Issue 4f60d57a replay: three land --save clients waited 16-21 min at 0% CPU on one socket after their
// admission committed, because the landing never left pending. Their retained metrics showed the
// submitter finished but nothing about the parent's wait. The wait now leaves a local start receipt
// before it begins (so a killed client still names its phase) and an end receipt with the last state.
test('a landing that never leaves pending leaves wait receipts naming the phase and last state', async t => {
  const s = await fixture(t);
  const parent = mkdtempSync(join(tmpdir(), 'forge-land-wait-')),
    root = join(parent, 'lane');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const journal = () => {
    try {
      return readFileSync(`${root}.forge-metrics.jsonl`, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(row => row.kind === 'wait');
    } catch {
      return [];
    }
  };
  s.pendingPhase('composing');
  s.timeout();
  const pending = s.run(root);
  await turn();
  // Still waiting: the start receipt is already on disk, as it would be for a killed client.
  const during = journal();
  assert.equal(during.length, 1);
  assert.equal(during[0].action, 'land');
  assert.equal(during[0].operationId, s.operationId);
  assert.equal(during[0].wait.phase, 'start');
  assert.equal(during[0].wait.waitingFor, 'acceptance');
  assert(during[0].wait.budgetMs > 530_000 && during[0].wait.budgetMs <= 540_000);
  s.release();
  const result = await pending;
  assert.equal(result.result.waitStatus, 'timeout');
  assert.equal(process.exitCode, 3);
  const [start, end] = journal();
  assert.equal(start.wait.phase, 'start');
  assert.equal(end.wait.phase, 'end');
  assert.equal(end.operationId, s.operationId);
  assert.equal(end.wait.status, 'timeout');
  assert.equal(end.wait.events, 1);
  assert.equal(end.wait.retries, 0);
  assert.equal(end.wait.last.phase, 'composing');
  assert.equal(end.wait.last.state, 'pending');
  assert(end.wait.sinceChangeMs >= 0 && end.wait.sinceChangeMs <= end.wait.durationMs);
  // Local appends only: still one submission call and one observer, no extra read.
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.events, ['subscription']);
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

/** Agent client environment for one test: `claude` wakes on background exit, `plain` does not. */
function client(t, kind) {
  const keys = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'FORGE_AGENT_WAKE', 'FORGE_CLIENT_SETTINGS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  // Default client settings (landWait true), never the developer's own file.
  process.env.FORGE_CLIENT_SETTINGS = join(tmpdir(), `forge-settings-${randomUUID()}.json`);
  if (kind === 'claude') process.env.CLAUDE_CODE_SESSION_ID = `synthetic-${randomUUID()}`;
  if (kind === 'off') {
    process.env.CLAUDE_CODE_SESSION_ID = `synthetic-${randomUUID()}`;
    process.env.FORGE_AGENT_WAKE = 'off';
  }
  t.after(() => {
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  });
}

test('agent land returns at once after submission with the one background wake command', async t => {
  client(t, 'claude');
  const s = await fixture(t);
  const result = await s.run('/synthetic', { detach: false });
  assert.deepEqual(s.events, [], 'no observer opens in the land command');
  assert.equal(s.calls.length, 1, 'one submission, no wait, no replay');
  assert.notEqual(process.exitCode, 3, 'submitted is not IN PROGRESS');
  const { wake, command, waitCommand, next, inProgress } = result.result;
  assert.equal(inProgress, true);
  assert.equal(wake.delivery, 'background-exit');
  assert.equal(wake.budgetSeconds, 7080);
  assert.equal(command, wake.command);
  assert.equal(waitCommand, wake.command);
  assert.deepEqual(next, {
    action: 'wait',
    operationIds: [s.operationId],
    until: 'acceptance',
    timeoutSeconds: 7080,
  });
  const err = s.err.join('');
  assert.match(err, /land: SUBMITTED; it settles without you\. Run once in the background/);
  assert(err.includes(wake.command));
  assert(!err.includes('keep this turn active'), 'no foreground-wait advice');
  assert(!err.includes('Next: wait'), 'one next step, not two');
  t.diagnostic('agent land: 1 submission call, 0 observer subscriptions, 0 replays in the land command');
});

test('without background wakes (or FORGE_AGENT_WAKE=off) land still waits in the foreground', async t => {
  for (const kind of ['plain', 'off']) {
    await t.test(kind, async t => {
      client(t, kind);
      const s = await fixture(t);
      const pending = s.run('/synthetic', { detach: false });
      await turn();
      assert.deepEqual(s.events, ['subscription']);
      s.release();
      const result = await pending;
      assert.equal(result.result.wake, undefined);
      assert.equal(result.result.submission.acceptance.receiptId, 'accepted');
    });
  }
});

test('an explicit --wait keeps the foreground wait even when the client wakes on background exit', async t => {
  client(t, 'claude');
  const s = await fixture(t);
  const pending = s.run('/synthetic', { detach: false, wait: true });
  await turn();
  assert.deepEqual(s.events, ['subscription']);
  s.release();
  assert.equal((await pending).result.wake, undefined);
});
