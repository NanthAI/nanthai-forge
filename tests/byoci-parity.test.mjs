// SPDX-License-Identifier: Apache-2.0
// BYOCI parity (Issue 63d241db, audit 1bb0d8e6): every landing fast path reaches the same outcome with
// Forge's standard check and with a project's own command, on the same pnpm-style tree with a linked
// folder and a submodule (the shape that hid 05df5aed). Differences are listed in
// docs/forge-only-rules.md#byoci-parity; anything else is a Forge-only regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { checkRunEntryPaths } from '../dist/first-check-risk.js';
import { declaredTestedDocs, docsOnlyChange } from '../dist/docs-paths.js';
import { testsNotAffected } from '../dist/hosted-check.js';
import { ownerApprovalMatcher } from '../dist/public-governance.js';
import { diagnoseBatchFailure } from '../dist/hosted-batch-diagnosis.js';
import { isStandardForgeCheck } from '../dist/standard-check.js';

const env = {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-byoci-parity',
};
const prior = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, env));
test.after(() => {
  for (const [k, v] of Object.entries(prior))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

/** pnpm workspace, a linked skills folder and two vendored submodules no change touches. */
const tree = [
  ['pnpm-workspace.yaml', 'packages:\n  - packages/*\n'],
  ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n"],
  ['packages/a/src/a.ts', 'export const a = 1;\n'],
  ['packages/b/src/b.ts', 'export const b = 1;\n'],
  ['packages/shared/src/shared.ts', 'export const a = 1;\n// gap\nexport const b = 1;\n'],
  ['docs/notes.md', 'a\nb\nc\n'],
  ['ci/check.sh', 'pnpm -r test\n'],
  ['ci/setup.sh', 'pnpm install --frozen-lockfile\n'],
  ['scripts/forge-check.mjs', '// synthetic\n'],
  ['.agents/skills/review.md', 'review'],
  ['.claude/skills', '../.agents/skills', 'symlink'],
  ['.repos/vendor/one', 'e02e9d405b8848909f4f746b61b12a663f631c7c', 'gitlink'],
  ['.repos/vendor/two', '493909133db04153348eabc503f4e30cf0033d96', 'gitlink'],
];
const standard = { executable: 'node', args: ['scripts/forge-check.mjs'] };
const project = {
  executable: 'bash',
  args: ['ci/check.sh'],
  actions: { setup: { executable: 'bash', args: ['ci/setup.sh'] } },
};
const arms = { standard, project };
/** The selection each arm's runner pins for a full run (a project command runs whole). */
const fullSelection = check =>
  JSON.stringify(
    isStandardForgeCheck(check)
      ? { scope: 'full', tests: [] }
      : { scope: 'full', reason: 'Exact configured command', tests: [] },
  );
/** The file each arm names as its own check entry. */
const entry = check => (isStandardForgeCheck(check) ? 'scripts/forge-check.mjs' : 'ci/check.sh');

const receipts = f =>
  [...f.tables.projectHostedAcceptances.values()]
    .map(r => JSON.parse(r.value))
    .sort((a, b) => a.snapshot.revision - b.snapshot.revision);
async function wave(t, check, options) {
  const f = await batchesFixture(t, {
    batchMaxSize: null,
    admissionCheck: 'default',
    checkCommand: check,
    baselineFiles: tree,
    ...options,
    count: 0,
  });
  f.rawChecks.setPlanSelection(options.selection ?? fullSelection(check));
  // Rechecks, not governance: an owner agent changing a check entry holds for the owner person
  // (Issue 470ef29b, tests/public-governance.test.mjs), so these waves opt out of that hold.
  if (options.noOwnerApproval) {
    const policy = f.tables.hostedProjects.get(f.projectId).autonomyPolicy;
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, ownerApprovalPaths: [] } },
    });
  }
  for (let i = 0; i < 2; i++) await f.add(i);
  for (let tick = 0; ; tick++) {
    assert(tick < 900, JSON.stringify(states(f).map(s => s.phase)));
    for (const run of f.runs().filter(run => run.status === 'queued' && run.gate?.mode !== 'audit'))
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    const task = f.pending().find(t => !/MainAudit:start/.test(t.name)) ?? null;
    if (!task) break;
    await f.execute(task);
  }
  return {
    phases: states(f).map(s => [s.phase, s.error?.code ?? null]),
    decisions: f.reuseDecisions,
    firstCheck: receipts(f).map(r => r.firstCheck ?? null),
    runs: f.runs().length,
    ranCommand: f.runs().every(run => run.check.executable === check.executable),
  };
}

const scenarios = [
  [
    'a clean path-disjoint overtake lands on its admission run',
    ['proof'],
    () => ({
      memberPaths: ['packages/a/src/a.ts', 'packages/b/src/b.ts'],
      fileCount: 2,
    }),
  ],
  [
    'different code edits on a shared path recheck',
    ['path-overlap'],
    () => ({
      memberPaths: [
        ['packages/a/src/a.ts', 'packages/shared/src/shared.ts'],
        ['packages/b/src/b.ts', 'packages/shared/src/shared.ts'],
      ],
      memberContents: [
        'export const a = 2;\n// gap\nexport const b = 1;\n',
        'export const a = 1;\n// gap\nexport const b = 2;\n',
      ],
      fileCount: 2,
    }),
  ],
  [
    'identical shared entries keep the passed check (Issue 1018d0f8)',
    ['proof'],
    () => ({
      memberPaths: [
        ['packages/a/src/a.ts', 'packages/shared/src/shared.ts'],
        ['packages/b/src/b.ts', 'packages/shared/src/shared.ts'],
      ],
      memberContents: ['same', 'same'],
      fileCount: 2,
    }),
  ],
  [
    'a change to the check entry rechecks',
    ['order-sensitive'],
    check => ({
      memberPaths: [entry(check), 'packages/b/src/b.ts'],
      fileCount: 2,
      noOwnerApproval: true,
    }),
  ],
  [
    'a lockfile change rechecks',
    ['global-risk'],
    () => ({ memberPaths: ['pnpm-lock.yaml', 'packages/b/src/b.ts'], fileCount: 2 }),
  ],
  [
    'a change that replaces the linked folder rechecks',
    ['unsupported-mode'],
    () => ({
      memberPaths: ['packages/a/src/a.ts', '.claude/skills'],
      fileCount: 2,
    }),
  ],
  [
    'a text conflict never lands on the first check',
    [],
    () => ({
      memberPaths: ['packages/a/src/a.ts', 'packages/a/src/a.ts'],
      fileCount: 2,
    }),
  ],
  // A clean Markdown merge lands when the pinned tested-docs list does not name it: the standard
  // selector pins its list, a project command pins the one its declared docsPaths give.
  [
    'a clean merge of untested Markdown lands on its admission run',
    ['proof'],
    check => ({
      memberPaths: ['docs/notes.md', 'docs/notes.md'],
      memberContents: ['A\nb\nc\n', 'a\nb\nC\n'],
      fileCount: 2,
      selection: JSON.stringify({
        scope: 'full',
        tests: [],
        testedDocs: isStandardForgeCheck(check)
          ? { rule: 'name-mention-v1', paths: [] }
          : declaredTestedDocs(
              ['docs/**'],
              tree.map(([path]) => path),
            ),
      }),
    }),
  ],
];

for (const [name, decisions, options] of scenarios)
  test(`parity: ${name}`, async t => {
    const outcomes = {};
    for (const [arm, check] of Object.entries(arms)) {
      outcomes[arm] = await wave(t, check, options(check));
      assert(outcomes[arm].ranCommand, `${arm}: the configured command ran`);
    }
    assert.deepEqual(outcomes.standard.decisions, decisions, 'the fast path this scenario exercises');
    assert.deepEqual(outcomes.project, outcomes.standard);
  });

test('parity: the setup action entry is global-risk like the check entry', async t => {
  const outcome = await wave(t, project, {
    memberPaths: ['ci/setup.sh', 'packages/b/src/b.ts'],
    fileCount: 2,
    noOwnerApproval: true,
  });
  assert.deepEqual(outcome.decisions, ['order-sensitive']);
  assert.deepEqual(outcome.firstCheck[1], { landedOn: 'recheck', reason: 'order-sensitive' });
  // Listed difference: the standard check's extra inputs are its own; the project's are what it names.
  assert.deepEqual(checkRunEntryPaths(project), ['ci/check.sh', 'ci/setup.sh']);
  assert(checkRunEntryPaths(standard).includes('scripts/forge-check.mjs'));
});

test('parity: a docs-only change skips tests for either check once its scope says docs', () => {
  const docs = { scope: 'docs', reason: 'docs only', tests: [] };
  // The standard selector decides docs scope itself; a project command declares docsPaths.
  assert(docsOnlyChange(['docs/**'], ['docs/notes.md']));
  assert.deepEqual(testsNotAffected(docs, true), testsNotAffected(docs, false, ['docs/**']));
  // Without a declaration a project command keeps today's safe full run.
  assert.equal(testsNotAffected(docs, false), undefined);
});

test('parity: governance protects each check entry and setup action by default', () => {
  const policy = { acceptance: {} };
  const protectedFor = check => ownerApprovalMatcher(policy, check);
  assert(protectedFor(standard)('scripts/forge-check.mjs'));
  assert(protectedFor(project)('ci/check.sh'));
  assert(protectedFor(project)('ci/setup.sh'));
  for (const check of [standard, project]) assert(!protectedFor(check)('packages/a/src/a.ts'));
});

test('parity: a combined failure names the member whose module the failing test names, in any folder', () => {
  const members = [
    { submissionId: 's1', intentId: 'i1', paths: ['packages/a/src/billing.ts'], tests: [] },
    { submissionId: 's2', intentId: 'i2', paths: ['packages/b/src/b.ts'], tests: [] },
  ];
  const semantic = { conflicts: [], overBudgetPairs: 0 };
  // The same report records either way: Forge's own lines or a project's JUnit report.
  const run = { id: 'r1', testFiles: { failed: [{ file: 'packages/a/src/billing.test.ts' }] } };
  assert.deepEqual(diagnoseBatchFailure(members, run, semantic).suspects, ['s1']);
});

// Issue 3439ae76 (batch 2d82c075): a shared check that passes late, after main moved, recomposes its
// cohort on the new main and checks it once more, with either check. Incident-sized State manifests
// make that compose span several source steps; the cohort never splits and no member rechecks alone.
test('parity: a late pass after main moved rechecks the cohort once, even when its compose spans steps', async t => {
  const big = Array.from({ length: 4500 }, (_, i) => [
    `packages/area-${i % 40}/src/module-${String(i).padStart(5, '0')}-with-a-long-name.ts`,
    'export {};\n',
  ]);
  const outcomes = {};
  for (const [arm, check] of Object.entries(arms)) {
    const f = await batchesFixture(t, { count: 4, checkCommand: check, baselineFiles: [...tree, ...big] });
    await f.drain();
    f.moveMain();
    await f.passChecks();
    await f.drain();
    for (let i = 0; i < 4 && !states(f).every(s => s.phase === 'landed'); i++) {
      await f.passChecks();
      await f.drain();
    }
    const stops = [...f.tables.projectSourceSteps.values()].flatMap(row =>
      (row.timing?.steps ?? []).map(step => step.stop),
    );
    assert(stops.includes('compute-bytes'), `${arm}: a compose yielded mid-merge like the incident`);
    outcomes[arm] = {
      phases: states(f).map(s => [s.phase, s.error?.code ?? null]),
      runs: f.runs().length,
      alone: states(f).filter(s => s.batchSolo || s.batchOriginId).length,
      ranCommand: f.runs().every(run => run.check.executable === check.executable),
    };
  }
  assert.deepEqual(outcomes.standard, {
    phases: Array.from({ length: 4 }, () => ['landed', null]),
    runs: 2,
    alone: 0,
    ranCommand: true,
  });
  assert.deepEqual(outcomes.project, { ...outcomes.standard });
});
