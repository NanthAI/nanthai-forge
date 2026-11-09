// SPDX-License-Identifier: Apache-2.0
// Land on the first (admission) check (Issue 7fe54c7c, owner decision 2026-11-06).
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import {
  checkEntryPaths,
  checkRunEntryPaths,
  FIRST_CHECK_RISK_RULE,
  firstCheckRisk,
  globalRiskBetween,
  sharedSequenceFolders,
} from '../dist/first-check-risk.js';
import { crossHeadProofSchema, validCrossHeadProof } from '../dist/hosted-cross-head-proof.js';
import {
  auditStale,
  earnedAfterGreen,
  earnedAfterUnclear,
  fastEffective,
  landingEarned,
  landingModeView,
} from '../dist/landing-mode.js';
import { acceptancePolicyDigest } from '../dist/policy-digest.js';
import { landingAdvice } from '../dist/hosted-agent-actions.js';
import { STANDARD_CHECK_INPUTS } from '../dist/standard-check.js';
import { checkedPackagePlacement } from '../dist/package-placement-pin.js';
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
/** These waves measure rechecks, not governance: an owner agent changing a check entry or `.github/**`
 * holds for the owner person (Issue 470ef29b, tests/public-governance.test.mjs), so they opt out. */
function noOwnerApproval(f) {
  const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, ownerApprovalPaths: [] } },
  });
}
async function wave(t, options = {}) {
  const f = await batchesFixture(t, { batchMaxSize: null, admissionCheck: 'default', ...options, count: 0 });
  f.rawChecks.setPlanSelection(options.selection ?? full);
  if (options.crossHeadReuse === false) {
    const project = f.tables.hostedProjects.get(f.projectId);
    const policy = project.autonomyPolicy;
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, hostedCrossHeadReuse: false } },
    });
  }
  if (options.noOwnerApproval) noOwnerApproval(f);
  if (options.landing) options.landing(f);
  for (let i = 0; i < (options.count ?? 2); i++) await f.add(i);
  await drive(f, { until: options.until });
  return f;
}
const runCount = f => f.runs().length;
/** recheckReason of every attempt that replaced a raced attempt (main moved), and of no other. */
const raceReasons = f => {
  const attempts = [...f.tables.projectHostedLandingAttempts.values()].map(row => JSON.parse(row.value));
  const byId = new Map(attempts.map(attempt => [attempt.id, attempt]));
  return attempts
    .filter(
      attempt => attempt.recheckReason || attempt.main.head !== byId.get(attempt.parentAttemptId)?.main.head,
    )
    .filter(attempt => attempt.parentAttemptId)
    .map(attempt => attempt.recheckReason ?? null);
};
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
  assert.deepEqual(second.firstCheck, {
    landedOn: 'admission-run',
    mainMoved: true,
    rule: 'clean-disjoint-v2',
  });
  assert.equal(second.crossHeadProof.algorithm, 'clean-disjoint-v2');
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
  // The project's own policy keeps the recheck: a genuine fallback, not a Forge limitation (7c2e69e1).
  assert.deepEqual(receipts(slow)[1].firstCheck, { landedOn: 'recheck', reason: 'reuse-policy' });
  assert.deepEqual(raceReasons(slow), ['reuse-policy']);
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

// The reason class says which kind of risk it was (81d12a32): `order-sensitive` is never relaxed,
// `global-risk` is what an earned fast landing mode carries.
for (const [name, memberPaths, reason] of [
  ['the change (type rules)', ['src/a.ts', 'web/tsconfig.json'], 'order-sensitive'],
  ['main (CI configuration)', ['.github/workflows/check.yml', 'src/b.ts'], 'order-sensitive'],
  ['the change (a package manifest)', ['src/a.ts', 'package.json'], 'global-risk'],
])
  test(`a global-risk file in ${name} rechecks as ${reason}`, async t => {
    const f = await wave(t, { memberPaths, fileCount: 2, noOwnerApproval: true });
    assert.deepEqual(
      states(f).map(s => s.phase),
      ['landed', 'landed'],
    );
    assert.deepEqual(f.reuseDecisions, [reason]);
    assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason });
    assert.equal(runCount(f), 3);
  });

// Any ecosystem (Issue 6af95601): nested build inputs and ordered migration folders; test harness
// files of every ecosystem (Issue c2f6a26a, rule v4: before it these landed on their first check).
const ORDERED = 'order-sensitive';
for (const [name, memberPaths, reason = 'global-risk'] of [
  ['a nested conftest.py', ['pkg/conftest.py', 'pkg/test_b.py']],
  ['a nested vitest.setup.ts', ['src/cart.ts', 'packages/x/vitest.setup.ts']],
  ['an RSpec spec_helper.rb', ['app/models/cart.rb', 'spec/spec_helper.rb']],
  ['a Jest manual mock', ['src/cart.ts', 'src/__mocks__/axios.js']],
  ['an Elixir mix.exs', ['apps/core/lib/cart.ex', 'apps/core/mix.exs']],
  [
    'a migration sequence folder both sides add to',
    ['app/migrations/0005_a.py', 'app/migrations/0005_b.py'],
    ORDERED,
  ],
  [
    'an Alembic versions folder both sides add to',
    ['svc/alembic/versions/a1.py', 'svc/alembic/versions/b2.py'],
    ORDERED,
  ],
])
  test(`${name} rechecks (${reason})`, async t => {
    const f = await wave(t, { memberPaths, fileCount: 2 });
    assert.deepEqual(f.reuseDecisions, [reason]);
    assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason });
    assert.equal(runCount(f), 3);
  });

// Fast landing mode (Issue 81d12a32): the policy asks for it, the project's audit history has
// earned it, and the main audit is fresh. Only then are the two relaxed classes carried.
const EARNED = {
  audited: 200,
  unclear: 0,
  drill: { at: '2026-01-01T00:00:00.000Z', sequence: 1, reverted: true },
};
const fastMode =
  (earned = EARNED, audit = {}) =>
  f => {
    const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, landingMode: 'fast' } },
    });
    f.insert('projectHostedMainAudits', { projectId: f.projectId, ...(earned ? { earned } : {}), ...audit });
  };
const riskyOvertake = { memberPaths: ['src/cart.ts', 'packages/x/vitest.setup.ts'], fileCount: 2 };

test('fast mode, earned and fresh: a global-risk overtake that is not order-sensitive lands on its own check', async t => {
  const f = await wave(t, { ...riskyOvertake, landing: fastMode() });
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.deepEqual(f.reuseDecisions, ['proof']);
  const second = receipts(f)[1];
  assert.deepEqual(second.firstCheck, {
    landedOn: 'admission-run',
    mainMoved: true,
    rule: 'fast-first-check-v1',
  });
  // The receipt names what was relaxed and the risk paths; nothing order-sensitive is among them.
  assert.deepEqual(second.crossHeadProof.relaxed, ['global-risk']);
  assert.deepEqual(second.crossHeadProof.riskPaths, ['packages/x/vitest.setup.ts']);
  assert.equal(validCrossHeadProof(second.crossHeadProof), true);
  // Two own checks and no second check; main is verified after: the prompt audit is armed at once.
  assert.equal(runCount(f), 2);
  const row = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(row.firstCheck, second.snapshot.revision);
  const wake = f.pending().find(task => task.name === 'projectHostedMainAudit:start');
  assert(wake && wake.scheduledTime <= Date.now());
});

test('fast mode makes no more Convex calls or DB IO than the second check it replaces', async t => {
  const fast = await wave(t, { ...riskyOvertake, landing: fastMode() });
  const strict = await wave(t, riskyOvertake);
  assert.equal(runCount(strict), 3);
  const [a, b] = [budget(fast), budget(strict)];
  t.diagnostic(`fast ${JSON.stringify(a)} strict ${JSON.stringify(b)}`);
  for (const key of Object.keys(a)) assert(a[key] <= b[key], `${key}: ${a[key]} <= ${b[key]}`);
});

for (const [name, earned] of [
  ['no audit history', null],
  ['199 of 200 audited landings', { ...EARNED, audited: 199 }],
  ['no recovered red audit on record (no drill)', { audited: 500, unclear: 0 }],
  ['5% of audits stalled or flaky', { ...EARNED, audited: 380, unclear: 20 }],
])
  test(`fast policy that is not earned keeps the second check: ${name}`, async t => {
    const f = await wave(t, { ...riskyOvertake, landing: fastMode(earned) });
    assert.deepEqual(f.reuseDecisions, ['global-risk']);
    assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason: 'global-risk' });
    assert.equal(receipts(f)[1].crossHeadProof, undefined);
    assert.equal(runCount(f), 3);
  });

for (const [name, memberPaths] of [
  ['a database schema file', ['src/a.ts', 'convex/schema.ts']],
  ['lint rules', ['src/a.ts', '.oxlintrc.json']],
  ['a migration folder both sides add to', ['app/migrations/0005_a.py', 'app/migrations/0005_b.py']],
])
  test(`fast mode never relaxes order-sensitive risk: ${name}`, async t => {
    const f = await wave(t, { memberPaths, fileCount: 2, noOwnerApproval: true, landing: fastMode() });
    assert.deepEqual(f.reuseDecisions, [ORDERED]);
    assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason: ORDERED });
    assert.equal(runCount(f), 3);
  });

// Three changes: A lands exactly, B on the strict proof (one unaudited landing, baseline = the audit
// row), then C, whose only obstacle is relaxable risk.
const threeWave = {
  memberPaths: ['src/a.ts', 'src/b.ts', 'packages/x/vitest.setup.ts'],
  fileCount: 2,
  count: 3,
};
const auditRowOf = f => [...f.tables.projectHostedMainAudits.values()][0];
const attemptsOf = f => [...f.tables.projectHostedLandingAttempts.values()].map(row => JSON.parse(row.value));

test('fast mode carries a relaxed class over an audited baseline with one unaudited landing', async t => {
  const f = await wave(t, { ...threeWave, landing: fastMode() });
  const third = receipts(f)[2];
  assert.equal(third.firstCheck.rule, 'fast-first-check-v1');
  assert.equal(third.crossHeadProof.audit.source, 'audit');
  assert.equal(runCount(f), 3);
});

for (const [name, stale] of [
  [
    'more than 10 unaudited landings',
    row => ({ unaudited: { count: 11, firstAt: new Date().toISOString() } }),
  ],
  [
    'an oldest unaudited landing over an hour old',
    row => ({ unaudited: { count: 1, firstAt: new Date(Date.now() - 61 * 60_000).toISOString() } }),
  ],
  [
    'a main audit that ended without a verdict',
    row => ({
      audit: {
        runId: row.lastGreen.runId,
        head: row.lastGreen.head,
        sequence: row.lastGreen.sequence + 1,
        status: 'runner-unavailable',
      },
    }),
  ],
])
  test(`audit freshness: fast mode falls back to the second check on ${name}`, async t => {
    const f = await wave(t, { ...threeWave, landing: fastMode(), until: f => receipts(f).length === 2 });
    f.patch('projectHostedMainAudits', auditRowOf(f)._id, stale(auditRowOf(f)));
    await drive(f);
    const third = receipts(f)[2];
    assert.deepEqual(third.firstCheck, { landedOn: 'recheck', reason: 'global-risk' });
    assert.equal(third.crossHeadProof, undefined);
    assert.equal(runCount(f), 4);
  });

test('a fast proof decided on a fresh audit is refused at publication once the audit has stalled', async t => {
  // The proof that rests on the audit row (after B landed), not the earlier one on A's exact receipt.
  const decided = f =>
    attemptsOf(f).some(
      a => a.crossHeadProof?.algorithm === 'fast-first-check-v1' && a.crossHeadProof.audit.source === 'audit',
    );
  const f = await wave(t, { ...threeWave, landing: fastMode(), until: decided });
  assert.equal(receipts(f).length, 2, 'the fast proof is installed, not yet published');
  const row = auditRowOf(f);
  f.patch('projectHostedMainAudits', row._id, {
    audit: {
      runId: row.lastGreen.runId,
      head: row.lastGreen.head,
      sequence: row.lastGreen.sequence + 1,
      status: 'cancelled',
    },
  });
  await drive(f);
  const third = receipts(f)[2];
  assert.equal(third.crossHeadProof, undefined, 'never published on the stale audit');
  assert.deepEqual(third.firstCheck, { landedOn: 'recheck', reason: 'global-risk' });
  assert.equal(runCount(f), 4);
});

test('fast mode never relaxes a path both changes touch', async t => {
  const f = await wave(t, { memberPaths: ['src/a.ts', 'src/b.ts'], fileCount: 3, landing: fastMode() });
  assert.deepEqual(f.reuseDecisions, ['path-overlap']);
  assert.equal(runCount(f), 3);
});

// Issue 5cfcca4b (5 of 17 dogfood rechecks were global-risk): the checked run pins its manifest package
// graph; a manifest or lockfile inside a package is risk only for that package and its dependents.
const workspace = {
  'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { test: 'x' } }),
  'packages/b/package.json': JSON.stringify({ name: 'b', dependencies: { a: '*' }, scripts: { test: 'x' } }),
  'packages/c/package.json': JSON.stringify({ name: 'c', scripts: { test: 'x' } }),
};
const placedSelection = JSON.stringify({
  scope: 'full',
  tests: [],
  ...checkedPackagePlacement(Object.keys(workspace), path => workspace[path]),
});
test('replay: an in-package manifest change lands on its first check beside an independent package', async t => {
  const f = await wave(t, {
    memberPaths: ['packages/a/src/x.ts', 'packages/c/package.json'],
    fileCount: 2,
    selection: placedSelection,
  });
  assert.deepEqual(f.reuseDecisions, ['proof']);
  const proof = receipts(f)[1].crossHeadProof;
  assert.equal(proof.riskRule, FIRST_CHECK_RISK_RULE);
  assert.deepEqual(proof.placedRisk, [{ path: 'packages/c/package.json', reach: ['js:packages/c'] }]);
  assert.equal(runCount(f), 2, 'no recheck (before: global-risk and a third run)');
  // A dependent package on the other side, or no pinned graph, keeps the recheck.
  for (const [memberPaths, selection] of [
    [['packages/b/src/y.ts', 'packages/a/package.json'], placedSelection],
    [['packages/a/src/x.ts', 'packages/c/package.json'], full],
  ]) {
    const g = await wave(t, { memberPaths, fileCount: 2, selection });
    assert.deepEqual(g.reuseDecisions, ['global-risk'], `${memberPaths}`);
    assert.equal(runCount(g), 3);
  }
});

test('migrations in different folders still land on the first check', async t => {
  const f = await wave(t, {
    memberPaths: ['a/migrations/0005_a.py', 'b/migrations/0005_b.py'],
    fileCount: 2,
  });
  assert.deepEqual(f.reuseDecisions, ['proof']);
  assert.equal(receipts(f)[1].crossHeadProof.riskRule, FIRST_CHECK_RISK_RULE);
  assert.equal(runCount(f), 2);
});

// Any CI (Issue 05df5aed): the rule reads paths, manifests and the run's selection
// only, so a project whose check is its own command lands a clean overtake on its
// admission run too. Before, every non-Forge command was refused as check-evidence
// and the passed admission run was thrown away on every main move.
//
// The live bench repository (Issue 05df5aed, 2026-11-08): a linked skills folder and two
// vendored submodules that no change touches. Every proof there was refused as
// unsupported-mode because any link anywhere in the tree refused it, so every own-command
// case here runs on that tree shape (the earlier fixture passed while live failed).
const linkedRepo = {
  baselineFiles: [
    ['.agents/skills/review.md', 'review'],
    ['.claude/skills', '../.agents/skills', 'symlink'],
    ['.repos/vendor/submodules/one', 'e02e9d405b8848909f4f746b61b12a663f631c7c', 'gitlink'],
    ['.repos/vendor/submodules/two', '493909133db04153348eabc503f4e30cf0033d96', 'gitlink'],
  ],
};
const ownCheck = {
  checkCommand: { executable: 'bash', args: ['ci/check.sh'] },
  // What a runner pins for a configured command: the whole command, no test list.
  selection: JSON.stringify({ scope: 'full', reason: 'Exact configured command', tests: [] }),
  ...linkedRepo,
};
const mainFiles = (f, receipt) => JSON.parse(f.c.objects.get(receipt.candidate.head)).files.map(x => x.path);

test('a project with its own check command lands a clean path-disjoint overtake on its admission run', async t => {
  const f = await wave(t, { ...disjoint, ...ownCheck });
  assert(
    f.runs().every(run => run.check.executable === 'bash'),
    'the configured command ran',
  );
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.deepEqual(f.reuseDecisions, ['proof']);
  assert.deepEqual(recheckReasons(f), [null, null]);
  const [first, second] = receipts(f);
  assert.deepEqual(second.firstCheck, {
    landedOn: 'admission-run',
    mainMoved: true,
    rule: 'clean-disjoint-v2',
  });
  assert.deepEqual(second.crossHeadProof.checkEntries, ['ci/check.sh']);
  assert.equal(runCount(f), 2, 'no second check after the main move');
  // Order and no code loss: submission order, and main keeps both changes.
  assert.deepEqual(
    [first, second].map(r => r.submissionId),
    f.entries.map(e => e.state.id),
  );
  for (const path of ['src/a.ts', 'src/b.ts']) assert(mainFiles(f, second).includes(path), path);
  assert.equal(second.crossHeadProof.main.head, first.candidate.head, 'proved against the main it lands on');
  const kept = JSON.parse(f.c.objects.get(second.candidate.head)).files;
  for (const [path, , mode] of linkedRepo.baselineFiles)
    assert.equal(kept.find(x => x.path === path)?.mode, mode ?? 'file', path);
});

test('own check command: a change that replaces a symlink rechecks (unsupported-mode)', async t => {
  const f = await wave(t, {
    ...ownCheck,
    memberPaths: ['src/a.ts', '.claude/skills'],
    fileCount: 2,
  });
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.deepEqual(f.reuseDecisions, ['unsupported-mode']);
  assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason: 'unsupported-mode' });
  // The main-race attempt names the same limitation, on the attempt the install already writes (7c2e69e1).
  assert.deepEqual(raceReasons(f), ['unsupported-mode']);
  assert.equal(runCount(f), 3);
});

test('own check command: the file the command names is global-risk and rechecks', async t => {
  const f = await wave(t, {
    ...ownCheck,
    memberPaths: ['ci/check.sh', 'src/b.ts'],
    fileCount: 2,
    noOwnerApproval: true,
  });
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.deepEqual(f.reuseDecisions, [ORDERED]);
  assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason: ORDERED });
  assert.equal(runCount(f), 3);
});

// Governance protects setup-action entries (8eccbea9); they can change every result too.
test('own check command: the file its Actions setup command names is global-risk and rechecks', async t => {
  const withSetup = {
    ...ownCheck,
    checkCommand: {
      ...ownCheck.checkCommand,
      actions: { setup: { executable: 'bash', args: ['ci/setup.sh'] } },
    },
  };
  const f = await wave(t, {
    ...withSetup,
    memberPaths: ['ci/setup.sh', 'src/b.ts'],
    fileCount: 2,
    noOwnerApproval: true,
  });
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.deepEqual(f.reuseDecisions, [ORDERED]);
  assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason: ORDERED });
  assert.equal(runCount(f), 3);
  // A disjoint overtake still lands on its admission run, and the proof names both entries.
  const clean = await wave(t, { ...disjoint, ...withSetup });
  assert.deepEqual(clean.reuseDecisions, ['proof']);
  assert.deepEqual(receipts(clean)[1].crossHeadProof.checkEntries, ['ci/check.sh', 'ci/setup.sh']);
});

test('own check command: a path both changes touch still rechecks', async t => {
  const f = await wave(t, { ...ownCheck, memberPaths: ['src/a.ts', 'src/b.ts'], fileCount: 3 });
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.deepEqual(f.reuseDecisions, ['path-overlap']);
  assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason: 'path-overlap' });
  assert.equal(receipts(f)[1].crossHeadProof, undefined);
  assert.equal(runCount(f), 3);
  for (const path of ['src/a.ts', 'src/b.ts', 'fixture/0'])
    assert(mainFiles(f, receipts(f)[1]).includes(path), path);
});

test('own check command: first-check landing costs no more Convex calls or DB IO than the recheck', async t => {
  const fast = await wave(t, { ...disjoint, ...ownCheck });
  const slow = await wave(t, { ...disjoint, ...ownCheck, crossHeadReuse: false });
  assert.equal(runCount(slow), 3);
  const [a, b] = [budget(fast), budget(slow)];
  t.diagnostic(`own-command first-check ${JSON.stringify(a)} recheck ${JSON.stringify(b)}`);
  for (const key of Object.keys(a)) assert(a[key] <= b[key], `${key}: ${a[key]} <= ${b[key]}`);
});

test('check entries are the repository files a command names, in any form', () => {
  // Forge's own check also declares its extra inputs (src/standard-check.ts).
  assert.deepEqual(checkEntryPaths({ executable: 'node', args: ['scripts/forge-check.mjs'] }), [
    'scripts/forge-check.mjs',
    ...STANDARD_CHECK_INPUTS,
  ]);
  assert.deepEqual(checkEntryPaths({ executable: 'bash', args: ['.bench/ci.sh'] }), ['.bench/ci.sh']);
  assert.deepEqual(checkEntryPaths({ executable: './ci/run.sh', args: ['--config=ci/run.json'] }), [
    'ci/run.sh',
    'ci/run.json',
  ]);
  assert.deepEqual(
    checkEntryPaths({ executable: 'bash', args: ['-c', './tools/a.sh && node tools/b.mjs | tee out'] }),
    ['tools/a.sh', 'tools/b.mjs'],
  );
  // A setup action's entries follow the command's, in order and without repeats.
  assert.deepEqual(
    checkRunEntryPaths({
      executable: 'bash',
      args: ['ci/check.sh'],
      actions: { setup: { executable: 'bash', args: ['ci/setup.sh', 'ci/check.sh'] } },
    }),
    ['ci/check.sh', 'ci/setup.sh'],
  );
  assert.deepEqual(checkRunEntryPaths({ executable: 'bash', args: ['.bench/ci.sh'] }), ['.bench/ci.sh']);
  for (const check of [
    { executable: '/usr/local/bin/node', args: ['--test'] },
    { executable: 'npm', args: ['test'] },
    { executable: 'bash', args: ['../outside/x.sh', 'a/./b.sh'] },
  ])
    assert.deepEqual(checkEntryPaths(check), [], JSON.stringify(check));
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

// Owner decision 2026-11-06 10:45Z: a text-clean Markdown merge lands on its first
// check unless a test or script reads that file (the runner's pinned list).
const markdown = (path, testedDocs, contents = ['A\nb\nc\n', 'a\nb\nC\n']) => ({
  baselineFiles: [[path, 'a\nb\nc\n']],
  memberPaths: [path, path],
  memberContents: contents,
  fileCount: 2,
  selection: JSON.stringify({
    scope: 'full',
    tests: [],
    ...(testedDocs ? { testedDocs: { rule: 'name-mention-v1', paths: testedDocs } } : {}),
  }),
});
const fileText = (f, head, path) =>
  f.c.objects.get(JSON.parse(f.c.objects.get(head)).files.find(file => file.path === path).blob).toString();

test('a text-clean merge of Markdown no test reads lands on its admission run (clean-disjoint-v2)', async t => {
  const f = await wave(t, markdown('docs/notes.md', ['AGENTS.md']));
  assert.deepEqual(
    states(f).map(s => s.phase),
    ['landed', 'landed'],
  );
  assert.deepEqual(f.reuseDecisions, ['proof']);
  const second = receipts(f)[1];
  assert.deepEqual(second.firstCheck, {
    landedOn: 'admission-run',
    mainMoved: true,
    rule: 'clean-disjoint-v2',
  });
  assert.deepEqual(second.crossHeadProof.docsOverlap, ['docs/notes.md']);
  // Landed bytes are the composed Candidate on current main: both edits, one run each.
  assert.equal(second.candidate.head, second.crossHeadProof.head);
  assert.equal(fileText(f, second.candidate.head, 'docs/notes.md'), 'A\nb\nC\n');
  assert.equal(runCount(f), 2);
  // The first-check main audit is armed at once, as for a path-disjoint landing.
  assert.equal([...f.tables.projectHostedMainAudits.values()][0].firstCheck, second.snapshot.revision);
});

test('Markdown first-check landing costs no more Convex calls or DB IO than its recheck', async t => {
  const fast = await wave(t, markdown('docs/notes.md', []));
  const slow = await wave(t, markdown('docs/notes.md', ['docs/notes.md']));
  assert.deepEqual(slow.reuseDecisions, ['tested-doc']);
  const [a, b] = [budget(fast), budget(slow)];
  t.diagnostic(`docs first-check ${JSON.stringify(a)} recheck ${JSON.stringify(b)}`);
  for (const key of Object.keys(a)) assert(a[key] <= b[key], `${key}: ${a[key]} <= ${b[key]}`);
});

for (const [name, options, reason] of [
  ['a tested Markdown file (AGENTS.md)', markdown('AGENTS.md', ['AGENTS.md']), 'tested-doc'],
  ['a run that pinned no tested-docs list', markdown('docs/notes.md', undefined), 'tested-doc'],
  // fixture/0 is in both changes too: a code overlap beside the Markdown merge.
  ['Markdown plus a code overlap', { ...markdown('docs/notes.md', []), fileCount: 3 }, 'path-overlap'],
])
  test(`a clean Markdown merge rechecks for ${name}: ${reason}`, async t => {
    const f = await wave(t, options);
    assert.deepEqual(
      states(f).map(s => s.phase),
      ['landed', 'landed'],
    );
    assert.deepEqual(f.reuseDecisions, [reason]);
    assert.deepEqual(receipts(f)[1].firstCheck, { landedOn: 'recheck', reason });
    assert.equal(receipts(f)[1].crossHeadProof, undefined);
    assert.equal(runCount(f), 3);
  });

test('fast mode, earned and fresh: a clean merge of a tested Markdown file lands on its own check', async t => {
  const f = await wave(t, { ...markdown('AGENTS.md', ['AGENTS.md']), landing: fastMode() });
  assert.deepEqual(f.reuseDecisions, ['proof']);
  const second = receipts(f)[1];
  assert.equal(second.firstCheck.rule, 'fast-first-check-v1');
  assert.deepEqual(second.crossHeadProof.relaxed, ['tested-doc']);
  assert.deepEqual(second.crossHeadProof.docsOverlap, ['AGENTS.md']);
  assert.equal(fileText(f, second.candidate.head, 'AGENTS.md'), 'A\nb\nC\n');
  assert.equal(runCount(f), 2);
});

test('a Markdown text conflict never lands on the first check', async t => {
  const f = await wave(t, markdown('docs/notes.md', [], ['A\nb\nc\n', 'X\nb\nc\n']));
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
  assert.deepEqual(culprit.firstCheck, {
    landedOn: 'admission-run',
    mainMoved: true,
    rule: 'clean-disjoint-v2',
  });
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
    'scripts/check-contract.mjs',
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
    // Forge's own check scripts are risky only for Forge's check (below).
    'scripts/forge-check.mjs',
    'scripts/verify.mjs',
    'tests/check-runtime.mjs',
  ])
    assert.equal(firstCheckRisk(path), null, path);
  const forgeEntries = checkEntryPaths({ executable: 'node', args: ['scripts/forge-check.mjs'] });
  for (const path of ['scripts/forge-check.mjs', 'scripts/verify.mjs', 'tests/check-runtime.mjs'])
    assert.equal(firstCheckRisk(path, forgeEntries), 'check script or check contract', path);
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

test('v2 nested build inputs of every ecosystem are global-risk at any depth (v1 was not)', () => {
  for (const path of [
    'crates/x/build.rs',
    'crates/x/.cargo/config.toml',
    'crates/x/.cargo/config',
    'crates/x/rust-toolchain.toml',
    'pkg/conftest.py',
    'pkg/pytest.ini',
    'pkg/tox.ini',
    'pkg/noxfile.py',
    'pkg/mypy.ini',
    'pkg/.python-version',
    'src/App/App.csproj',
    'src/App/Lib.fsproj',
    'src/App.sln',
    'src/App.slnx',
    'src/Directory.Build.props',
    'src/Directory.Build.targets',
    'src/Directory.Packages.props',
    'src/App/packages.lock.json',
    'src/global.json',
    'src/NuGet.Config',
    'app/gradle/libs.versions.toml',
    'app/gradle/wrapper/gradle-wrapper.properties',
    'app/buildSrc/src/main/kotlin/Conv.kt',
    'svc/BUILD',
    'svc/BUILD.bazel',
    'svc/defs.bzl',
    'svc/WORKSPACE',
    'svc/MODULE.bazel',
    'native/CMakeLists.txt',
    'native/cmake/Find.cmake',
    'tools/go.work.sum',
    'db/schema.rb',
    'db/structure.sql',
    'db/schema.sql',
  ]) {
    assert.equal(firstCheckRisk(path, [], 'first-check-risk-v1'), null, `v1 ${path}`);
    assert.notEqual(firstCheckRisk(path), null, path);
    assert.equal(firstCheckRisk(path, [], 'first-check-risk-v2') !== null, true, path);
  }
  // Ordinary source stays reusable.
  for (const path of [
    'pkg/a.py',
    'crates/x/src/lib.rs',
    'src/App/Program.cs',
    'svc/main.go',
    'app/src/Main.java',
  ])
    assert.equal(firstCheckRisk(path), null, path);
});

test('the sequence-folder rule needs both sides in the same folder and is v2 only', () => {
  const a = ['app/migrations/0005_a.py'],
    b = ['app/migrations/0005_b.py'];
  assert.deepEqual(sharedSequenceFolders(a, b), ['app/migrations']);
  assert.deepEqual(sharedSequenceFolders(a, b, 'first-check-risk-v1'), []);
  assert.equal(globalRiskBetween(a, b), true);
  assert.equal(globalRiskBetween(a, b, [], 'first-check-risk-v1'), false);
  assert.equal(globalRiskBetween(a, ['other/migrations/0005_b.py']), false);
  assert.equal(globalRiskBetween(a, ['app/models.py']), false);
  assert.equal(globalRiskBetween(['app/models.py'], ['app/models_b.py']), false);
  for (const [x, y] of [
    ['db/migrate/20260101_a.rb', 'db/migrate/20260102_b.rb'],
    ['svc/alembic/versions/a1.py', 'svc/alembic/versions/b2.py'],
    ['prisma/migrations/2026_a/migration.sql', 'prisma/migrations/2026_b/migration.sql'],
    ['migrations/V2__a.sql', 'migrations/V2__b.sql'],
    ['src/main/resources/db/migration/V2__a.sql', 'src/main/resources/db/migration/V2__b.sql'],
  ])
    assert.equal(globalRiskBetween([x], [y]), true, x);
});

test('a proof keeps the risk rule it was decided under: v1 accepts, v2 refuses a shared migration folder', () => {
  const proof = riskRule => ({
    algorithm: 'clean-disjoint-v2',
    candidatePaths: ['app/migrations/0005_a.py'],
    mainPaths: ['app/migrations/0005_b.py'],
    docsOverlap: [],
    checkEntries: [],
    riskRule,
  });
  assert.equal(validCrossHeadProof(proof('first-check-risk-v1')), true);
  assert.equal(validCrossHeadProof(proof('first-check-risk-v2')), false);
  // A v1 receipt written before the bump still parses (the schema pins a rule, not one literal).
  // Fast landing mode added a fourth proof kind (81d12a32).
  assert.equal(crossHeadProofSchema.options.length, 4);
});

test('a fast proof is invalid once it names an order-sensitive path or hides the class it relaxed', () => {
  const proof = (candidatePaths, relaxed = ['global-risk']) => ({
    algorithm: 'fast-first-check-v1',
    candidatePaths,
    mainPaths: ['src/b.ts'],
    docsOverlap: [],
    checkEntries: ['ci/check.sh'],
    riskRule: 'first-check-risk-v6',
    relaxed,
    riskPaths: [],
  });
  assert.equal(validCrossHeadProof(proof(['package.json'])), true);
  for (const path of ['convex/schema.ts', 'ci/check.sh', '.github/workflows/ci.yml', 'tsconfig.json'])
    assert.equal(validCrossHeadProof(proof([path])), false, path);
  // Risk is present but the proof does not say it relaxed it; or it claims a tested-doc with no overlap.
  assert.equal(validCrossHeadProof(proof(['package.json'], ['tested-doc'])), false);
  assert.equal(validCrossHeadProof(proof(['src/a.ts'], ['tested-doc'])), false);
});

test('earned fast mode: 200 audited landings, a recovered red on record, under 5% unclear audits', () => {
  let earned = earnedAfterGreen(undefined, 199);
  assert.deepEqual(landingEarned(earned).missing, ['audited', 'drill']);
  // A red audit that was detected and recovered is the drill, and costs every landing counted so far.
  earned = earnedAfterGreen(earned, 3, { at: '2026-11-09T10:00:00.000Z', sequence: 7, reverted: true });
  assert.deepEqual(earned, {
    audited: 0,
    unclear: 0,
    drill: { at: '2026-11-09T10:00:00.000Z', sequence: 7, reverted: true },
    lost: { at: '2026-11-09T10:00:00.000Z', reason: 'red' },
  });
  earned = earnedAfterGreen(earned, 200);
  assert.equal(landingEarned(earned).earned, true);
  assert.equal(earned.lost, undefined, 'earned again: the loss marker is cleared');
  // Flake policy: stalled or flaky audits are counted, and at 5% they un-earn fast mode.
  earned = earnedAfterUnclear(earned, 10);
  assert.equal(landingEarned(earned).earned, true);
  earned = earnedAfterUnclear(earned, 1);
  assert.deepEqual(landingEarned(earned).missing, ['unclear']);
  // The window halves at 800 so the share follows recent history; an earned project stays earned.
  earned = earnedAfterGreen({ ...EARNED, audited: 770, unclear: 29 }, 1);
  assert.deepEqual([earned.audited, earned.unclear], [385, 14]);
  assert.equal(landingEarned(earned).earned, true);
});

test('audit freshness bounds lag by count and by time, and a stalled audit closes fast mode', () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  const audit = (count, minutesAgo, extra = {}) => ({
    status: 'green',
    unaudited: { count, firstAt: count ? new Date(now - minutesAgo * 60_000).toISOString() : null },
    stalled: false,
    ...extra,
  });
  assert.equal(auditStale(audit(0, 0), now), null);
  assert.equal(auditStale(audit(10, 60), now), null);
  assert.equal(auditStale(audit(11, 5), now), 'unaudited-landings');
  assert.equal(auditStale(audit(1, 61), now), 'audit-old');
  assert.equal(auditStale(audit(1, 5, { stalled: true }), now), 'audit-stalled');
  assert.equal(auditStale(audit(0, 0, { status: 'red' }), now), 'main-red');
  assert.equal(auditStale(audit(0, 0, { status: 'unknown' }), now), 'no-green-audit');
  assert.equal(fastEffective('fast', EARNED, audit(1, 5), now), true);
  assert.equal(fastEffective('strict', EARNED, audit(1, 5), now), false);
  assert.equal(fastEffective(undefined, EARNED, audit(1, 5), now), false);
});

test('landing mode advice: switch fast on once earned, off after a red or flaky audits, never otherwise', () => {
  const fresh = { status: 'green', unaudited: { count: 0, firstAt: null }, stalled: false };
  const view = (mode, earned, audit = fresh) => landingModeView(mode, earned, audit);
  assert.equal(view(undefined, undefined).advice, null);
  assert.deepEqual(view(undefined, undefined).state, 'strict');
  const on = view('strict', EARNED);
  assert.equal(on.state, 'earned');
  assert.deepEqual(on.advice.policy, { acceptance: { landingMode: 'fast' } });
  assert.match(on.nextStep, /set-policy \{"acceptance":\{"landingMode":"fast"\}\}/);
  assert.equal(view('fast', EARNED).state, 'fast');
  assert.equal(view('fast', EARNED).effective, 'fast');
  // A stale audit pauses fast without advice: it resumes by itself.
  const paused = view('fast', EARNED, { ...fresh, stalled: true });
  assert.deepEqual([paused.state, paused.effective, paused.advice], ['suspended', 'strict', null]);
  // Not earned yet: progress only.
  const earning = view('fast', { audited: 12, unclear: 0 });
  assert.deepEqual([earning.state, earning.effective, earning.advice], ['earning', 'strict', null]);
  assert.match(earning.nextStep, /12 of 200 audited landings/);
  // Lost on a red audit, or on flaky and stalled audits: advise the owner and the next agent to switch off.
  const lost = view('fast', {
    audited: 3,
    unclear: 0,
    drill: EARNED.drill,
    lost: { at: '2026-11-09T10:00:00.000Z', reason: 'red' },
  });
  assert.equal(lost.state, 'lost');
  assert.deepEqual(lost.advice.policy, { acceptance: { landingMode: 'strict' } });
  assert.match(lost.nextStep, /went red on 2026-11-09/);
  const flaky = view('fast', { ...EARNED, audited: 300, unclear: 30 });
  assert.equal(flaky.advice.switchTo, 'strict');
  assert.match(flaky.nextStep, /stalled or flaky/);
  // The next agent's next step: the land receipt carries the advice only when there is a switch to make.
  assert.equal(landingAdvice({ landing: on }), on.nextStep);
  assert.equal(landingAdvice({ landing: lost }), lost.nextStep);
  for (const quiet of [paused, earning, view('fast', EARNED), view(undefined, undefined)])
    assert.equal(landingAdvice({ landing: quiet }), null);
  assert.equal(landingAdvice(undefined), null);
  // The wording never promises a green main.
  for (const text of [on, lost, flaky, paused, earning].map(v => v.nextStep))
    assert.doesNotMatch(text, /always green/i);
});

test('the landing mode is read live: switching it never invalidates a pinned landing', () => {
  const policy = { preset: 'custom', acceptance: { mode: 'auto-on-pass', protectedPaths: [] } };
  const fast = { ...policy, acceptance: { ...policy.acceptance, landingMode: 'fast' } };
  assert.equal(acceptancePolicyDigest(fast), acceptancePolicyDigest(policy));
  assert.notEqual(
    acceptancePolicyDigest({ ...policy, acceptance: { ...policy.acceptance, mode: 'review' } }),
    acceptancePolicyDigest(policy),
  );
});
