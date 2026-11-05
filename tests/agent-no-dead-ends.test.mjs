// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { landSummary, landTerminal } from '../dist/hosted-land-summary.js';
import { landWaitCommand } from '../dist/hosted-land-wait.js';
import { checkFailureDetail, CHECK_FAILED_NEXT } from '../dist/check-failure-detail.js';
import { failingStep } from '../dist/hosted-landing-suspect.js';
import { executeHostedMetrics } from '../dist/hosted-agent-metrics.js';
import { currentExchangeProgress } from '../dist/exchange-progress-hooks.js';
import { actionableNotFound, describeIssues, resolveShortLaneId } from '../dist/argument-errors.js';
import { validateHostedCliCommand } from '../dist/hosted-cli-validation.js';
import { ForgeError } from '../dist/errors.js';
import { HostedAgentJournal } from '../dist/hosted-agent-journal.js';
import { hostedAgentCli, sourceWaitHooks } from '../dist/hosted-agent-cli.js';

const address = { url: 'https://example.invalid', projectId: 'project' };
function checkout(t) {
  const parent = mkdtempSync(join(tmpdir(), 'forge-no-dead-ends-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

// Issue 96882643: a passed check still queued to land is not reported as "not landed".
test('a passed check queued to land says so, stays unfinished and names its wait', () => {
  const operationId = randomUUID();
  const queued = {
    operationId,
    result: {
      phase: 'finish',
      submission: { phase: 'ready', observation: { state: 'pending', pendingReason: 'queued' } },
    },
  };
  assert.deepEqual(landSummary(queued), [
    'CHECK PASSED; queued to land, not landed yet (waiting for acceptance)',
  ]);
  assert.equal(landTerminal(queued), false, 'ready is terminal only when nothing is pending');
  assert.match(landWaitCommand('/repo', queued), new RegExp(`wait .*${operationId}.*acceptance`));
  for (const [reason, label] of [
    ['queued', 'QUEUED'],
    ['checking', 'CHECKING'],
    ['waiting-for-dependency', 'WAITING FOR DEPENDENCY'],
  ])
    assert.deepEqual(
      landSummary({
        result: {
          phase: 'finish',
          submission: { phase: 'checking', observation: { state: 'pending', pendingReason: reason } },
        },
      }),
      [`${label}; not landed yet`],
    );
  assert.deepEqual(landSummary({ result: { phase: 'check', run: { id: 'r', status: 'passed' } } }), [
    'CHECK PASSED (check only; this command does not land)',
  ]);
});

// Issue 58236de6: the exact hosted-plan failure shape names its job and first error.
test('CHECK_FAILED names the failing step and first error, with the next step', () => {
  const tail = [
    'node:assert:128',
    '  throw new AssertionError(obj);',
    'AssertionError [ERR_ASSERTION]: Unlisted packaged document: docs/research/b15d-report.md. Add its manifest under scripts/package-documents/.',
    '    at inventory (file:///w/control/scripts/check-documents.mjs:35:16)',
    "  code: 'ERR_ASSERTION',",
    'Node.js v24.22.1',
    'forge check: docs step failed (exit 1)',
    'npm error code 1',
  ].join('\n');
  const step = failingStep(
    [{ descriptor: JSON.stringify({ shard: 0 }), seal: JSON.stringify({ failureSummary: tail }) }],
    1,
  );
  assert.equal(step.job, 'job 0 (static)');
  assert.match(step.excerpt, /^AssertionError \[ERR_ASSERTION\]: Unlisted packaged document: docs\/research/);
  const detail = checkFailureDetail({}, step);
  assert.match(detail, /^Failing job 0 \(static\): AssertionError .*Unlisted packaged document/);
  const message = `The original exact check settled as failed. ${detail} ${CHECK_FAILED_NEXT}`;
  const lines = landSummary({
    result: {
      phase: 'finish',
      submission: { phase: 'terminal-failed', error: { code: 'CHECK_FAILED', message } },
    },
  });
  assert.match(lines[0], /^FAILED CHECK_FAILED: .*Unlisted packaged document.*land --save again/);
  // Test failures: first files with their first error, bounded, secret-safe, rest counted.
  const reports = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [
      `tests/f${i}.test.mjs`,
      { failed: true, firstError: `expected ${i} token=abcdef123456` },
    ]),
  );
  const files = checkFailureDetail({
    contractReports: reports,
    testFiles: { counts: { failed: 5 }, failed: Object.keys(reports).map(file => ({ file })) },
  });
  assert.match(files, /^Failing: tests\/f0\.test\.mjs \(expected 0 token=\[redacted\]\); .*; \+2 more\.$/);
  assert.equal(
    checkFailureDetail({}),
    'No failing test file or job step was reported; open the check run log.',
  );
});

// Issue e32cb0e7: metrics ends within its whole-read deadline with a typed next step.
test('metrics never outlives its deadline and cancels in-flight reads', async () => {
  const signals = [];
  const never = Object.assign(
    () => {
      signals.push(currentExchangeProgress()?.signal);
      return new Promise(() => {});
    },
    { objects: () => new Promise(() => {}) },
  );
  const started = performance.now();
  await assert.rejects(
    executeHostedMetrics({ root: tmpdir(), address, query: never }, {}, 50),
    error =>
      error.code === 'METRICS_TIMEOUT' &&
      /within 0 s|within 50|did not finish/.test(error.message) &&
      /Next: nforge agent ROOT metrics '\{"from":/.test(error.message),
  );
  assert(performance.now() - started < 2000);
  assert.equal(signals.length, 1, 'one page in flight, no retry storm');
  assert.equal(signals[0]?.aborted, true, 'the deadline reaches the in-flight page read');
});

// Issue ee7e3057: argument errors name the field, the expected shape and where the full id is.
test('BAD_ARGUMENT names the field and a short laneId resolves from this machine', t => {
  assert.throws(
    () => validateHostedCliCommand('/repo', 'save', { laneId: 'a355a44e' }),
    error =>
      error.code === 'BAD_ARGUMENT' &&
      /laneId: expected the full 36-character UUID/.test(error.message) &&
      /short id "a355a44e"/.test(error.message) &&
      /lanes '\{\}' lists your live Lanes/.test(error.message) &&
      !/\.\./.test(error.message),
  );
  assert.match(
    describeIssues([{ code: 'invalid_format', format: 'uuid', path: ['id'], message: 'x.' }], {
      id: 'ee7e3057',
    }),
    /id: .*planning '\{"search":"words"\}'/,
  );
  const state = mkdtempSync(join(tmpdir(), 'forge-lane-registry-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  });
  const directory = join(state, 'forge', 'lanes');
  mkdirSync(directory, { recursive: true });
  const lane = (laneId, projectId = 'project') =>
    writeFileSync(
      join(directory, `${laneId}.json`),
      JSON.stringify({ laneId, root: '/r', url: '', projectId, openedAt: 1, lastActionAt: 1 }),
    );
  const one = 'a355a44e-52e7-418b-8c7b-f115221e33f5';
  lane(one);
  lane('b0000000-0000-4000-8000-000000000001');
  lane('b0000000-0000-4000-8000-000000000002');
  assert.deepEqual(resolveShortLaneId({ laneId: 'a355a44e' }, 'project'), {
    selected: { laneId: one },
    resolved: one,
  });
  assert.equal(resolveShortLaneId({ laneId: 'a355a44e' }, 'other').resolved, undefined);
  assert.equal(resolveShortLaneId({ laneId: 'b0000000' }, 'project').resolved, undefined, 'ambiguous');
  assert.equal(resolveShortLaneId({ laneId: 'a355' }, 'project').resolved, undefined, 'too short');
});

// Issue c7087e3b: NOT_FOUND names what was looked up and the next command.
test('NOT_FOUND names the action, the ids sent and the next command', () => {
  const laneId = randomUUID();
  const error = actionableNotFound(
    new ForgeError('NOT_FOUND', 'Hosted Lane not found on this project.'),
    'finish',
    { laneId, accept: true },
  );
  assert.equal(error.code, 'NOT_FOUND');
  assert.match(error.message, new RegExp(`Action finish sent laneId "${laneId}"`));
  assert.match(error.message, /Next: .*nforge agent ROOT lanes '\{\}'/);
  assert.match(
    actionableNotFound(new ForgeError('NOT_FOUND', 'Landing operation not found'), 'finish', {}).message,
    /not found\. Action finish sent no id; it selected from this folder\. Next:/,
  );
  const other = new ForgeError('BAD_ARGUMENT', 'x');
  assert.equal(actionableNotFound(other, 'finish', {}), other);
});

// Lead report (bd201506): wait on a save operation id resumed nothing and said NOT_FOUND.
test('wait accepts a save operation id and resumes it by exact replay', async t => {
  const root = checkout(t);
  const journal = new HostedAgentJournal(root, address, 'actor', 'save', { message: 'm' });
  const calls = [];
  const transport = {
    async dispatch(action, command) {
      calls.push({ action, command });
      return {
        schema: 1,
        transport: 'hosted',
        action,
        operationId: command.operationId,
        result: { outcome: 'saved' },
      };
    },
  };
  const response = await hostedAgentCli(
    root,
    'wait',
    { operationIds: [journal.operationId] },
    address,
    transport,
  );
  assert.deepEqual(calls, [{ action: 'save', command: { message: 'm', operationId: journal.operationId } }]);
  assert.equal(response.result.outcome, 'saved');
  await assert.rejects(
    hostedAgentCli(root, 'wait', { operationIds: [journal.operationId, randomUUID()] }, address, transport),
    /separate commands/,
  );
  assert.equal(calls.length, 1, 'a mixed selection replays nothing');

  // Still running: wait on its source progress (one subscription), then replay once more.
  const running = new HostedAgentJournal(root, address, 'actor', 'save', { message: 'n' });
  const waits = [];
  const original = sourceWaitHooks.wait;
  sourceWaitHooks.wait = async (_address, operationId, initial) => {
    waits.push(operationId);
    return initial;
  };
  t.after(() => {
    sourceWaitHooks.wait = original;
  });
  let replays = 0;
  const slow = {
    async dispatch(action, command) {
      replays++;
      return {
        schema: 1,
        transport: 'hosted',
        action,
        operationId: command.operationId,
        result:
          replays === 1
            ? { status: 'submitted', jobId: randomUUID(), source: { status: 'running' } }
            : { outcome: 'saved' },
      };
    },
  };
  const done = await hostedAgentCli(root, 'wait', { operationIds: [running.operationId] }, address, slow);
  assert.equal(done.result.outcome, 'saved');
  assert.deepEqual(waits, [running.operationId]);
  assert.equal(replays, 2);
  // Budget spent while still running: IN_PROGRESS with the same wait to resume.
  replays = 0;
  const stuck = {
    dispatch: async (action, command) => ({
      action,
      operationId: command.operationId,
      result: { status: 'submitted', jobId: 'j' },
    }),
  };
  const pending = await hostedAgentCli(
    root,
    'wait',
    { operationIds: [running.operationId], timeoutSeconds: 0 },
    address,
    stuck,
  );
  assert.equal(pending.result.status, 'IN_PROGRESS');
  assert.match(pending.result.waitCommand, new RegExp(`wait .*${running.operationId}`));
  process.exitCode = 0;
});
