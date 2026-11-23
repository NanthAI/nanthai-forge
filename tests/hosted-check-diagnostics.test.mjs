// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 0d14c456 friction triage: a check that ends without a verdict names its cause and who acts, a passed
// run quotes the failure it retried, and a silent running check says what Forge knows of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { noJobEvidenceReason } from '../dist/ci-provider-recovery.js';
import { summarizeCheckRun, CHECK_SUMMARY_BYTES } from '../dist/hosted-check-summary.js';
import { emptyLogNote, hostedCheckLog } from '../dist/hosted-check-log.js';
import { ActionsJobClient } from '../dist/hosted-actions-job-client.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const hash = 'a'.repeat(64);

test('061c0461: a run that ended with no shard report says how many reported and which log line tells Forge from GitHub', () => {
  const reason = noJobEvidenceReason({ conclusion: 'failure', reported: 0, shardCount: 12 });
  assert.match(
    reason,
    /^Actions completed \(failure\) without complete job evidence: 0 of 12 shards reported, code not judged\./,
  );
  assert.match(reason, /"Forge job API" names Forge's side/);
  const worst = noJobEvidenceReason({ conclusion: 'action_required', reported: 999, shardCount: 999 });
  assert(worst.length <= 200, `a summary clips at 200 characters (${worst.length})`);
  assert.match(
    noJobEvidenceReason({ reported: 2, shardCount: 4, failed: true }),
    /one reported a failing test, the others never reported/,
  );
  assert.doesNotMatch(
    noJobEvidenceReason({ reported: 2, shardCount: 4, failed: true }),
    /not judged/,
    'a failing test is a verdict',
  );
  assert.match(noJobEvidenceReason({}), /no shard plan was recorded/);
  assert.doesNotMatch(noJobEvidenceReason({}), /undefined|null/);
});

test('061c0461: the check summary a user receives keeps the log marker that names Forge job API', () => {
  const reason = noJobEvidenceReason({ conclusion: 'failure', reported: 0, shardCount: 12 });
  const summary = summarizeCheckRun({ ...flakyRun({}), status: 'runner-unavailable', failureReason: reason });
  assert.match(summary.failureReason, /"Forge job API" names Forge's side/);
});

test('061c0461: the runner log names Forge job API when its calls keep failing, not generic Actions infrastructure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new ActionsJobClient(
    'https://convex.invalid',
    randomUUID(),
    randomUUID(),
    async () =>
      // A 503 is what a saturated job API answers; the client retries then gives up.
      new Response(null, { status: 503 }),
  );
  client.token = 'synthetic';
  client.expires = Number.MAX_SAFE_INTEGER;
  const settled = client.call({ kind: 'session' }).then(
    () => assert.fail('the job API never answered'),
    error => error,
  );
  for (const ms of [1000, 2000]) {
    await turn();
    t.mock.timers.tick(ms);
  }
  const error = await settled;
  assert.equal(error.code, 'RUNNER_UNAVAILABLE');
  assert.match(error.message, /^Forge job API session unavailable after bounded retries\.$/);
});

const flakyRun = reports => ({
  id: randomUUID(),
  at: '2026-11-22T10:00:00.000Z',
  endedAt: '2026-11-22T10:08:30.000Z',
  status: 'passed',
  request: { candidateId: randomUUID(), expectedHead: hash },
  counts: { completed: 4, passed: 4, failed: 0 },
  plan: { shardCount: 4 },
  exitCode: 0,
  cost: { status: 'unknown' },
  contractReports: reports,
});

test('28dfeeb5: a passed run keeps the failure it retried, with the file, not only the log tail', () => {
  const summary = summarizeCheckRun(
    flakyRun({
      'tests/stable.test.mjs': { failed: false, flaky: false, durationMs: 10 },
      'tests/palette.test.mjs': {
        failed: false,
        flaky: true,
        durationMs: 50,
        firstError: 'AssertionError: expected  400px\n  got 399px   at palette.test.mjs:12',
      },
      'tests/quiet-flaky.test.mjs': { failed: false, flaky: true, durationMs: 20 },
    }),
  );
  assert.equal(summary.status, 'passed');
  assert.deepEqual(summary.flaky, ['tests/palette.test.mjs', 'tests/quiet-flaky.test.mjs']);
  assert.deepEqual(summary.retried, [
    {
      file: 'tests/palette.test.mjs',
      firstError: 'AssertionError: expected 400px got 399px at palette.test.mjs:12',
    },
  ]);
  assert.equal(
    summarizeCheckRun(flakyRun({ 'tests/a.test.mjs': { failed: false, flaky: false } })).retried,
    undefined,
    'a clean run carries no retried list',
  );
});

test('28dfeeb5: many flaky files quote at most five retried failures and the reply stays inside its byte budget', () => {
  const reports = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [
      `tests/flaky-${String(i).padStart(3, '0')}.test.mjs`,
      { failed: false, flaky: true, durationMs: 5, firstError: `boom ${i} ${'x'.repeat(2000)}` },
    ]),
  );
  const summary = summarizeCheckRun(flakyRun(reports));
  assert.equal(summary.retried.length, 5);
  assert(summary.retried.every(item => item.firstError.length <= 161));
  assert(JSON.stringify(summary).length <= CHECK_SUMMARY_BYTES);
});

const manifest = (status, extra = {}) => ({
  status,
  complete: false,
  providerUrl: 'https://github.com/synthetic/mirror/actions/runs/1',
  progress: { startedAt: '2026-11-22T16:09:00.000Z', shardsReported: 3, shardCount: 12 },
  ...extra,
});
const transportFor = body => ({
  query: async name =>
    name === 'projectHostedOutputRead:manifest' ? body : { page: [], isDone: true, continueCursor: '' },
  mutation: async () => assert.fail('an empty selection downloads nothing'),
});

test('05b5a2a9: a running check with no published output says since when, how many shards reported and where to look', async () => {
  const note = emptyLogNote(manifest('running'));
  assert.match(note, /The check is running \(started 2026-11-22T16:09:00.000Z, 3 of 12 shards reported\)/);
  assert.match(note, /no shard has published output yet/);
  assert.match(note, /https:\/\/github.com\/synthetic\/mirror\/actions\/runs\/1/);
  const read = await hostedCheckLog({ runId: randomUUID() }, transportFor(manifest('running')));
  assert.equal(read.text, '');
  assert.equal(read.note, note);
});

test('05b5a2a9: a finished check with no retained output keeps the plain note, and an old server without progress does too', () => {
  assert.match(emptyLogNote(manifest('passed')), /^Forge holds no retained output for this selection\./);
  assert.match(
    emptyLogNote(manifest('running', { progress: undefined })),
    /^Forge holds no retained output for this selection\./,
  );
});

test('28dfeeb5: the summary budget counts UTF-8 bytes, so multibyte retried failures never exceed it on the wire', () => {
  const reports = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [
      `tests/${'測'.repeat(60)}-${i}.test.mjs`,
      { failed: false, flaky: true, durationMs: 5, firstError: '誤'.repeat(300) },
    ]),
  );
  const summary = summarizeCheckRun(flakyRun(reports));
  assert(Buffer.byteLength(JSON.stringify(summary)) <= CHECK_SUMMARY_BYTES, 'bytes, not string units');
  assert(summary.retried.length > 0);
});

test('05b5a2a9: a filtered read of a silent shard says so for that selection and still carries the run progress', async () => {
  const filtered = emptyLogNote(manifest('running'), true);
  assert.match(filtered, /nothing is published for this selection yet/);
  assert.doesNotMatch(filtered, /no shard has published/);
  const read = await hostedCheckLog({ runId: randomUUID(), shard: 1 }, transportFor(manifest('running')));
  assert.match(read.note, /nothing is published for this selection yet/);
  assert.deepEqual(read.progress, {
    startedAt: '2026-11-22T16:09:00.000Z',
    shardsReported: 3,
    shardCount: 12,
  });
});
