// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { ackAnswers, checkpointNudge, finishGates, unsavedMinutes } from '../dist/agent-default-gates.js';
import { preflightPlan, readPreflightReceipt, runPreflight } from '../dist/agent-preflight.js';

const lane = { laneId: '11111111-1111-4111-8111-111111111111', head: 'a'.repeat(64) };
const defaults = overrides => effectiveAgentDefaults(overrides);
const notice = (file, noticeId = `n-${file}`) => ({ noticeId, file });
const advice = ({ notices = [], paths = ['tests/b.test.mjs'], complete = true } = {}) => ({
  unacknowledgedOverlaps: { items: notices },
  changedPaths: { paths, complete },
});
function repo(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-gates-')),
    root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const all = {
    'package.json': '{"type":"module"}',
    'tests/b.test.mjs': "import test from 'node:test';\ntest('b', () => {});\n",
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}
const code = value => error => error.code === value || error.data?.code === value;

test('overlapGate: block refuses with the ack command, warn advises, off ignores; nothing without notices', t => {
  const root = repo(t);
  const pending = advice({ notices: [notice('src/x.ts')] });
  const off = { preflight: 'off' };
  assert.throws(
    () => finishGates(root, defaults({ ...off }), lane, pending),
    error =>
      code('OVERLAP_UNANSWERED')(error) &&
      error.message.includes('src/x.ts') &&
      error.message.includes(`ack '{"laneId":"${lane.laneId}"}'`),
  );
  const warned = finishGates(root, defaults({ ...off, overlapGate: 'warn' }), lane, pending);
  assert.equal(warned.overlap.status, 'unanswered');
  assert.deepEqual(warned.overlap.files, ['src/x.ts']);
  assert.deepEqual(finishGates(root, defaults({ ...off, overlapGate: 'off' }), lane, pending), {});
  assert.deepEqual(finishGates(root, defaults(off), lane, advice()), {});
  assert.deepEqual(finishGates(root, undefined, lane, pending), {}, 'older server: no defaults, no gate');
});

test('preflight: require refuses with the set and estimate; a passing run for this head lets finish through', t => {
  const root = repo(t);
  const gates = d => finishGates(root, defaults(d), lane, advice());
  assert.throws(
    () => gates({}),
    error =>
      code('PREFLIGHT_REQUIRED')(error) &&
      /Run the 1 affected test file\(s\) for saved head a{12} first \(about 1 min\)/.test(error.message) &&
      error.message.includes(`preflight '{"laneId":"${lane.laneId}"}'`),
  );
  const advised = gates({ preflight: 'advise' });
  assert.equal(advised.preflight.status, 'advised');
  assert.deepEqual(advised.preflight.selected, ['tests/b.test.mjs']);
  const over = gates({ preflightMaxMinutes: 0 });
  assert.equal(over.preflight.status, 'advised');
  assert.equal(over.preflight.reason, 'over 0 min');
  assert.deepEqual(gates({ preflight: 'off' }), {});
  // Missing data never blocks: unknown changed paths become an advisory.
  const unknown = finishGates(root, defaults({}), lane, advice({ complete: false }));
  assert.equal(unknown.preflight.status, 'unavailable');
  assert.deepEqual(finishGates(root, defaults({}), lane, advice({ paths: [] })), {}, 'empty selection');
  // Run it: the receipt is recorded for this saved head only.
  const plan = preflightPlan(root, advice().changedPaths);
  assert.equal(plan.status, 'planned');
  assert.match(plan.command, /^node --test --test-concurrency=1 tests\/b\.test\.mjs$/);
  const receipt = runPreflight(root, lane.laneId, lane.head, plan);
  assert.equal(receipt.passed, true);
  assert.deepEqual(readPreflightReceipt(root, lane.laneId), receipt);
  assert.equal(gates({}).preflight.status, 'passed');
  assert.throws(
    () => finishGates(root, defaults({}), { ...lane, head: 'b'.repeat(64) }, advice()),
    code('PREFLIGHT_REQUIRED'),
    'a new saved head needs a new run',
  );
});

test('preflight: a failing run is recorded, and finish says the last run failed', t => {
  const root = repo(t, {
    'tests/b.test.mjs': "import test from 'node:test';\ntest('b', () => { throw new Error('red'); });\n",
  });
  const plan = preflightPlan(root, advice().changedPaths);
  const receipt = runPreflight(root, lane.laneId, lane.head, plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.exitCode, 1);
  assert.throws(
    () => finishGates(root, defaults({}), lane, advice()),
    error => code('PREFLIGHT_REQUIRED')(error) && error.message.includes('Its last run failed.'),
  );
});

test('ack answers every pending notice with ids that replay exactly', () => {
  const pending = advice({ notices: [notice('a.ts', 'n1'), notice('b.ts', 'n2')] });
  const first = ackAnswers(lane.laneId, pending, 'accept-order');
  assert.deepEqual(
    first.map(answer => [answer.noticeId, answer.choice]),
    [
      ['n1', 'accept-order'],
      ['n2', 'accept-order'],
    ],
  );
  assert.deepEqual(ackAnswers(lane.laneId, pending, 'accept-order'), first, 'stable operation ids');
  assert.notEqual(first[0].operationId, first[1].operationId);
  assert.equal(
    ackAnswers(lane.laneId, pending, 'split', 'moved to its own Lane')[0].text,
    'moved to its own Lane',
  );
});

test('checkpoint nudge: unsavedFor from local file times, nudge past the threshold, none when off', t => {
  const root = repo(t, { '.forge/hosted-lane.json': '{}', 'node_modules/x/index.js': '' });
  const saved = Date.parse('2026-10-30T20:00:00.000Z') / 1000;
  utimesSync(join(root, '.forge/hosted-lane.json'), saved, saved);
  for (const path of ['package.json', 'tests/b.test.mjs'])
    utimesSync(join(root, path), saved - 60, saved - 60);
  utimesSync(join(root, 'node_modules/x/index.js'), saved + 10, saved + 10);
  const now = (saved + 45 * 60) * 1000;
  assert.equal(unsavedMinutes(root, now), null, 'ignored directories never count');
  utimesSync(join(root, 'tests/b.test.mjs'), saved + 5 * 60, saved + 5 * 60);
  const minutes = unsavedMinutes(root, now);
  assert.equal(minutes, 40);
  const nudged = checkpointNudge(root, lane.laneId, defaults({}), minutes);
  assert.equal(nudged.unsavedFor, 40);
  assert.match(nudged.nudge, /^Unsaved edits for 40 min; save now: nforge agent .* save '\{"laneId":/);
  assert.deepEqual(checkpointNudge(root, lane.laneId, defaults({}), 10), { unsavedFor: 10 });
  assert.deepEqual(checkpointNudge(root, lane.laneId, defaults({ checkpointNudgeMinutes: 0 }), 400), {
    unsavedFor: 400,
  });
  assert.deepEqual(checkpointNudge(root, lane.laneId, defaults({}), null), {});
  assert.equal(unsavedMinutes(join(root, 'missing')), null, 'no checkout marker: nothing to say');
});
