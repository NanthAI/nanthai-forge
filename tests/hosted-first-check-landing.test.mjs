// SPDX-License-Identifier: Apache-2.0
// Land on the first (admission) check (Issue 7fe54c7c, owner decision 2026-11-06).
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { firstCheckRisk } from '../dist/first-check-risk.js';
const { revertMessage } = await import(moduleUrl('../convex/projectHostedCulprit.ts'));
const audit = await import(moduleUrl('../convex/projectHostedMainAudit.ts'));
const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-first-check',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const receipts = f =>
  [...f.tables.projectHostedAcceptances.values()]
    .map(r => JSON.parse(r.value))
    .sort((a, b) => a.snapshot.revision - b.snapshot.revision);
// Runners report the selection they ran; a full check reports scope "full".
const full = JSON.stringify({ scope: 'full', tests: [] });
async function drive(f, { until = () => false, skip = /MainAudit:start/ } = {}) {
  for (let tick = 0; !until(f); tick++) {
    assert(tick < 900, JSON.stringify(states(f).map(s => s.phase)));
    for (const run of f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending().find(t => !skip.test(t.name)) ?? null;
    if (!task) break;
    await f.execute(task);
  }
}
async function wave(t, options = {}) {
  const f = await batchesFixture(t, { batchMaxSize: null, admissionCheck: 'default', ...options, count: 0 });
  f.rawChecks.setPlanSelection(full);
  if (options.crossHeadReuse === false) {
    const project = f.tables.hostedProjects.get(f.projectId);
    const policy = project.autonomyPolicy;
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, hostedCrossHeadReuse: false } },
    });
  }
  for (let i = 0; i < (options.count ?? 2); i++) await f.add(i);
  await drive(f, { until: options.until });
  return f;
}
const runCount = f => f.runs().length;
const recheckReasons = f =>
  [...f.tables.projectHostedLandingRequests.values()].map(r => r.admission?.recheck ?? null);
const budget = f => ({
  transactions: f.counts.length,
  documentsRead: f.counts.reduce((n, c) => n + c.documents, 0),
  writes: f.counts.reduce((n, c) => n + c.writes, 0),
});
const disjoint = { memberPaths: ['src/a.ts', 'src/b.ts'], fileCount: 2 };

test('a change whose composition is clean and path-disjoint from what main gained lands on its admission run', async t => {
  const f = await wave(t, disjoint);
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.deepEqual(f.reuseDecisions, ['proof']);
  const [first, second] = receipts(f);
  assert.deepEqual(first.firstCheck, { landedOn: 'admission-run', mainMoved: false });
  assert.deepEqual(second.firstCheck, { landedOn: 'admission-run', mainMoved: true });
  assert.equal(second.crossHeadProof.algorithm, 'clean-disjoint-v1');
  assert.deepEqual(second.crossHeadProof.candidatePaths, ['src/b.ts']);
  assert.deepEqual(second.crossHeadProof.mainPaths, ['src/a.ts']);
  assert.equal(second.check.runId, second.crossHeadProof.runId, 'the receipt names the admission run');
  // Two admission runs and no second check (today: three runs, the recheck).
  assert.equal(runCount(f), 2);
  // The coalesced main audit for the first-check landing is armed now, not at the
  // 10-landing cadence; one audit covers every landing since the last green main.
  const row = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(row.firstCheck, second.snapshot.revision);
  const wakes = f.pending().filter(t => t.name === 'projectHostedMainAudit:start');
  assert.equal(wakes.length, 1);
  assert(wakes[0].scheduledTime <= Date.now());
});

test('first-check landing costs no more Convex calls or DB IO than the recheck it replaces', async t => {
  const fast = await wave(t, disjoint);
  const slow = await wave(t, { ...disjoint, crossHeadReuse: false });
  assert.deepEqual(slow.reuseDecisions, []);
  assert.deepEqual(receipts(slow)[1].firstCheck, { landedOn: 'recheck', reason: 'not-eligible' });
  assert.equal(runCount(slow), 3);
  const [a, b] = [budget(fast), budget(slow)];
  t.diagnostic(`first-check ${JSON.stringify(a)} recheck ${JSON.stringify(b)}`);
  for (const key of Object.keys(a)) assert(a[key] <= b[key], `${key}: ${a[key]} <= ${b[key]}`);
});

test('a path the change and main both touch rechecks and records path-overlap', async t => {
  // fixture/0 is in both changes (same bytes): byte-clean, not path-disjoint.
  const f = await wave(t, { memberPaths: ['src/a.ts', 'src/b.ts'], fileCount: 3 });
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.deepEqual(f.reuseDecisions, ['path-overlap']);
  assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason: 'path-overlap' });
  assert.equal(receipts(f)[1].crossHeadProof, undefined);
  assert.equal(runCount(f), 3);
});

for (const [name, memberPaths] of [
  ['the change', ['src/a.ts', 'web/tsconfig.json']],
  ['main', ['.github/workflows/check.yml', 'src/b.ts']],
])
  test(`a global-risk file in ${name} rechecks`, async t => {
    const f = await wave(t, { memberPaths, fileCount: 2 });
    assert.deepEqual(
      states(f).map(s => s.phase),
      ['landed', 'landed'],
    );
    assert.deepEqual(f.reuseDecisions, ['global-risk']);
    assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason: 'global-risk' });
    assert.equal(runCount(f), 3);
  });

test('a text conflict with main never lands on the first check', async t => {
  const f = await wave(t, { memberPaths: ['src/a.ts', 'src/a.ts'], fileCount: 2 });
  assert.equal(receipts(f).length, 1);
  assert.deepEqual(f.reuseDecisions, []);
  assert.deepEqual(
    states(f).map(s => [s.phase, s.error?.code ?? null]),
    [
      ['landed', null],
      ['terminal-failed', 'COMPOSITION_CONFLICT'],
    ],
  );
  assert.deepEqual(recheckReasons(f), [null, 'text-conflict']);
});

test('change-556 class: a path-disjoint semantic break reaches main, the prompt audit catches it and first-check landings stop', async t => {
  // A and B are each green alone and path-disjoint; B breaks a test of A only
  // when both are on main (Issue 7fe54c7c, change 556). C arrives meanwhile.
  const f = await wave(t, {
    memberPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    fileCount: 2,
    count: 3,
    until: f => receipts(f).length === 2,
  });
  const culprit = receipts(f)[1];
  assert.deepEqual(culprit.firstCheck, { landedOn: 'admission-run', mainMoved: true });
  // The prompt audit runs on the new main head (A+B), where the break shows.
  const wake = f.pending().find(t => t.name === 'projectHostedMainAudit:start');
  assert(wake.scheduledTime <= Date.now(), 'armed at once, not at the 10-landing cadence');
  f.patch('_scheduled_functions', wake._id, { state: { kind: 'success' } });
  await f.transaction('auditStart', audit.start, wake.args[0]);
  const auditRun = f.runs().find(r => r.gate?.mode === 'audit');
  assert.equal(auditRun.request.expectedHead, culprit.candidate.head);
  await f.fail(auditRun.id, 'tests/a-with-b.test.mjs');
  const row = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(row.red.head, culprit.candidate.head);
  // Classification (bisect, then a single clean culprit revert or fix-forward)
  // is hosted-culprit.test.mjs, including a culprit that landed on its first check.
  assert(f.pending().some(t => t.name === 'projectHostedCulprit:startRedClassification'));
  // While main is red, no change lands on its first check.
  await drive(f, { skip: /MainAudit:start|Culprit:/ });
  // C's proof, prepared while main was still green, is refused when it completes.
  assert.deepEqual(f.reuseDecisions, ['proof', 'proof']);
  assert.equal(recheckReasons(f)[2], 'main-red');
  assert.deepEqual(receipts(f)[2].firstCheck, { landedOn: 'recheck', reason: 'main-red' });
  assert.equal(receipts(f)[2].crossHeadProof, undefined);
  // Three admission runs, one coalesced audit and C's recheck: the same five
  // full runs as today's two rechecks plus a cadence audit would cost.
  assert.equal(runCount(f), 5);
  assert.equal(
    receipts(f).filter(r => r.firstCheck?.landedOn === 'admission-run' && r.firstCheck.mainMoved).length,
    1,
  );
});

test('the global-risk list is path-only and any listed file rechecks', () => {
  for (const path of [
    'package.json',
    'web/package-lock.json',
    'crates/x/Cargo.toml',
    'go.sum',
    'tsconfig.json',
    'web/tsconfig.app.json',
    'vite.config.ts',
    '.oxlintrc.json',
    '.github/workflows/check.yml',
    '.gitlab-ci.yml',
    'scripts/forge-check.mjs',
    'scripts/check-contract.mjs',
    'tests/check-runtime.mjs',
    'convex/schema.ts',
    'prisma/schema.prisma',
    'Makefile',
    '.env.example',
  ])
    assert.notEqual(firstCheckRisk(path), null, path);
  for (const path of [
    'README.md',
    'docs/workflows.md',
    'src/a.ts',
    'convex/projectHostedCulprit.ts',
    'tests/x.test.mjs',
  ])
    assert.equal(firstCheckRisk(path), null, path);
  // Files the project's check definition runs are global on any runner.
  assert.equal(firstCheckRisk('tools/run.mjs', ['tools/run.mjs']), 'check script or check contract');
});

test('a revert receipt names the re-land command and undo within 1024 bytes', () => {
  const intentId = '00000000-0000-4000-8000-000000000001';
  const short = revertMessage('tests/a.test.mjs failed.', intentId);
  assert.equal(
    short,
    `tests/a.test.mjs failed. Re-land after fixing: nforge agent ROOT start '{"intentId":"${intentId}"}' opens a Lane at the reverted head, then land --save. Undo: revert this receipt.`,
  );
  for (const summary of ['x'.repeat(5000), 'é'.repeat(5000), '😀'.repeat(5000)]) {
    const message = revertMessage(summary, intentId);
    assert(Buffer.byteLength(message) <= 1024, String(Buffer.byteLength(message)));
    assert.match(message, /\.\.\. Re-land after fixing: .* Undo: revert this receipt\.$/);
  }
  assert.equal(revertMessage('s', null), 's Undo: revert this receipt.');
});
