// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationWait } from '../dist/agent-operation-wait.js';
import { agentDeadEnd } from '../dist/error-teaching.js';
import { slimReceipt, printedReceipt } from '../dist/receipt-slim.js';
import { publicLogsNotice } from '../dist/runner-visibility.js';
import { shellQuote } from '../dist/shell-quote.js';

// Issue 47558a99: receipts leave the process without facts the agent already holds. Budgets are
// characters of the printed JSON (tokens are about chars / 4); raise one only with numbers on the Issue.
const MEDIAN_RECEIPT = 300; // chars, healthy start/save/sync/land receipts (Issue 47558a99 target)
const MAX_HEALTHY_RECEIPT = 450; // the terminal wait and landing carry a receipt id and a State (64 hex)
const MAX_QUEUED_SUBMIT = 1200; // chars, queued landing submit (Issue 47558a99)
const sha = 'a'.repeat(64);
const laneId = randomUUID();
const save = extra => ({
  schema: 1,
  cliCommit: sha,
  transport: 'hosted',
  action: 'save',
  operationId: 'op-save',
  resolved: { operationId: 'op-save' },
  result: {
    at: '2026-01-01T00:00:00.000Z',
    attemptId: randomUUID(),
    outcome: {
      result: {
        at: '2026-01-01T00:00:00.000Z',
        head: sha,
        laneId,
        operationId: 'x',
        saveId: randomUUID(),
        schema: 1,
        sourceVersion: 1,
        unchanged: false,
        version: 1,
      },
      status: 'completed',
    },
  },
  behindMain: {
    head: sha,
    baseHead: sha,
    baseSequence: 30000,
    commits: 0,
    conflictingPaths: [],
    more: 0,
    coverage: 'hosted',
  },
  ...extra,
});
const chars = value => JSON.stringify(value).length;

test('a save drops the retired overlap list an older server still sends (Issue 853fcde3)', () => {
  const slim = slimReceipt(
    save({ unacknowledgedOverlaps: { count: 0, items: [], coverage: 'unavailable' } }),
  );
  assert(!('unacknowledgedOverlaps' in slim));
  assert.equal(slim.result.outcome.result.head, sha);
  assert.equal(slim.result.outcome.status, 'completed');
  assert(!('behindMain' in slim), 'not behind main: nothing to say');
  assert(!('cliCommit' in slim) && !('schema' in slim) && !('transport' in slim) && !('resolved' in slim));
});

test('behind main, a checkout and a healthy mirror report only what differs', () => {
  const lane = { laneId, head: sha, version: 0, base: { head: sha } };
  const start = slimReceipt({
    transport: 'hosted',
    result: { lane, checkout: { ...lane, root: '/lane', downloadedObjects: 0, replayed: false } },
    behindMain: {
      head: sha,
      baseHead: sha,
      baseSequence: 1,
      commits: 2,
      conflictingPaths: ['a'],
      more: 0,
      coverage: 'hosted',
    },
  });
  assert.deepEqual(start.result.checkout, { root: '/lane', downloadedObjects: 0, replayed: false });
  assert.equal(start.behindMain.commits, 2, 'a Lane that is behind keeps its full detail');
  assert.deepEqual(start.behindMain.conflictingPaths, ['a']);
  const status = slimReceipt({
    transport: 'hosted',
    result: {
      head: sha,
      githubMirror: {
        repository: 'o/r',
        status: 'synced',
        targetHead: sha,
        mirroredHead: sha,
        lagging: false,
        failures: 0,
        error: null,
      },
    },
  });
  assert.deepEqual(status.result.githubMirror, { status: 'synced', repository: 'o/r' });
  const failing = {
    transport: 'hosted',
    result: { githubMirror: { status: 'synced', lagging: false, failures: 2, error: null } },
  };
  assert.deepEqual(slimReceipt(failing).result, failing.result, 'a mirror with failures keeps all fields');
});

test('preflight counts the deferred tests instead of listing hundreds', () => {
  const deferredTests = Array.from({ length: 800 }, (_, i) => `tests/file-${i}.test.mjs`);
  const full = {
    transport: 'hosted',
    result: { plan: { tests: ['tests/a.test.mjs'], deferredTests, reason: 'r' } },
  };
  const slim = slimReceipt(full);
  assert.deepEqual(slim.result.plan, { tests: ['tests/a.test.mjs'], reason: 'r', deferredTestCount: 800 });
  assert(chars(slim) * 20 < chars(full));
});

test('peers keeps the evidence once', () => {
  const items = [{ noticeId: 'n', file: 'a', participants: [{ lane: 'x' }] }];
  const slim = slimReceipt({
    transport: 'hosted',
    result: {
      unacknowledgedOverlaps: { laneId, head: sha, count: 1, items },
      peerEvidence: { count: 1, items },
    },
  });
  assert(!('unacknowledgedOverlaps' in slim.result), 'retired list dropped');
  assert.deepEqual(slim.result.peerEvidence.items, items);
});

test('native and non-object receipts pass through untouched', () => {
  const native = { transport: 'native', overlapNotice: { required: false, choices: {} } };
  assert.equal(slimReceipt(native), native);
  assert.equal(slimReceipt(undefined), undefined);
  assert.deepEqual(slimReceipt([1]), [1]);
});

// Healthy receipts, shaped like the live ones (2026-11-06): start, save, sync and a landed landing.
const opId = randomUUID();
const laneRoot = `/srv/forge/work/nanthai-forge.forge-client/lanes/${laneId}`; // about the length of a real root
const envelope = (action, result, extra) => ({
  schema: 1,
  cliCommit: sha,
  transport: 'hosted',
  action,
  operationId: opId,
  resolved: { operationId: opId },
  result,
  ...extra,
});
const quiet = {
  unacknowledgedOverlaps: {
    laneId,
    head: sha,
    count: 0,
    blockingCount: 0,
    advisoryCount: 0,
    coverage: 'hosted-incomplete',
    items: [],
  },
  behindMain: {
    head: sha,
    baseHead: sha,
    baseSequence: 30000,
    commits: 0,
    conflictingPaths: [],
    more: 0,
    coverage: 'hosted',
  },
};
const lane = {
  schema: 2,
  projectId: 'p'.repeat(32),
  laneId,
  intentId: randomUUID(),
  head: sha,
  version: 0,
  sourceVersion: 0,
  lifecycleVersion: 0,
  state: 'active',
  base: { head: sha, receiptId: randomUUID() },
  authority: { mode: 'server', epoch: 1 },
};
const healthy = {
  start: envelope(
    'start',
    {
      schema: 1,
      operationId: opId,
      intentId: lane.intentId,
      lane,
      at: '2026-11-06T06:05:05.722Z',
      path: laneRoot,
      checkout: {
        root: laneRoot,
        downloadedObjects: 0,
        downloadedBytes: 0,
        machineObjects: 3511,
        replayed: false,
      },
      dependencies: {
        status: 'linked',
        key: 'k'.repeat(24),
        path: '/cache/forge/deps/npm-k/node_modules',
      },
      planning: { updated: false, status: 'in-progress' },
    },
    {
      ...quiet,
      localLanes: {
        idle: [
          {
            laneId: randomUUID(),
            idleHours: 28.1,
            root: '/work/forge-storage-76dd1957',
          },
          { laneId: randomUUID(), idleHours: 6.8, root: laneRoot },
        ],
        pruned: { count: 0, bytes: 0 },
      },
    },
  ),
  save: envelope('save', save().result, quiet),
  sync: envelope(
    'sync',
    {
      source: {
        at: '2026-11-06T06:12:22.710Z',
        attemptId: randomUUID(),
        outcome: {
          result: {
            at: 'x',
            from: { head: sha },
            lane,
            operationId: opId,
            resolution: null,
            schema: 1,
            status: 'up-to-date',
          },
          status: 'completed',
        },
      },
      applied: { ...lane, root: laneRoot, downloadedObjects: 0, downloadedBytes: 0, replayed: false },
      timing: { totalMs: 516, stepsMs: { settle: 28, submit: 244, hostedWait: 1, apply: 243 } },
    },
    quiet,
  ),
  land: envelope(
    'finish',
    {
      phase: 'finish',
      composeOperationId: randomUUID(),
      submission: {
        schema: 1,
        projectId: 'p'.repeat(32),
        id: randomUUID(),
        operationId: opId,
        actor: 'user_3K43XGIwRSPIRQp8tbEEyZUks5l',
        at: '2026-11-05T10:35:30.250Z',
        request: {
          operationId: opId,
          governanceVersion: 1,
          agent: true,
          channel: 'main',
          candidateId: randomUUID(),
          check: { kind: 'request' },
        },
        sequence: 479,
        priority: 'normal',
        version: 16,
        phase: 'landed',
        testFiles: { counts: { total: 811, failed: 0, flaky: 0 }, failed: [], flaky: [] },
        timing: { submittedAt: 'a', selectedAt: 'b', settledAt: 'c' },
        observation: { state: 'landed', pendingReason: null, cause: null },
        acceptance: { receiptId: randomUUID(), head: sha },
        error: null,
      },
      defaults: { preflight: { reason: 'saved changed paths are unavailable', status: 'unavailable' } },
      replayParameters: { laneId, message: 'm'.repeat(300), operationId: opId },
      pendingAttempt: null,
      queueAheadSelection: null,
    },
    {
      ...quiet,
      landTiming: {
        invokedAt: 'a',
        submittedAt: 'b',
        totalMs: 11448,
        stepsMs: { spawn: 1006, connect: 1174 },
      },
    },
  ),
};

const waited = envelope(
  'observe',
  {
    status: 'terminal',
    successful: true,
    submissions: [
      {
        type: 'submission',
        id: randomUUID(),
        operationId: opId,
        version: 16,
        submission: healthy.land.result.submission,
      },
    ],
    resnapshot: false,
    cursor: 'c'.repeat(160),
  },
  quiet,
);
healthy.wait = waited;

test('a healthy start, save, sync, wait and landing print about 300 characters each', t => {
  const sizes = Object.fromEntries(
    Object.entries(healthy).map(([name, full]) => [name, chars(slimReceipt(full))]),
  );
  t.diagnostic(
    Object.entries(healthy)
      .map(([name, full]) => `${name} ${chars(full)} -> ${sizes[name]}`)
      .join(', '),
  );
  const ordered = Object.values(sizes).sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)];
  assert(median <= MEDIAN_RECEIPT, `median ${median}: ${JSON.stringify(sizes)}`);
  for (const [name, size] of Object.entries(sizes)) assert(size <= MAX_HEALTHY_RECEIPT, `${name} ${size}`);
});

test('a healthy brief still names what the next step needs', () => {
  const start = slimReceipt(healthy.start);
  assert.equal(start.operationId, opId);
  assert.equal(start.result.lane.laneId, laneId);
  assert.equal(start.result.path, laneRoot);
  assert.deepEqual(start.result.checkout, { downloadedObjects: 0 }, 'the warm-start proof stays');
  assert.deepEqual(start.localLanes, { idle: 2 }, 'the stderr hint lists them; the count stays');
  const rules =
    'nforge agent ROOT capabilities or MCP forge_work_overview {command:{action:"capabilities"}}.';
  const withRules = slimReceipt({
    ...healthy.start,
    result: { ...healthy.start.result, rules },
  });
  assert.equal(withRules.result.rules, rules, 'the compact checkout receipt keeps the project rules pointer');
  assert(Buffer.byteLength(JSON.stringify(withRules)) - Buffer.byteLength(JSON.stringify(start)) <= 200);
  // A start whose checkout did not finish keeps its reason and continuation, never a bare `{}`.
  const continuation = { reason: 'failed', path: laneRoot, command: 'nforge agent ROOT start …' };
  const stalled = slimReceipt({
    ...healthy.start,
    result: {
      ...healthy.start.result,
      checkout: { status: 'incomplete', reason: 'failed', code: 'CHECKOUT_FAILED', message: 'Synthetic.' },
      dependencies: { status: 'pending' },
      continuation,
    },
  });
  assert.equal(stalled.result.checkout.status, 'incomplete');
  assert.equal(stalled.result.checkout.code, 'CHECKOUT_FAILED');
  assert.deepEqual(stalled.result.continuation, continuation);
  assert.deepEqual(stalled.result.dependencies, { status: 'pending' });
  const saved = slimReceipt(healthy.save);
  assert.equal(saved.result.outcome.result.head, sha);
  const synced = slimReceipt(healthy.sync);
  assert.deepEqual(synced.result, { status: 'up-to-date', head: lane.head, totalMs: 516 });
  const landed = slimReceipt(healthy.land);
  assert.equal(landed.result.submission.phase, 'landed');
  assert.equal(
    landed.result.submission.acceptance.receiptId,
    healthy.land.result.submission.acceptance.receiptId,
  );
  assert.equal(landed.result.submission.acceptance.head, sha);
  assert.equal(landed.result.submission.selfReportedTestFiles, 811);
  const noReports = structuredClone(healthy.land);
  noReports.result.submission.testFiles.counts = { total: 0, failed: 0, flaky: 0 };
  assert.equal(slimReceipt(noReports).result.submission.selfReportedTestFiles, null);
  assert(!('landTiming' in landed), 'timings are --detail diagnostics');
  const observed = slimReceipt(healthy.wait).result;
  assert.deepEqual(Object.keys(observed), ['status', 'successful', 'submissions']);
  assert(!('operationId' in observed.submissions[0]), 'the one landing is the one waited for');
  assert.equal(observed.submissions[0].submission.acceptance.head, sha);
  const unfinished = structuredClone(healthy.wait);
  unfinished.result.status = 'timeout';
  unfinished.result.successful = false;
  assert('cursor' in slimReceipt(unfinished).result, 'an unfinished wait keeps its cursor to resume');
});

test('anything that is not a healthy outcome keeps its detail', t => {
  // A failed test file, a landing still in progress, a conflicted sync, a Lane behind main and a failed save.
  const failed = structuredClone(healthy.land);
  failed.result.submission.testFiles = {
    counts: { total: 3, failed: 1, flaky: 0 },
    failed: ['tests/a.test.mjs'],
    flaky: [],
  };
  assert.deepEqual(slimReceipt(failed).result.submission.testFiles.failed, ['tests/a.test.mjs']);
  // A flaky file that passed on retry keeps its name and the start of its error, not its attempt timings.
  const flaky = structuredClone(healthy.wait);
  flaky.result.submissions[0].submission.testFiles = {
    counts: { total: 3, failed: 0, flaky: 1 },
    failed: [],
    flaky: [
      {
        file: 'tests/b.test.mjs',
        report: { firstError: 'e'.repeat(500), attempts: [{ failed: true }, { failed: false }] },
      },
    ],
  };
  const kept = slimReceipt(flaky).result.submissions[0].submission.testFiles.flaky[0];
  assert.deepEqual(Object.keys(kept), ['file', 'retry', 'firstError']);
  assert.equal(kept.retry, 'passed', 'the landing result says the retry passed');
  assert.equal(kept.firstError.length, 160);
  // Without recorded attempts the file is still only listed because it ended passing.
  flaky.result.submissions[0].submission.testFiles.flaky[0].report = { firstError: 'x' };
  assert.equal(slimReceipt(flaky).result.submissions[0].submission.testFiles.flaky[0].retry, 'passed');
  const queued = structuredClone(healthy.land);
  queued.result.submission.phase = 'ready';
  delete queued.result.submission.acceptance;
  Object.assign(queued.result, {
    inProgress: true,
    waitCommand: `nforge agent '${laneRoot}' wait '{"operationIds":["${opId}"],"until":"acceptance"}'`,
    command: `nforge agent '${laneRoot}' wait '{"operationIds":["${opId}"],"until":"acceptance"}'`,
    instruction: 'Work is unfinished. '.repeat(12),
    queueAheadSelection: {
      ahead: [{ head: sha, id: laneId, inputs: { sha256: sha, size: 371 }, status: 'ready' }],
      main: sha,
      mine: sha,
      more: false,
    },
  });
  const pending = slimReceipt(queued).result;
  t.diagnostic(`unfinished landing ${chars(queued)} -> ${chars(slimReceipt(queued))}`);
  assert.equal(pending.replayParameters.laneId, laneId, 'recovery needs the replay parameters');
  assert.match(pending.waitCommand, /wait '/);
  assert(pending.command && pending.instruction, 'the continuation stays complete');
  assert.deepEqual(
    pending.submission.request,
    { agent: true, check: { kind: 'request' } },
    'authority facts only',
  );
  assert.equal(pending.submission.phase, 'ready');
  assert.deepEqual(pending.queueAheadSelection, { ahead: 1, more: false });
  const conflict = structuredClone(healthy.sync);
  conflict.result.source.outcome.result.status = 'conflict';
  assert.equal(slimReceipt(conflict).result.source.outcome.result.status, 'conflict');
  const behind = structuredClone(healthy.save);
  behind.behindMain = {
    head: sha,
    baseHead: sha,
    baseSequence: 1,
    commits: 4,
    conflictingPaths: ['a.ts'],
    more: 0,
    coverage: 'hosted',
  };
  assert.deepEqual(slimReceipt(behind).behindMain, { commits: 4, conflictingPaths: ['a.ts'], more: 0 });
  const refused = structuredClone(healthy.save);
  refused.result.outcome = { status: 'failed', error: { code: 'WORK_CONFLICT' } };
  assert.equal(slimReceipt(refused).result.outcome.error.code, 'WORK_CONFLICT');
  const resolved = structuredClone(healthy.save);
  resolved.resolved = { operationId: opId, accept: { channel: 'main', expectedPrevious: null } };
  assert.deepEqual(
    slimReceipt(resolved).resolved.accept,
    { channel: 'main', expectedPrevious: null },
    'replay inputs stay',
  );
});

test('a submitted landing names its composed State and passed static checks, not their records (Issue 47558a99)', () => {
  const queued = structuredClone(healthy.land);
  queued.result.submission.phase = 'composing';
  delete queued.result.submission.acceptance;
  const check = (name, outcome = 'passed') => ({
    command: ['npm', 'run', '-s', name],
    ms: 400,
    name,
    outcome,
  });
  Object.assign(queued.result, {
    inProgress: true,
    command: `nforge agent '${laneRoot}' wait '{"operationIds":["${opId}"],"until":"acceptance"}'`,
    progress: {
      state: {},
      terminal: {
        at: '2026-11-19T12:42:11.236Z',
        attemptId: randomUUID(),
        outcome: {
          status: 'completed',
          result: {
            algorithm: `forge-native-compose-v1@${sha}`,
            base: { head: sha, receiptId: randomUUID() },
            governance: {
              ownerInputs: true,
              paths: ['src/a.ts', 'src/b.ts', 'tests/a.test.mjs'],
              version: 1,
            },
            inputs: { sha256: sha, size: 371 },
            kind: 'candidate',
            result: { head: sha, status: 'clean' },
            version: 0,
          },
        },
      },
    },
    defaults: {
      preflight: { status: 'incomplete', tests: 31, static: [check('check'), check('lint')], at: 'x' },
    },
  });
  const before = chars(queued),
    pending = slimReceipt(queued).result;
  assert.deepEqual(pending.progress, { composed: { status: 'clean', head: sha } });
  assert.equal(pending.defaults.preflight.static, 'passed: check, lint');
  assert.equal(pending.defaults.preflight.tests, 31);
  assert(
    chars(slimReceipt(queued)) < before - 600,
    'the compose record and check commands leave the brief copy',
  );
  const failing = structuredClone(queued);
  failing.result.defaults.preflight.static[1].outcome = 'failed';
  failing.result.progress.terminal.outcome.status = 'failed';
  const kept = slimReceipt(failing).result;
  assert.equal(kept.defaults.preflight.static[1].outcome, 'failed', 'a failed check keeps its command');
  assert.equal(
    kept.progress.terminal.outcome.status,
    'failed',
    'an unfinished or failed compose keeps its record',
  );
});

test('queued and durable composing submits print one exact continuation within 1,200 characters', t => {
  const root = `/srv/workspaces/nanthai/forge/nanthai-forge.forge-client/lanes/${laneId}`;
  const targets = { operationIds: [opId], until: 'acceptance' };
  const foreground = operationWait(root, targets);
  const budgetSeconds = 7080;
  const background = operationWait(root, { ...targets, timeoutSeconds: budgetSeconds });
  const wake = {
    ...background,
    wake: { delivery: 'background-exit', command: background.command, budgetSeconds },
    instruction: 'Run the command in the background and stay with the original operation. '.repeat(8),
  };
  for (const [phase, continuation] of [
    ['queued', foreground],
    ['queued', wake],
    ['composing', foreground],
    ['composing', wake],
  ]) {
    const full = structuredClone(healthy.land);
    full.as = 'synthetic/warm-quail';
    if (phase === 'composing') {
      full.behindMain.commits = 3;
      full.behindMain.conflictingPaths = ['docs/agents/workflow.d/sections/2200-asynchronous-land.md'];
    }
    const { submission } = full.result;
    delete submission.acceptance;
    delete submission.testFiles;
    Object.assign(submission, {
      phase,
      ...(phase === 'composing' ? { preparing: true } : {}),
      message: 'm'.repeat(1024),
      observation: { state: 'pending', pendingReason: 'queued', cause: null },
      counts: { r2: [3, 11, 11000] },
    });
    Object.assign(full.result, {
      ...continuation,
      ...(phase === 'queued'
        ? {
            queuePosition: 3,
            queue: { position: 3, total: 6, entriesAhead: 2, predecessor: { id: randomUUID() } },
            queueAheadSelection: { ahead: [{ head: sha, id: randomUUID() }], more: false },
            queueAheadUnavailable: true,
          }
        : {}),
      landingState: { state: 'queued', label: 'Queued', nextStep: 'Waits for its turn on main.' },
      landingAdvice: 'Landing mode: fast; effective: fast. Nothing to do.',
      checkLogs: publicLogsNotice('synthetic/forge'),
      changedPaths: 3,
      progress: {
        terminal: { outcome: { status: 'completed', result: { result: { status: 'clean', head: sha } } } },
      },
      replayParameters: { operationId: opId, laneId, message: submission.message, save: true },
      defaults: {
        preflight: {
          status: 'advised',
          tests: 31,
          deferredTests: 1060,
          reason: 'over 2 min',
          local: 'trimmed by the local budget',
          run: `nforge agent '${root}' preflight '{"laneId":"${laneId}"}'`,
          selected: Array.from({ length: 20 }, (_, i) => `tests/forge-${i}.test.mjs`),
          static: Array.from({ length: 11 }, (_, i) => ({
            name: `static check ${i}`,
            outcome: 'passed',
          })),
          quick: { ran: 5, notStarted: 26, budgetSeconds: 90, seconds: 94, outcome: 'incomplete' },
        },
      },
    });
    const options = { agent: true, detail: false, landChild: false };
    const brief = printedReceipt(full, options);
    const mode = `${phase} ${continuation.wake ? 'background wake' : 'foreground wait'}`;
    t.diagnostic(`${mode}: ${chars(full)} -> ${chars(brief)} chars`);
    assert(chars(brief) <= MAX_QUEUED_SUBMIT, `${mode}: ${chars(brief)} chars`);
    assert.equal(brief.operationId, opId);
    assert.equal(brief.result.submission.id, submission.id);
    assert.equal(brief.result.submission.phase, phase);
    assert.deepEqual(brief.result.next, continuation.wake ? undefined : continuation.next);
    assert.equal(brief.result.wake?.command ?? brief.result.waitCommand, continuation.command);
    assert.equal(brief.result.command, undefined);
    assert.equal(brief.result.waitCommand, continuation.wake ? undefined : continuation.command);
    assert.equal(brief.result.replayParameters, undefined);
    assert.equal(brief.result.queuePosition, phase === 'queued' ? 3 : undefined);
    assert.deepEqual(brief.result.queue, phase === 'queued' ? { total: 6 } : undefined);
    if (phase === 'composing')
      assert.deepEqual(brief.behindMain.conflictingPaths, full.behindMain.conflictingPaths);
    assert.equal(brief.result.checkLogs, 'Public GitHub Actions logs: synthetic/forge.');
    assert.equal(brief.result.landingAdvice, 'Landing mode: fast.');
    assert.equal(brief.result.progress.composed.head, sha);
    assert.equal(brief.result.defaults.preflight.staticPassed, 11);
    assert.equal(brief.result.defaults.preflight.quick.ran, 5);
    assert.equal(agentDeadEnd(brief), undefined);
    assert.deepEqual(slimReceipt(full), brief);
    assert.equal(printedReceipt(full, { ...options, detail: true }), full);
    assert.equal(printedReceipt(full, { ...options, landChild: true }), full);
  }
});

test('source preparation and queued conflict advice keep their original replay and recovery', () => {
  const replayParameters = {
    operationId: opId,
    laneId,
    message: "Summary\n\nBody with 'quotes'.",
    save: true,
    with: [randomUUID()],
  };
  const command = `nforge agent ${shellQuote(laneRoot)} finish ${shellQuote(JSON.stringify(replayParameters))}`;
  const preparation = envelope('finish', {
    phase: 'compose',
    inProgress: true,
    progress: { status: 'retryable' },
    next: { action: 'finish', ...replayParameters },
    command,
    replayParameters,
  });
  assert.deepEqual(slimReceipt(preparation).result, preparation.result);

  const composing = envelope('finish', {
    ...preparation.result,
    phase: 'finish',
    submission: {
      id: randomUUID(),
      phase: 'composing',
      preparing: true,
      observation: { state: 'pending', pendingReason: 'queued' },
    },
  });
  const retryable = slimReceipt(composing).result;
  assert.deepEqual(retryable.next, preparation.result.next);
  assert.deepEqual(retryable.replayParameters, replayParameters);
  assert.equal(retryable.command, command);

  const wait = operationWait(laneRoot, { operationIds: [opId], until: 'acceptance' });
  const queued = envelope('finish', {
    phase: 'finish',
    submission: {
      id: randomUUID(),
      phase: 'queued',
      observation: { state: 'pending', pendingReason: 'queued', cause: null },
    },
    ...wait,
    wouldConflict: { paths: ['src/change.ts'] },
    replayParameters,
  });
  const brief = slimReceipt(queued).result;
  assert.deepEqual(brief.replayParameters, replayParameters);
  assert.deepEqual(brief.wouldConflict, queued.result.wouldConflict);
  assert.equal(brief.waitCommand, wait.waitCommand);
});

test('a queued submit preserves the preflight commands associated with an incomplete or failed local run', () => {
  const wait = operationWait(laneRoot, { operationIds: [opId], until: 'acceptance' });
  const command = `nforge agent '${laneRoot}' preflight '{"laneId":"${laneId}"}'`;
  for (const preflight of [
    { status: 'incomplete', finish: command },
    { status: 'advised', lastRun: { passed: false }, run: command },
    { status: 'advised', static: [{ name: 'lint', outcome: 'timed-out' }], run: command },
  ]) {
    const queued = envelope('finish', {
      phase: 'finish',
      submission: {
        id: randomUUID(),
        phase: 'queued',
        observation: { state: 'pending', pendingReason: 'queued' },
      },
      ...wait,
      defaults: { preflight },
    });
    const brief = slimReceipt(queued).result;
    assert.equal(brief.waitCommand, wait.waitCommand);
    assert.deepEqual(brief.defaults.preflight, preflight);
  }
});

test('--detail data is only dropped from the printed copy', () => {
  const before = JSON.stringify(healthy.save);
  slimReceipt(healthy.save);
  assert.equal(JSON.stringify(healthy.save), before, 'the in-process receipt is never mutated');
});

test('the land submitter prints the full receipt its parent process parses', () => {
  // The child's stdout is machine input, so only a process that a person or agent reads is shortened.
  const full = save({});
  assert.equal(printedReceipt(full, { agent: true, detail: false, landChild: true }), full);
  assert.equal(printedReceipt(full, { agent: true, detail: true, landChild: false }), full);
  assert.equal(printedReceipt(full, { agent: false, detail: false, landChild: false }), full);
  const printed = printedReceipt(full, { agent: true, detail: false, landChild: false });
  assert.notEqual(printed, full);
});

test('a settling save prints its note and total only: the common split-save path stays inside the budget (Issue 47558a99)', () => {
  const operationId = randomUUID(),
    laneId = randomUUID();
  const receipt = {
    schema: 1,
    transport: 'hosted',
    action: 'save',
    operationId,
    resolved: null,
    result: {
      status: 'settling',
      operationId,
      laneId,
      note: 'Saved: the server is finishing this save now. Your next command here reports its outcome, including any failure.',
      timing: {
        totalMs: 2659,
        stepsMs: { settle: 90, capture: 460, prepare: 458, upload: 374, submit: 1277 },
      },
    },
  };
  const printed = slimReceipt(structuredClone(receipt));
  assert.deepEqual(printed.result, { status: 'settling', note: receipt.result.note, totalMs: 2659 });
  assert.equal(printed.operationId, operationId, 'the replay key stays');
  assert(JSON.stringify(printed).length <= 300, `${JSON.stringify(printed).length} characters`);
  assert.deepEqual(
    printedReceipt(structuredClone(receipt), { agent: true, detail: true, landChild: false }).result,
    receipt.result,
  );
});

test('a timed save keeps its total and drops the split, as sync does (friction f15db544)', () => {
  const timing = {
    totalMs: 2950,
    stepsMs: { settle: 0, capture: 40, prepare: 700, upload: 900, submit: 300, hostedWait: 1000, apply: 10 },
  };
  const full = save();
  full.result = { ...full.result, timing };
  const slim = slimReceipt(full);
  assert.equal(slim.result.totalMs, 2950);
  assert.equal(slim.result.timing, undefined, 'the split stays in --detail');
  assert.equal(slim.result.outcome.result.head, sha);
  assert.equal(slimReceipt(save()).result.totalMs, undefined, 'an untimed save prints no total');
});

test('CLI and MCP compact saves and landings keep early protected-path approval visible without detail', () => {
  const notice = {
    message: 'Landing will need approval from the project owner.',
    paths: ['netlify.toml'],
    more: 0,
    coverage: 'complete',
  };
  for (const [action, result] of [
    ['save', { outcome: { status: 'completed', result: { head: sha } } }],
    ['save', { status: 'settling' }],
    ['finish', { submission: { phase: 'landed', acceptance: { receiptId: opId, head: sha } } }],
  ]) {
    const compact = slimReceipt({
      transport: 'hosted',
      action,
      result: { ...result, protectedPathNotice: notice },
    });
    assert.deepEqual(compact.result.protectedPathNotice, notice);
  }
});

test('Lane status leads with the Lane; project fix-needed notices follow with receipt, age and tests (Issue a8f93b5e)', () => {
  const notice = (day, test) => ({
    at: `2026-11-${day}T08:50:06.970Z`,
    auditRunId: randomUUID(),
    head: 'd'.repeat(64),
    intentId: randomUUID(),
    receiptId: `${day}aff2aac-f9ab-4192-8f90-585c8cbebb3a`,
    state: 'needs-fix',
    summary: `Fix needed for receipt ${day}aff2aac: ${test} failed on ${'d'.repeat(64)} (run …); passed on …`,
    tests: [test],
    undo: `nforge agent ROOT start '{"intentId":"${randomUUID()}"}'`,
  });
  const needsFix = [notice(10, 'tests/drill-red.test.mjs'), notice(17, 'tests/retired-tables.test.mjs')];
  const lane = {
    head: 'a'.repeat(64),
    lastActivityAt: new Date().toISOString(),
    lifecycleVersion: 0,
    sourceVersion: 1,
    state: 'active',
    version: 1,
  };
  const receipt = {
    schema: 1,
    transport: 'hosted',
    action: 'status',
    operationId: null,
    result: { ...lane, needsFix, githubMirror: { status: 'synced' }, local: { running: null } },
  };
  const printed = slimReceipt(structuredClone(receipt)).result;
  const keys = Object.keys(printed);
  assert.deepEqual(keys.slice(0, 6), Object.keys(lane), 'the Lane comes first');
  assert(
    keys.indexOf('local') < keys.indexOf('projectNotices'),
    'its local continuation before project notices',
  );
  assert.equal(keys.at(-1), 'projectNotices');
  assert.equal(printed.needsFix, undefined);
  assert.equal(printed.projectNotices.scope, 'project');
  assert.deepEqual(
    printed.projectNotices.needsFix.map(item => [item.receiptId, /^\d+d$/.test(item.age), item.tests]),
    [
      ['10aff2aa', true, ['tests/drill-red.test.mjs']],
      ['17aff2aa', true, ['tests/retired-tables.test.mjs']],
    ],
  );
  assert(JSON.stringify(printed).length < JSON.stringify(receipt.result).length / 2);
  // Every notice stays reachable in full with --detail, and project status (no Lane) keeps them in full.
  assert.deepEqual(
    printedReceipt(structuredClone(receipt), { agent: true, detail: true, landChild: false }).result.needsFix,
    needsFix,
  );
  const project = { ...receipt, result: { needsFix, githubMirror: { status: 'synced' } } };
  assert.deepEqual(slimReceipt(structuredClone(project)).result.needsFix, needsFix);
});

test('compact landings keep weakened-test flags, pending (preflight on) and landed (Issue 11901a0c)', () => {
  const weakenedTests = {
    count: 1,
    flags: [
      {
        file: 'tests/a.test.mjs',
        test: 't',
        kind: 'assertions-removed',
        assertions: { before: 2, after: 1 },
      },
    ],
    cleared: 'b moved to c.test.mjs',
  };
  const pending = slimReceipt({
    transport: 'hosted',
    action: 'land',
    result: {
      inProgress: true,
      command: 'nforge agent . wait',
      submission: { phase: 'checking' },
      defaults: { preflight: { status: 'incomplete', tests: 3, at: 'x' }, weakenedTests },
    },
  }).result;
  assert.deepEqual(pending.defaults.weakenedTests, weakenedTests);
  assert.equal(pending.defaults.preflight.tests, 3);
  const landed = slimReceipt({
    transport: 'hosted',
    action: 'land',
    result: {
      submission: { phase: 'landed', acceptance: { receiptId: opId, head: sha } },
      defaults: { preflight: { status: 'incomplete', tests: 3 }, weakenedTests },
    },
  }).result;
  assert.deepEqual(landed.defaults.weakenedTests, weakenedTests);
  assert.equal(landed.defaults.preflight, undefined, 'a landed brief still drops the preflight record');
});

test('friction 28e84c06: brief land and observe replies keep a stopped GitHub mirror', () => {
  const mirrorStopped = {
    repository: 'synthetic/mirror',
    error: 'GITHUB_SYNC_HASH',
    state: 'a'.repeat(64),
    receiptId: '893d4653-e7a5-4d1b-8639-8f9ec839a8ee',
  };
  // The request is dropped by the brief reply, so its absence proves slimming ran.
  const submission = { phase: 'landed', acceptance: { receiptId: 'r1', head: 'h' }, request: { big: 'x' } };
  const hosted = receipt => slimReceipt({ transport: 'hosted', operationId: 'op1', ...receipt });
  const land = hosted({ action: 'land', result: { submission, mirrorStopped } });
  assert.equal(land.result.submission.request, undefined, 'the brief land reply ran');
  assert.deepEqual(land.result.mirrorStopped, mirrorStopped);
  const wait = hosted({ action: 'wait', result: { submission, mirrorStopped } });
  assert.deepEqual(wait.result.mirrorStopped, mirrorStopped);
  const observe = hosted({
    action: 'observe',
    result: {
      status: 'terminal',
      successful: true,
      submissions: [{ operationId: 'op1', submission, mirrorStopped }],
    },
  });
  assert.equal(observe.result.submissions[0].submission.request, undefined, 'the brief observe reply ran');
  assert.deepEqual(observe.result.submissions[0].mirrorStopped, mirrorStopped);
  const healthy = hosted({ action: 'land', result: { submission } });
  assert.equal(healthy.result.submission.request, undefined);
  assert.equal('mirrorStopped' in healthy.result, false);
});
