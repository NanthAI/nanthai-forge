// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { slimReceipt, printedReceipt } from '../dist/receipt-slim.js';
import { markOverlapShown, overlapBannerOnce } from '../dist/hosted-overlap-notice.js';

// Issue 47558a99: receipts leave the process without facts the agent already holds. Budgets are
// characters of the printed JSON (tokens are about chars / 4); raise one only with numbers on the Issue.
const SAVE_WITH_ADVISORY_OVERLAPS = 400; // 2026-11-06: a live save with 3 advisory overlaps was 6,180, then 1,744, now 281
const MEDIAN_RECEIPT = 300; // chars, healthy start/save/sync/land receipts (Issue 47558a99 target)
const MAX_HEALTHY_RECEIPT = 450; // the terminal wait and landing carry a receipt id and a State (64 hex)
const sha = 'a'.repeat(64);
const laneId = randomUUID();
const peer = n => ({ lane: randomUUID(), actor: 'someone', intent: `Peer change ${n}` });
const notice = (required, count = 3) => {
  const items = Array.from({ length: count }, (_, i) => ({
    noticeId: sha.replace(/a/g, String(i)),
    class: required ? 'blocking' : 'advisory',
    reason: 'unavailable',
    file: 'src/a.ts',
    participants: [{ lane: laneId, actor: 'me', intent: 'Mine' }, peer(i)],
    text: `advisory overlap: src/a.ts; Lane ${randomUUID()} (Peer change ${i}); unavailable.`,
    lanes: [laneId, randomUUID()],
  }));
  return {
    unacknowledgedOverlaps: {
      laneId,
      head: sha,
      count,
      blockingCount: required ? count : 0,
      advisoryCount: required ? 0 : count,
      coverage: 'hosted-incomplete',
      items,
    },
    overlapNotice: {
      required,
      summary: `${count} file overlap(s) between this Lane and other open Lanes.`,
      count,
      coverage: 'hosted-incomplete',
      items: items.map(item => ({
        ...item,
        with: item.participants.slice(1),
        participants: undefined,
        text: undefined,
        lanes: undefined,
      })),
      choices: { 'accept-order': 'Keep your change.', swap: 'Ask first.', split: 'Route around.' },
      acknowledge: `nforge agent '/root' overlap-acks '${JSON.stringify({ answers: items.map(i => ({ operationId: randomUUID(), laneId, noticeId: i.noticeId, choice: 'accept-order' })) })}'`,
      routeAround: `nforge agent '/root' overlap-acks '${JSON.stringify({ answers: items.map(i => ({ operationId: randomUUID(), laneId, noticeId: i.noticeId, choice: 'split' })) })}'`,
    },
  };
};
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

test('a save with advisory overlaps keeps every decision fact once', t => {
  const full = save(notice(false)),
    slim = slimReceipt(full);
  t.diagnostic(`save with 3 advisory overlaps: ${chars(full)} -> ${chars(slim)} chars`);
  assert(chars(slim) <= SAVE_WITH_ADVISORY_OVERLAPS, `${chars(slim)} chars`);
  // The count, the files and the saved head survive; per-peer detail is one `peers` read away.
  assert.deepEqual(slim.overlapNotice, { required: false, count: 3, files: ['src/a.ts'] });
  assert(!('unacknowledgedOverlaps' in slim), 'the notice carries the count');
  assert.equal(slim.result.outcome.result.head, sha);
  assert.equal(slim.result.outcome.status, 'completed');
  // An advisory notice needs no answer, so it carries no answer commands.
  assert(!('acknowledge' in slim.overlapNotice) && !('routeAround' in slim.overlapNotice));
  assert(!('behindMain' in slim), 'not behind main: nothing to say');
  assert(!('cliCommit' in slim) && !('schema' in slim) && !('transport' in slim) && !('resolved' in slim));
});

test('a blocking notice keeps its ready-to-run answers', () => {
  const full = save(notice(true)),
    slim = slimReceipt(full);
  assert.equal(slim.overlapNotice.required, true);
  assert.equal(slim.overlapNotice.acknowledge, full.overlapNotice.acknowledge);
  assert.equal(slim.overlapNotice.routeAround, full.overlapNotice.routeAround);
  assert(!('choices' in slim.overlapNotice));
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
  assert.deepEqual(slim.result.unacknowledgedOverlaps, { count: 1 });
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
  assert.deepEqual(landed.result.submission.testFiles, { counts: { total: 811, failed: 0, flaky: 0 } });
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
  assert.deepEqual(Object.keys(kept), ['file', 'firstError']);
  assert.equal(kept.firstError.length, 160);
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

test('--detail data is only dropped from the printed copy', () => {
  const before = JSON.stringify(healthy.save);
  slimReceipt(healthy.save);
  assert.equal(JSON.stringify(healthy.save), before, 'the in-process receipt is never mutated');
});

test('the land submitter prints the full receipt its parent process parses', () => {
  // Regression: the brief advisory notice has no `items`, and the land parent iterates them. The child's
  // stdout is machine input, so only a process that a person or agent reads is shortened.
  const full = save(notice(false));
  assert.equal(printedReceipt(full, { agent: true, detail: false, landChild: true }), full);
  assert.equal(printedReceipt(full, { agent: true, detail: true, landChild: false }), full);
  assert.equal(printedReceipt(full, { agent: false, detail: false, landChild: false }), full);
  const printed = printedReceipt(full, { agent: true, detail: false, landChild: false });
  assert.notEqual(printed, full);
  // Even a brief notice cannot crash the banner or the shown-notice bookkeeping.
  assert.equal(overlapBannerOnce(printed.overlapNotice), '');
  markOverlapShown(printed.overlapNotice);
});
