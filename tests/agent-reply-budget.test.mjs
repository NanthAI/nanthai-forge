// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { printedReceipt, slimReceipt } from '../dist/receipt-slim.js';
import { replies, replyBytes, head } from './agent-reply-fixture.mjs';

const ledger = JSON.parse(readFileSync(new URL('./fixtures/agent-reply-budget.json', import.meta.url)));
test('the byte ratchet covers every common agent reply and has no unmeasured entry', () => {
  const actions = [
    'start',
    'save',
    'sync',
    'resolve',
    'land',
    'wait',
    'conflict',
    'preflight',
    'board',
  ].sort();
  assert.deepEqual(Object.keys(replies).sort(), actions);
  assert.deepEqual(Object.keys(ledger.before).sort(), actions);
  assert.deepEqual(Object.keys(ledger.maxBytes).sort(), actions);
});
for (const [action, full] of Object.entries(replies)) {
  test(`default ${action} reply bytes cannot grow past the ratcheted ledger (b078515d)`, t => {
    const actual = replyBytes(printedReceipt(full, { agent: true, detail: false, landChild: false }));
    t.diagnostic(`${action}: ${ledger.before[action]} -> ${actual} bytes`);
    assert(
      actual <= ledger.maxBytes[action],
      `${action}: ${actual} > ${ledger.maxBytes[action]}; fix growth or record the Issue decision and ratchet this entry`,
    );
  });
  test(`${action} --detail returns every original field without mutating the receipt`, () => {
    const original = structuredClone(full);
    slimReceipt(full);
    assert.deepEqual(full, original);
    assert.deepEqual(printedReceipt(full, { agent: true, detail: true, landChild: false }), original);
    assert.deepEqual(printedReceipt(full, { agent: true, detail: false, landChild: true }), original);
  });
}

test('conflict summaries keep paths, kinds, ordered hunk counts, source pins and the exact recovery', () => {
  const full = structuredClone(replies.conflict);
  full.result.conflict.files.push(
    { path: 'image.bin', kind: 'binary', content: null },
    { path: 'syntax.ts', kind: 'syntax', content: 'valid text without markers' },
    {
      path: 'separators.txt',
      content:
        '=======\n>>>>>>> no start\n<<<<<<< first\n=======\n>>>>>>> last\n<<<<<<< second\n=======\n>>>>>>> last\n',
    },
  );
  const compact = slimReceipt(full).result;
  assert.deepEqual(compact.conflict.files, [
    { path: 'src/a.ts', kind: 'text', hunkCount: 1 },
    { path: 'image.bin', kind: 'binary', hunkCount: null },
    { path: 'syntax.ts', kind: 'syntax', hunkCount: 0 },
    { path: 'separators.txt', kind: 'text', hunkCount: 2 },
  ]);
  assert.deepEqual(compact.source, full.result.source);
  assert.equal(compact.conflict.command, full.result.conflict.command);
  assert.equal(compact.conflict.workIn, full.result.conflict.workIn);
  assert.deepEqual(compact.conflict.automatic, full.result.conflict.automatic);
  assert.equal(compact.conflict.head, head);
});

test('board id read-more keeps the complete note and replies by default', () => {
  const message = { id: 'note', text: 'full note body '.repeat(15) };
  const reply = { id: 'reply', text: 'full reply body '.repeat(15) };
  const full = {
    ...replies.board,
    result: { status: 'ok', message, replies: [reply], moreReplies: false, notices: ['truncated summary'] },
  };
  const compact = printedReceipt(full, { agent: true, detail: false, landChild: false });
  assert.deepEqual(
    compact.result.message,
    message,
    'the notice read-more command still reveals the whole note',
  );
  assert.deepEqual(compact.result.replies, [reply]);
  assert.equal(compact.result.moreReplies, false);
});

test('preflight receipts keep decisive outcomes and recovery while counting repeated lists', () => {
  const full = structuredClone(replies.preflight);
  full.result.receipt = {
    passed: false,
    exitCode: 1,
    tests: 3,
    failure: { files: ['tests/a.test.mjs'], excerpt: 'expected result' },
    environment: { code: 'TOOLCHAIN_MISSING', next: 'install toolchain' },
    skipped: ['a', 'b'],
    stopped: ['b'],
    rerun: 'exact rerun',
    incomplete: { mustRun: 1, finish: 'exact finish', estimateMinutes: 1 },
  };
  const compact = slimReceipt(full).result;
  assert.equal(compact.plan.testCount, 80);
  assert.equal(compact.plan.deferredTestCount, 300);
  assert.equal(compact.plan.local.trimmedTestCount, 300);
  assert(!('tierTests' in compact.plan.local));
  assert.equal(compact.receipt.skippedCount, 2);
  assert.equal(compact.receipt.stoppedCount, 1);
  for (const field of ['passed', 'exitCode', 'tests', 'failure', 'environment', 'rerun', 'incomplete'])
    assert.deepEqual(compact.receipt[field], full.result.receipt[field]);
});

test('failed landings and waits preserve errors, failing files and continuation commands', () => {
  const full = structuredClone(replies.land);
  Object.assign(full.result.submission, {
    phase: 'terminal-failed',
    error: { code: 'CHECK_FAILED', message: 'test failure' },
    testFiles: {
      counts: { total: 800, failed: 1, flaky: 0 },
      failed: [{ file: 'tests/a.test.mjs', report: { firstError: 'full error' } }],
      flaky: [],
    },
  });
  full.result.command = 'exact recovery';
  for (const receipt of [
    full,
    {
      ...full,
      action: 'observe',
      result: {
        status: 'terminal',
        successful: false,
        submissions: [{ submission: full.result.submission }],
        command: 'exact recovery',
      },
    },
  ]) {
    const compact = slimReceipt(receipt).result;
    const submission = compact.submission ?? compact.submissions[0].submission;
    assert.deepEqual(submission.error, full.result.submission.error);
    assert.deepEqual(submission.testFiles.failed, full.result.submission.testFiles.failed);
    assert.equal(compact.command, 'exact recovery');
  }
});

test('unfinished landing preflight lists are compact without losing authority or replay inputs', () => {
  const full = structuredClone(replies.land);
  full.result.submission.phase = 'queued';
  full.result.inProgress = true;
  full.result.command = 'exact wait';
  full.result.replayParameters = { operationId: full.operationId, laneId: 'lane' };
  full.result.defaults.preflight = {
    status: 'incomplete',
    skipped: ['a', 'b'],
    incomplete: { finish: 'exact finish' },
  };
  const compact = slimReceipt(full).result;
  assert.equal(compact.defaults.preflight.skippedCount, 2);
  assert.deepEqual(compact.submission.request, full.result.submission.request);
  assert.equal(compact.command, 'exact wait');
  assert.deepEqual(compact.replayParameters, full.result.replayParameters);
  assert.equal(compact.defaults.preflight.incomplete.finish, 'exact finish');
});
