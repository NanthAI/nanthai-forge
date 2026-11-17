// SPDX-License-Identifier: Apache-2.0
// The Failed check screen's words (Item b030c3c5): the head's state and sentence come from the failure-cause contract,
// the agent chip shows the same cause and recovery an agent reads, and the copied prompt carries no log or path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { checkSentence, verdictState, agentReply, agentPrompt, nextLine } = await import(
  moduleUrl('../web/src/app/check/check-model.ts')
);
const { failureCause } = await import(moduleUrl('../src/check-failure-cause.ts'));

const laneId = '11111111-2222-4333-8444-555555555555';
const landing = (state, extra = {}) => ({
  submissionId: 's',
  operationId: 'o',
  phase: 'terminal-failed',
  state,
  label: state,
  nextStep: 'Read the failing output, fix in the same Lane and land again.',
  at: '2026-11-17T10:00:00.000Z',
  retryReason: null,
  error: null,
  receiptId: null,
  ...extra,
});
const run = failed => ({
  runId: 'r',
  status: 'failed',
  files: { total: 9, failed: failed.length, flaky: 0 },
  failed,
  flaky: [],
  timings: { wallSeconds: 331, shards: 8 },
  cost: null,
});
const read = (state, evidence, extra = {}) => ({
  laneId,
  title: 'Retry budget for fetch adapter',
  candidateId: 'c',
  landing: landing(state),
  run: evidence.run ? run(evidence.run.failed) : null,
  cause: failureCause({ landing: { state }, ...evidence }),
  main: evidence.main ?? null,
  lane: { count: 1, complete: true },
  ...extra,
});
const at = iso => iso.slice(11, 16);

test('a failed check on the change says so in the head, with the one next step', () => {
  const page = read('check-failed', {
    run: { status: 'failed', failed: [{ file: 'tests/fetch.test.ts', firstError: 'expected 4 to equal 3' }] },
    lane: { paths: ['src/fetch.ts'] },
    main: { result: 'passed', redSince: null },
  });
  assert.deepEqual(verdictState(page), { st: 'failed', word: 'Check failed, 1 file' });
  const sentence = checkSentence(page, at);
  assert.match(sentence.lead, /^Your change:/);
  assert.equal(sentence.rest, nextLine('fix-in-lane'));
});

test('main failing names the time it went red, in the reader clock', () => {
  const page = read('held-main-red', { main: { result: 'failed', redSince: '2026-11-17T09:41:00.000Z' } });
  assert.match(checkSentence(page, at).rest, /main has been failing since 09:41\./);
  assert.equal(verdictState(page).st, 'waiting');
});

test('a runner that never started says not started, not failed', () => {
  const page = read('waiting-for-runner', { main: { result: 'passed', redSince: null } });
  assert.deepEqual(verdictState(page), { st: 'stale', word: 'Not started' });
  assert.equal(checkSentence(page, at).rest, nextLine('wait'));
});

test('a landed check has nothing to explain and says it is on main', () => {
  const page = { ...read('landed', {}), landing: landing('landed', { phase: 'landed', receiptId: 'x' }) };
  assert.equal(page.cause, null);
  assert.equal(checkSentence(page, at).lead, 'Passed and on main.');
});

test('the agent chip shows the same cause, suspects and recovery an agent reads, with the recorded retry reason', () => {
  const page = read('stale-head', {});
  const reply = agentReply(page);
  assert.match(reply, /cause {5}main-moved/);
  assert.match(reply, /suspects {2}change not-judged, test not-judged, main yes, ci not-reported/);
  assert.match(reply, /"reason":"main-moved"/);
});

test('the copied prompt names the Lane, the cause and the read command, not the failing output', () => {
  const page = read('check-failed', {
    run: { status: 'failed', failed: [{ file: 'tests/fetch.test.ts', firstError: 'token=abc' }] },
    lane: { paths: ['src/fetch.ts'] },
  });
  const prompt = agentPrompt(page, 'tidepool');
  assert.match(prompt, /Lane “Retry budget for fetch adapter” in tidepool/);
  assert.match(prompt, new RegExp(`status '\\{"laneId":"${laneId}"\\}'`));
  assert.doesNotMatch(prompt, /token=abc/);
});
