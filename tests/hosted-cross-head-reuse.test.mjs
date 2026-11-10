// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { analyzeCrossHeadReuse } from '../dist/hosted-cross-head-analysis.js';
import { validCrossHeadProof } from '../dist/hosted-cross-head-proof.js';
import { digest } from '../dist/hash.js';
import { finishFixture, landingApi } from './hosted-finish-fixture.mjs';
import { passWithSelection, seedFullMain, useSyntheticHostedEnv } from './hosted-race-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset as preset } from '../dist/autonomy-policy.js';
// Server preflight gate (Issue 029138ef) has its own tests (hosted-landing-desired.test.mjs).
const policyPreset = name => ({ ...preset(name), agentDefaults: { preflight: 'advise' } });
import { emptyTrust } from '../dist/agent-trust.js';
const reuse = await import(moduleUrl('../convex/projectHostedReuseStore.ts'));
const mainAudit = await import(moduleUrl('../convex/projectHostedMainAudit.ts'));
const reuseAction = await import(moduleUrl('../convex/projectHostedReuse.ts'));
useSyntheticHostedEnv(test);
const baselineFiles = [
  ['package.json', '{"scripts":{}}'],
  ['package-lock.json', '{"lockfileVersion":3,"packages":{}}'],
  ['convex/projectConvexSourceOutput.ts', 'export const cost = 1;'],
  ['src/native-projection.ts', 'export const old = 1;'],
  ['tests/convex-source-r2.test.mjs', "import '../convex/projectConvexSourceOutput.ts';"],
  ['tests/native-projection.test.mjs', "import '../dist/native-projection.js';"],
];
async function readyRace(
  t,
  { mainFiles, extra = [], disabled = false, admission = false, member = null } = {},
) {
  const f = await finishFixture(t, {
    admission,
    baselineFiles: [...baselineFiles, ...extra],
    selectedFiles: [['convex/projectConvexSourceOutput.ts', 'export const cost = 2;']],
    mainFiles: mainFiles ?? [['src/native-projection.ts', 'export const old = 2;']],
  });
  if (disabled) {
    const policy = policyPreset('trusted');
    policy.acceptance.hostedCrossHeadReuse = false;
    f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  }
  if (member) {
    // The acting agent is a team member (contributor), not the project owner.
    f.patch('hostedProjects', f.projectId, { owner: 'founder' });
    f.insert('projectContributors', { projectId: f.projectId, contributor: 'owner' });
    const policy = policyPreset('trusted');
    if (member.autoActors) policy.acceptance.autoActors = member.autoActors;
    if (member.trust) policy.trust = { enabled: true, probationLandings: 0 };
    f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
    if (member.delegated)
      f.insert('projectHostedTrust', {
        projectId: f.projectId,
        actor: 'owner',
        ...emptyTrust('2026-10-01T00:00:00.000Z'),
        delegations: [{ decisionId: randomUUID(), patterns: ['convex/**'], level: 'trusted' }],
      });
  }
  const state = await f.enqueue(f.request({ agent: true }));
  await f.drain();
  const before = (await f.status(state.id)).attempt;
  const selection = f.c.put(
    JSON.stringify({
      scope: 'full',
      tests: ['tests/convex-source-r2.test.mjs', 'tests/native-projection.test.mjs'],
    }),
  );
  await passWithSelection(f, before.check.runId, selection);
  while ((await f.current(state.id)).submission.phase !== 'ready') await f.execute();
  f.moveMain();
  const parent = await seedFullMain(f, selection);
  return { f, state, before, parent };
}
async function pendingProof(f, state) {
  for (let n = 0; n < 80; n++) {
    const pending = JSON.parse(f.row(state.id).value).pending;
    const source =
      pending &&
      [...f.tables.projectHostedComposes.values()].find(
        row => row.operationId === pending.operations.compose,
      );
    if (source && JSON.parse(source.value).status === 'completed')
      return { projectId: f.projectId, submissionId: state.id, pendingId: pending.id, owner: randomUUID() };
    await f.execute();
  }
  assert.fail('completed recomposition');
}

function fixture({
  shared = false,
  unknown = false,
  overlap = false,
  corrupt = false,
  risk = null,
  mainRisk = null,
  scope = 'full',
  // A Markdown file both sides edited (text-clean merge), and the pinned tested-docs lists.
  doc = null,
  testedDocs,
  auditTestedDocs,
  // Untouched symlink and submodule entries (a linked skills folder, vendored repos), and
  // the side ('candidate' | 'main') that retargets the symlink.
  links = false,
  retarget = null,
} = {}) {
  const blobs = new Map();
  let calls = 0,
    maxWindow = 0;
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const sha = digest(bytes);
    blobs.set(sha, bytes);
    return sha;
  };
  const file = ([path, text]) => ({ path, blob: put(text), mode: 'file' });
  const original = [
    ...baselineFiles,
    ...(shared
      ? [
          [
            'tests/shared.test.mjs',
            "import '../convex/projectConvexSourceOutput.ts'; import '../dist/native-projection.js';",
          ],
        ]
      : []),
    ...(doc ? [[doc, 'a\nb\nc\n']] : []),
  ].map(file);
  const link = (path, target, mode) => ({ path, blob: put(target), mode });
  if (links)
    original.push(
      link('.claude/skills', '../.agents/skills', 'symlink'),
      link('vendor/sub', 'e02e9d405b8848909f4f746b61b12a663f631c7c', 'gitlink'),
    );
  const retargeted = link('.claude/skills', '../other/skills', 'symlink');
  const relink = files => [...files.filter(f => f.path !== retargeted.path), retargeted];
  const state = files =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files,
        message: 'synthetic',
        at: '2026-10-30T07:42:55.000Z',
      }),
    );
  const base = state(original),
    changed = file(['convex/projectConvexSourceOutput.ts', 'export const cost = 2;']);
  let candidate = [...original.filter(f => f.path !== changed.path), changed];
  if (retarget === 'candidate') candidate = relink(candidate);
  if (unknown) candidate.push(file(['unknown.config', 'unknown']));
  if (risk) candidate.push(file([risk, 'risk']));
  const edit = (files, text) => (doc ? [...files.filter(f => f.path !== doc), file([doc, text])] : files);
  const mainDelta = overlap
    ? file([changed.path, 'export const cost = 3;'])
    : file(['src/native-projection.ts', 'export const old = 2;']);
  let main = [...original.filter(f => f.path !== mainDelta.path), mainDelta];
  if (retarget === 'main') main = relink(main);
  if (mainRisk) main.push(file([mainRisk, 'risk']));
  let merged = [...candidate.filter(f => f.path !== mainDelta.path), mainDelta];
  if (retarget === 'main') merged = relink(merged);
  if (mainRisk) merged.push(main.at(-1));
  if (corrupt) merged.push(file(['extra.txt', 'unexpected recomposition']));
  const docs = paths => (paths ? { testedDocs: { rule: 'name-mention-v1', paths } } : {});
  const heads = [
    base,
    state(edit(candidate, 'A\nb\nc\n')),
    state(edit(main, 'a\nb\nC\n')),
    state(edit(merged, 'A\nb\nC\n')),
  ];
  const pin = value => put(JSON.stringify(value));
  const selection = pin({ scope, tests: ['tests/convex-source-r2.test.mjs'], ...docs(testedDocs) });
  const basis = {
    checked: { id: randomUUID(), head: heads[1], digest: 'a'.repeat(64) },
    checkedBase: { head: heads[0], receiptId: 'before' },
    main: { head: heads[2], receiptId: 'b18' },
    head: heads[3],
    runId: randomUUID(),
    terminalDigest: 'b'.repeat(64),
    planDigest: 'c'.repeat(64),
    audit: {
      source: 'main-receipt',
      head: heads[2],
      runId: randomUUID(),
      terminalDigest: 'd'.repeat(64),
      planDigest: 'e'.repeat(64),
      selection: pin({ scope: 'full', tests: [], ...docs(auditTestedDocs) }),
      sequence: 1,
      coverage: 'main-audit-debt',
    },
  };
  const read = async hashes => {
    calls++;
    maxWindow = Math.max(maxWindow, hashes.length);
    return hashes.map(h => blobs.get(h));
  };
  return { basis, selection, read, blobs, pin, metrics: () => ({ calls, maxWindow }) };
}

test('owner-hold reuse requires identical paths, hashes and modes, a full check and verified bytes', async () => {
  const f = fixture({ risk: '.github/workflows/check.yml' });
  const checked = JSON.parse(f.blobs.get(f.basis.checked.head));
  const basis = { ...f.basis, head: f.pin({ ...checked, parents: [f.basis.main.head] }) };
  const prove = (head = basis.head, selection = f.selection, read = f.read) =>
    analyzeCrossHeadReuse({ ...basis, head }, selection, read, [], false, true);
  const decision = await prove();
  assert.equal(decision.proof.algorithm, 'exact-tree-v1');
  assert(validCrossHeadProof(decision.proof));
  assert.deepEqual(f.metrics(), { calls: 2, maxWindow: 4 }, 'only four manifests and two selections');
  for (const change of [
    files => files.slice(1),
    files => [{ ...files[0], path: 'renamed' }, ...files.slice(1)],
    files => [{ ...files[0], blob: 'f'.repeat(64) }, ...files.slice(1)],
    files => [{ ...files[0], mode: 'executable' }, ...files.slice(1)],
  ])
    assert.deepEqual(await prove(f.pin({ ...checked, files: change(checked.files) })), {
      reason: 'composition-not-exact',
    });
  assert.deepEqual(await prove(basis.head, f.pin({ scope: 'docs' })), { reason: 'checked-not-full' });
  assert.deepEqual(
    await prove(basis.head, f.selection, async hashes => (await f.read(hashes)).map(() => Buffer.from('{}'))),
    { reason: 'source-unavailable' },
  );
});

test('clean path-disjoint composition lands on its first check from six small reads, no source text', async () => {
  const f = fixture(),
    { proof } = await analyzeCrossHeadReuse(f.basis, f.selection, f.read, ['scripts/forge-check.mjs']);
  assert(proof);
  assert(validCrossHeadProof(proof));
  assert.equal(proof.algorithm, 'clean-disjoint-v2');
  assert.deepEqual(proof.docsOverlap, []);
  assert.deepEqual(proof.candidatePaths, ['convex/projectConvexSourceOutput.ts']);
  assert.deepEqual(proof.mainPaths, ['src/native-projection.ts']);
  assert.equal(proof.checkedScope, 'full');
  assert.equal(proof.head, f.basis.head);
  // Four manifests, then the two selection pins: no import graph, no blobs.
  assert.deepEqual(f.metrics(), { calls: 2, maxWindow: 4 });
});
test('untouched symlinks and submodules anywhere in the tree do not block a first-check landing', async () => {
  const f = fixture({ links: true }),
    { proof } = await analyzeCrossHeadReuse(f.basis, f.selection, f.read, ['.bench/ci.sh']);
  assert(proof, 'a linked skills folder or a vendored submodule is not a reason to recheck');
  assert(validCrossHeadProof(proof));
  assert.deepEqual(f.metrics(), { calls: 2, maxWindow: 4 });
});
test('shared affected tests no longer block a path-disjoint first-check landing (owner option A)', async () => {
  const f = fixture({ shared: true });
  assert((await analyzeCrossHeadReuse(f.basis, f.selection, f.read)).proof);
});
for (const [option, reason] of [
  [{ overlap: true }, 'path-overlap'],
  [{ corrupt: true }, 'composition-not-exact'],
  [{ unknown: true }, 'global-risk'],
  [{ risk: 'pnpm-lock.yaml' }, 'global-risk'],
  [{ mainRisk: 'web/tsconfig.json' }, 'order-sensitive'],
  [{ mainRisk: '.github/workflows/forge-check.yml' }, 'order-sensitive'],
  [{ risk: 'scripts/check-contract.mjs' }, 'order-sensitive'],
  [{ mainRisk: 'convex/schema.ts' }, 'order-sensitive'],
  [{ risk: 'tools/run-check.mjs' }, 'order-sensitive'],
  [{ scope: 'scoped' }, 'checked-not-full'],
  [{ links: true, retarget: 'candidate' }, 'unsupported-mode'],
  [{ links: true, retarget: 'main' }, 'unsupported-mode'],
])
  test(`${JSON.stringify(option)} rechecks: ${reason}`, async () => {
    const f = fixture(option);
    assert.deepEqual(await analyzeCrossHeadReuse(f.basis, f.selection, f.read, ['tools/run-check.mjs']), {
      reason,
    });
  });
test('a text-clean merge of Markdown no test reads lands on its first check (clean-disjoint-v2)', async () => {
  const f = fixture({ doc: 'docs/notes.md', testedDocs: ['AGENTS.md'] });
  const { proof } = await analyzeCrossHeadReuse(f.basis, f.selection, f.read);
  assert(proof, 'untested Markdown overlap lands');
  assert.equal(proof.algorithm, 'clean-disjoint-v2');
  assert.deepEqual(proof.docsOverlap, ['docs/notes.md']);
  assert.equal(proof.testedDocsRule, 'name-mention-v1');
  assert(validCrossHeadProof(proof));
  // The same six small reads as a disjoint proof: no Markdown bytes are read.
  assert.deepEqual(f.metrics(), { calls: 2, maxWindow: 4 });
  // Publication revalidates: a non-Markdown or undeclared overlap is never valid.
  assert(!validCrossHeadProof({ ...proof, docsOverlap: [] }));
  assert(
    !validCrossHeadProof({
      ...proof,
      docsOverlap: ['docs/notes.md', 'src/native-projection.ts'],
      candidatePaths: [...proof.candidatePaths, 'src/native-projection.ts'],
    }),
  );
});
for (const [name, option, reason] of [
  ['tested on the checked source', { doc: 'AGENTS.md', testedDocs: ['AGENTS.md'] }, 'tested-doc'],
  [
    'tested on the audited main',
    { doc: 'docs/notes.md', testedDocs: [], auditTestedDocs: ['docs/notes.md'] },
    'tested-doc',
  ],
  ['the run pinned no tested-docs list', { doc: 'docs/notes.md' }, 'tested-doc'],
  ['Markdown plus a code overlap', { doc: 'docs/notes.md', testedDocs: [], overlap: true }, 'path-overlap'],
  ['a non-Markdown text merge', { doc: 'docs/notes.txt', testedDocs: [] }, 'path-overlap'],
])
  test(`a clean Markdown merge rechecks when ${name}: ${reason}`, async () => {
    const f = fixture(option);
    assert.deepEqual(await analyzeCrossHeadReuse(f.basis, f.selection, f.read), { reason });
  });
test('a first check without a recorded full scope cannot carry a landing', async () => {
  const f = fixture();
  const pin = f.pin({ tests: [] });
  assert.deepEqual(await analyzeCrossHeadReuse(f.basis, pin, f.read), { reason: 'checked-not-full' });
});
test('publication revalidates the proof: overlap or global risk invalidates a stored clean-disjoint proof', async () => {
  const f = fixture(),
    { proof } = await analyzeCrossHeadReuse(f.basis, f.selection, f.read);
  assert(validCrossHeadProof(proof));
  assert(!validCrossHeadProof({ ...proof, mainPaths: [...proof.mainPaths, 'convex'] }));
  assert(!validCrossHeadProof({ ...proof, mainPaths: [...proof.mainPaths, 'pnpm-lock.yaml'] }));
  assert(!validCrossHeadProof({ ...proof, checkEntries: ['src/native-projection.ts'] }));
});
test('source analysis unavailable falls back through the internal action, without a partial proof', async () => {
  const f = fixture(),
    mutations = [];
  await reuseAction.prove._handler(
    {
      runQuery: async (_ref, args) =>
        args.digests
          ? args.digests.map(sha256 => ({ object: { sha256, size: 9 * 1024 * 1024 } }))
          : { pendingId: 'same-attempt', actor: 'owner', basis: f.basis, selection: f.selection },
      runMutation: async (ref, args) => {
        if (getFunctionName(ref).endsWith(':claim')) return 'analysis-owner';
        if (getFunctionName(ref).endsWith(':renew')) return true;
        mutations.push(args);
        return null;
      },
    },
    { projectId: 'synthetic', submissionId: randomUUID(), pendingId: 'same-attempt' },
  );
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].proof, null);
  assert.equal(mutations[0].reason, 'source-unavailable');
});

test('READY pass survives a source-and-impact-disjoint main advance: one passed check, no CHECKING retry', async t => {
  const { f, state, before, parent } = await readyRace(t);
  // Drain only the foreground lifecycle; audit debt intentionally owns one future wake.
  for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'landed'; n++) {
    assert(f.pending().length, JSON.stringify(await f.current(state.id)));
    await f.execute();
  }
  const current = await f.current(state.id);
  assert.equal(current.submission.phase, 'landed');
  assert.equal(
    f.tables.projectHostedCheckRuns.size,
    2,
    'one Candidate check plus the existing full main check',
  );
  const receipt = JSON.parse(
    [...f.tables.projectHostedAcceptances.values()].find(row => row.submissionId === state.id).value,
  );
  assert.equal(receipt.check.runId, before.check.runId);
  assert(receipt.crossHeadProof);
  assert.notEqual(receipt.candidate.head, receipt.crossHeadProof.checked.head);
  const audit = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(audit.unaudited.count, 1);
  assert.equal(audit.lastGreen.runId, parent.id);
  assert(audit.wake);
  const replay = await f.tx('reuseReplay', reuse.complete, {
    projectId: f.projectId,
    submissionId: state.id,
    pendingId: randomUUID(),
    owner: 'already-completed',
    proof: null,
  });
  assert.equal(replay, null);
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  await f.tx('reuseAuditStart', mainAudit.start, { projectId: f.projectId });
  const selected = [...f.tables.projectHostedCheckRuns.values()]
    .map(row => JSON.parse(row.value))
    .find(run => run.gate?.mode === 'audit');
  assert.equal(selected.request.expectedHead, receipt.candidate.head);
  const running = await f.rawChecks.activate(selected.id);
  for (let i = 0; i < running.plan.shardCount; i++)
    await f.rawChecks.callback(f.rawChecks.shard(running, i, 'failed'));
  await f.rawChecks.callback(f.rawChecks.complete(running, 'failed'));
  const red = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(red.red.runId, selected.id);
  assert.equal(red.lastGreen.runId, parent.id);
  assert(
    f.pending().some(task => task.name === 'projectHostedCulprit:startRedClassification'),
    'failure enters the existing culprit/fix-forward/compensating-revert path',
  );
});

test('two disjoint main advances re-prove the original pass without inherited-check chains or replacement checks', async t => {
  const { f, state, before, parent } = await readyRace(t);
  let prepared = false;
  for (let n = 0; n < 80; n++) {
    const selected = await f.status(state.id);
    if (selected.attempt.crossHeadProof && selected.request.phase === 'ready') {
      prepared = true;
      break;
    }
    await f.execute();
  }
  assert(prepared);
  const previous = f.currentMain();
  f.moveMain();
  await seedFullMain(f, parent.plan.selection, previous);
  for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'landed'; n++) await f.execute();
  const selected = await f.status(state.id);
  assert.equal(selected.request.phase, 'landed');
  assert.equal(selected.attempt.crossHeadProof.checked.head, before.candidate.head);
  assert.equal(selected.attempt.check.runId, before.check.runId);
  assert.equal(
    f.tables.projectHostedCheckRuns.size,
    3,
    'one Candidate check plus two independently accepted full main checks',
  );
});

test('a slow proof has one renewable owner; watchdogs do not duplicate it and expiry falls back once', async t => {
  const { f, state } = await readyRace(t),
    args = await pendingProof(f, state);
  const owner = await f.tx('proofClaim', reuse.claim, args);
  assert(owner);
  assert.equal(await f.tx('proofClaimLostReply', reuse.claim, args), owner);
  assert.equal(await f.tx('proofDuplicateClaim', reuse.claim, { ...args, owner: randomUUID() }), null);
  f.advanceClock(45_000);
  assert.equal(await f.tx('proofRenew', reuse.renew, { ...args, owner }), true);
  const until = f.row(state.id).reuseLease.until;
  await f.execute(f.pending().find(task => task.name === 'projectHostedFinishDriver:drive'));
  assert.equal(f.row(state.id).wake.at, until);
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  f.advanceClock(60_001);
  assert.equal(await f.tx('proofLateRenew', reuse.renew, { ...args, owner }), false);
  assert.equal(await f.tx('proofLateCallback', reuse.complete, { ...args, owner, proof: null }), null);
  await f.execute(f.pending().find(task => task.name === 'projectHostedFinishDriver:drive'));
  assert.equal(f.row(state.id).reuseLease, undefined);
  for (let n = 0; n < 20 && (await f.current(state.id)).submission.phase !== 'checking'; n++)
    await f.execute();
  assert.equal(f.tables.projectHostedCheckRuns.size, 3, 'only one fallback check');
  const attempt = (await f.status(state.id)).attempt.id;
  await f.tx('proofOldCallbackAgain', reuse.complete, { ...args, owner, proof: null });
  assert.equal((await f.status(state.id)).attempt.id, attempt);
});

test('cancellation during proof analysis fences completion and cannot revive a submission', async t => {
  const { f, state } = await readyRace(t),
    args = await pendingProof(f, state);
  const owner = await f.tx('proofClaimBeforeCancel', reuse.claim, args);
  assert(owner);
  await f.tx('proofCancel', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: state.id }),
  });
  assert.equal(await f.tx('cancelledProofRenew', reuse.renew, { ...args, owner }), false);
  await f.tx('cancelledProofComplete', reuse.complete, { ...args, owner, proof: null });
  assert.equal((await f.current(state.id)).submission.phase, 'terminal-failed');
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
});

test('a39b1cdb shape (disjoint paths, overlapping Convex impact) now lands on its first check; the prompt audit verifies main', async t => {
  // Selected real changed path names; synthetic source bytes preserve privacy.
  // Under owner option A (2026-11-06) shared test impact no longer forces a recheck:
  // the coalesced main audit runs at once instead and recovery handles a red result.
  const { f, state, before } = await readyRace(t, {
    extra: [
      ['convex/projectFreshness.ts', "import './projectConvexSourceOutput.ts'; export const freshness = 1;"],
      ['tests/project-freshness.test.mjs', "import '../convex/projectFreshness.ts';"],
    ],
    mainFiles: [['convex/projectFreshness.ts', null]],
  });
  for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'landed'; n++) await f.execute();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  assert.equal(f.tables.projectHostedCheckRuns.size, 2, 'existing main pass plus the one Candidate check');
  const receipt = JSON.parse(
    [...f.tables.projectHostedAcceptances.values()].find(row => row.submissionId === state.id).value,
  );
  assert.equal(receipt.crossHeadProof.algorithm, 'clean-disjoint-v2');
  assert.equal(receipt.check.runId, before.check.runId);
  const audit = [...f.tables.projectHostedMainAudits.values()][0];
  assert.equal(audit.firstCheck, receipt.snapshot.revision);
  assert(audit.wake.at <= Date.now(), 'first-check landings arm the main audit at once');
});
test('a text conflict with main never lands on the first check', async t => {
  const { f, state } = await readyRace(t, {
    mainFiles: [['convex/projectConvexSourceOutput.ts', 'export const cost = 3;']],
  });
  for (let n = 0; n < 80 && f.pending().length; n++) await f.execute();
  const current = await f.current(state.id);
  assert.notEqual(current.submission.phase, 'landed');
  assert.equal(current.submission.error?.code, 'COMPOSITION_CONFLICT');
  assert.equal(f.tables.projectHostedCheckRuns.size, 2, 'no check runs for a conflicting composition');
  assert.deepEqual(f.reuseDecisions, []);
});
test('a path the change and main both touch rechecks and records path-overlap', async t => {
  // Main made the same edit: the composition is clean, but the path overlaps.
  const { f, state } = await readyRace(t, {
    mainFiles: [
      ['convex/projectConvexSourceOutput.ts', 'export const cost = 2;'],
      ['src/native-projection.ts', 'export const old = 2;'],
    ],
  });
  for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'checking'; n++)
    await f.execute();
  assert.equal((await f.current(state.id)).submission.phase, 'checking');
  assert.equal(f.tables.projectHostedCheckRuns.size, 3, 'main pass, Candidate check and its recheck');
  assert.equal((await f.status(state.id)).attempt.crossHeadProof, undefined);
  assert.deepEqual(f.reuseDecisions, ['path-overlap']);
});
test('explicit hostedCrossHeadReuse:false retains the exact recheck', async t => {
  const { f, state } = await readyRace(t, { disabled: true });
  for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'checking'; n++)
    await f.execute();
  assert.equal((await f.current(state.id)).submission.phase, 'checking');
  assert.equal(
    f.tables.projectHostedCheckRuns.size,
    3,
    'existing main pass plus original and replacement checks',
  );
  assert.equal((await f.status(state.id)).attempt.crossHeadProof, undefined);
  assert.deepEqual(f.reuseDecisions, []);
});

async function landsOnFirstCheck(t, options) {
  const { f, state, before } = await readyRace(t, options);
  for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'landed'; n++) {
    if (!f.pending().length) break;
    await f.execute();
  }
  return { f, state, before, phase: (await f.current(state.id)).submission.phase };
}
for (const [name, member] of [
  ['listed in autoActors', { autoActors: ['owner'] }],
  ['trusted on the Candidate paths', { trust: true, delegated: true }],
]) {
  test(`a team member ${name} keeps its passed check across a clean overtake`, async t => {
    const { f, state, before, phase } = await landsOnFirstCheck(t, { member });
    assert.equal(phase, 'landed');
    assert.equal(f.tables.projectHostedCheckRuns.size, 2, 'no replacement check');
    const receipt = JSON.parse(
      [...f.tables.projectHostedAcceptances.values()].find(row => row.submissionId === state.id).value,
    );
    assert.equal(receipt.check.runId, before.check.runId);
    assert(receipt.crossHeadProof);
  });
}
for (const [name, member] of [
  ['with no list and no trust policy', {}],
  ['with trust on but none earned', { trust: true }],
  ['off a non-empty autoActors list', { autoActors: ['someone-else'], trust: true, delegated: true }],
]) {
  test(`an untrusted team member ${name} gets the exact recheck`, async t => {
    const { f, state } = await readyRace(t, { member });
    for (let n = 0; n < 80 && (await f.current(state.id)).submission.phase !== 'checking'; n++)
      await f.execute();
    assert.equal((await f.current(state.id)).submission.phase, 'checking');
    assert.equal((await f.status(state.id)).attempt.crossHeadProof, undefined);
    assert.deepEqual(f.reuseDecisions, []);
  });
}
