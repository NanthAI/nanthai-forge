// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item fe2b0a86: a protected-path approval is bound to the approved paths' content in what would land,
// not to the main head. Incident (licence Lane, Item ffb6cc49, 2026-11-23): the Lane changed a protected
// file and many ordinary files; every main landing that touched one of the ordinary files recomposed the
// held submission and asked the owner again, although no protected file had changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { batchesFixture } from './hosted-landing-batches-fixture.mjs';
import { policyPreset as preset } from '../dist/autonomy-policy.js';
import { observeHostedSubmissions } from '../dist/hosted-agent-submission-wait.js';
import { waitEventLine } from '../dist/hosted-wait-line.js';
const acceptance = await import(moduleUrl('../convex/projectHostedAcceptance.ts'));
const history = await import(moduleUrl('../convex/projectHostedLandingAttemptHistory.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));

const { reviewProtect, protectedEntries } = await import('../dist/protected-review.js');
const { grantedApproval } = await import(moduleUrl('../convex/projectHostedOwnerGrant.ts'));

const GUARD = 'guard.txt';
const SHARED = 'shared.txt';

function syntheticR2(t) {
  const synthetic = {
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
    FORGE_WEB_URL: 'https://forge.example.invalid',
    FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  };
  const previous = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** The licence shape: the Lane edits the protected file and an ordinary file; main then edits only
 * the ordinary file (other lines, so it merges cleanly). */
async function licenceShape(t, mainFiles, mode = 'trusted') {
  syntheticR2(t);
  const f = await finishFixture(t, {
    baselineFiles: [
      [GUARD, 'guard v1\nkeep\nguard end\n'],
      [SHARED, 'header apache\nmiddle\nend\n'],
    ],
    selectedFiles: [
      [GUARD, 'guard v2\nkeep\nguard end\n'],
      [SHARED, 'header agpl\nmiddle\nend\n'],
    ],
    mainFiles,
  });
  const policy = { ...preset(mode), agentDefaults: { preflight: 'advise' } };
  policy.acceptance.ownerApprovalPaths = [GUARD];
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  return { f, state };
}

async function readback(f, state) {
  const queue = JSON.parse(
    await f.tx('carryQueue', history.read, { projectId: f.projectId, submissionId: state.id }),
  );
  const events = [];
  await observeHostedSubmissions(
    {
      root: '/tmp/root',
      address: { url: 'https://forge.example.invalid', projectId: f.projectId },
      dispatch: async () => ({ result: { actor: 'owner' } }),
      query: async (_, { nextVersion }) =>
        f.tx('carryWait', observe.page, {
          projectId: f.projectId,
          operationId: state.operationId,
          nextVersion,
        }),
    },
    { operationIds: [state.operationId], until: 'acceptance', timeoutSeconds: 0 },
    undefined,
    event => events.push(event),
  );
  const wait = events.map(waitEventLine).findLast(event => event?.line.type === 'submission')?.line;
  return {
    queue,
    wait,
    selection: { projectId: f.projectId, submissionId: state.id, attemptId: queue.currentAttemptId },
  };
}

const UNCHANGED_GUARD = [GUARD, 'guard v1\nkeep\nguard end\n'];
const sharedEdit = n => [SHARED, `header apache\nmiddle\nmain edit ${n}\n`];
const approvalsOf = f =>
  [...f.tables.projectHostedLandingRequests.values()]
    .filter(row => row.ownerGrant)
    .map(row => row.ownerGrant);

test('f081111a review replay: approved work that is already on main settles before comparison IO', async t => {
  const { f, state } = await licenceShape(t, [
    [GUARD, 'guard v2\nkeep\nguard end\n'],
    [SHARED, 'header agpl\nmiddle\nend\n'],
  ]);
  const held = await readback(f, state);
  assert.equal(held.wait.reviewState, 'held');
  const main = f.moveMain();
  const runs = f.tables.projectHostedCheckRuns.size;
  await f.tx('approveNowEmpty', acceptance.approve, held.selection);
  await f.drain();
  assert.equal((await f.current(state.id)).submission.error?.code, 'NOTHING_TO_LAND');
  assert.equal(f.tables.projectHostedCheckRuns.size, runs);
  assert.equal(JSON.parse(f.row(state.id).value).pending, null);
  assert.deepEqual(f.currentMain(), main);
  assert.equal(f.pending().length, 0);
});

test('fe2b0a86: the approval survives a main move that does not touch the approved paths, and lands without a new request', async t => {
  const { f, state } = await licenceShape(t, [UNCHANGED_GUARD, sharedEdit(1)]);
  const held = await readback(f, state);
  assert.equal(held.wait.reviewState, 'held');
  f.moveMain();
  await f.tx('approveOnce', acceptance.approve, held.selection);
  await f.drain();
  const moved = await readback(f, state);
  assert.notEqual(moved.selection.attemptId, held.selection.attemptId, 'main moved: a new attempt');
  assert.equal(moved.wait.reviewState, 'approved-carried', 'no new owner request');
  await f.passChecks();
  await f.drain();
  const landed = (await f.current(state.id)).submission;
  assert.equal(landed.phase, 'landed');
  assert.equal(landed.acceptance.acceptedBy.carried, true);
  // The audit: the receipt names the main the carry was checked against (its previous main, the
  // accepted attempt's base); acceptedBy.carried above says the approval came from an earlier attempt.
  const receipt = JSON.parse([...f.tables.projectHostedAcceptances.values()][0].value);
  assert.equal(typeof receipt.previous.head, 'string');
});

test('fe2b0a86: main changing an approved path asks again, even though the change merges cleanly', async t => {
  const { f, state } = await licenceShape(t, [[GUARD, 'guard v1\nkeep\nmain guard edit\n'], sharedEdit(1)]);
  const held = await readback(f, state);
  f.moveMain();
  await f.tx('approveBeforeGuardMove', acceptance.approve, held.selection);
  await f.drain();
  const moved = await readback(f, state);
  assert.notEqual(moved.selection.attemptId, held.selection.attemptId);
  assert.equal(moved.wait.reviewState, 'needs-reapproval');
  assert.deepEqual(moved.wait.hold.paths, [GUARD]);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('fe2b0a86 fail closed: a hold that is not about protected paths alone (supervised review) still compares every changed file', async t => {
  const { f, state } = await licenceShape(t, [UNCHANGED_GUARD, sharedEdit(1)], 'supervised');
  const held = await readback(f, state);
  assert.equal(held.wait.reviewState, 'held');
  f.moveMain();
  await f.tx('approveSupervised', acceptance.approve, held.selection);
  await f.drain();
  const moved = await readback(f, state);
  assert.equal(moved.wait.reviewState, 'needs-reapproval', 'the person reviews the new content again');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('fe2b0a86 incident replay (licence submission c49fae56): four main moves through the Lane files, one approval', async t => {
  const { f, state } = await licenceShape(t, [UNCHANGED_GUARD, sharedEdit(0)]);
  const held = await readback(f, state);
  f.moveMain({ files: [UNCHANGED_GUARD, sharedEdit(1)] });
  await f.tx('approveLicenceOnce', acceptance.approve, held.selection);
  await f.drain();
  const attempts = new Set([held.selection.attemptId]);
  for (const n of [2, 3, 4]) {
    const now = await readback(f, state);
    assert.equal(now.wait.reviewState, 'approved-carried', `recompose ${n - 1} keeps the approval`);
    attempts.add(now.selection.attemptId);
    // Another Lane lands a header fix in a file this Lane also changed while the check runs.
    f.moveMain({ files: [UNCHANGED_GUARD, sharedEdit(n)] });
    await f.passChecks();
    await f.drain();
  }
  const last = await readback(f, state);
  assert.equal(last.wait.reviewState, 'approved-carried');
  attempts.add(last.selection.attemptId);
  assert.equal(attempts.size, 5, 'one held attempt and four recompositions, as on c49fae56');
  await f.passChecks();
  await f.drain();
  const landed = (await f.current(state.id)).submission;
  assert.equal(landed.phase, 'landed');
  assert.equal(landed.acceptance.acceptedBy.carried, true);
  assert.equal(approvalsOf(f).length, 1, 'exactly one owner approval');
});

test('fe2b0a86 fail closed: an approved listing that is gone asks again', async t => {
  const { f, state } = await licenceShape(t, [UNCHANGED_GUARD, sharedEdit(1)]);
  const held = await readback(f, state);
  // The approved Candidate's pinned listing was removed: the approval can no longer be proven.
  const listing = [...f.tables.projectHostedRecords.values()].find(row => row.candidateFiles)?.candidateFiles;
  assert(listing, 'the approved Candidate pins a listing');
  const object = [...f.tables.projectObjects.values()].find(row => row.digest === listing.sha256);
  assert(object, 'the listing has an object row');
  f.patch('projectObjects', object._id, { removed: true });
  f.moveMain();
  await f.tx('approveGone', acceptance.approve, held.selection);
  await f.drain();
  const moved = await readback(f, state);
  assert.notEqual(moved.selection.attemptId, held.selection.attemptId);
  assert.equal(moved.wait.reviewState, 'needs-reapproval');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('fe2b0a86: a failed listing read retries the finish instead of asking the owner again', async t => {
  const { f, state } = await licenceShape(t, [UNCHANGED_GUARD, sharedEdit(1)]);
  const held = await readback(f, state);
  // Storage cannot serve the approved listing (an outage): nothing lands and no new request is made.
  const listing = [...f.tables.projectHostedRecords.values()].find(row => row.candidateFiles)?.candidateFiles;
  f.c.objects.delete(listing.sha256);
  f.moveMain();
  await f.tx('approveOutage', acceptance.approve, held.selection);
  await assert.rejects(f.drain(), /Network request failed/);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.notEqual((await readback(f, state)).wait.reviewState, 'needs-reapproval');
});

test('fe2b0a86 fail closed: a folder-grant landing keeps the whole-list rule, since the owner also stands in for its grant', async t => {
  const { f, state } = await licenceShape(t, [UNCHANGED_GUARD, sharedEdit(1)]);
  const held = await readback(f, state);
  const row = [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === state.id);
  f.patch('projectHostedLandingRequests', row._id, {
    grant: { credentialId: 'synthetic-device', paths: [GUARD, SHARED] },
  });
  f.moveMain();
  await f.tx('approveGranted', acceptance.approve, held.selection);
  await f.drain();
  assert.equal((await readback(f, state)).wait.reviewState, 'needs-reapproval');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('fe2b0a86: a different change to the approved protected file is a new submission and gets its own owner request', async t => {
  syntheticR2(t);
  const f = await batchesFixture(t, {
    count: 0,
    fileCount: 2,
    requestCheck: true,
    admissionCheck: 'full',
    checkCommand: { executable: 'bash', args: ['ci/verify.sh'] },
    memberPaths: ['ci/verify.sh', 'ci/verify.sh'],
    memberContents: ['echo approved', 'echo changed after approval'],
  });
  const settle = async () => {
    for (let count = 0; ; count++) {
      const task = f.pending().find(task => task.scheduledTime <= f.now());
      if (!task) return;
      assert(count < 150, 'only event-driven work runs');
      await f.execute(task);
    }
  };
  const approvedChange = await f.add(0);
  await settle();
  const first = await readback(f, approvedChange);
  assert.equal(first.wait.reviewState, 'held');
  await f.tx('approveFirstChange', acceptance.approve, first.selection);
  await settle();
  const changed = await f.add(1);
  await settle();
  const second = await readback(f, changed);
  assert.equal(second.wait.reviewState, 'held', 'the changed protected file waits for the owner');
  assert.equal(
    [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === changed.id).ownerGrant,
    undefined,
  );
  assert.equal(
    [...f.tables.projectHostedAcceptances.values()].filter(r => r.submissionId === changed.id).length,
    0,
  );
});

test('fe2b0a86: the binding is the protected entries with their before and after content; anything unprovable compares everything', () => {
  const policy = { ...preset('trusted') };
  policy.acceptance.ownerApprovalPaths = [GUARD];
  const project = { owner: 'owner' };
  const paths = [GUARD, SHARED];
  const scope = reviewProtect(project, policy, 'owner', [paths, paths], []);
  assert(scope, 'a hold about the protected path alone is scoped');
  const entry = (path, before, after) => ({
    path,
    status: 'modified',
    before: { blob: before },
    after: { blob: after },
  });
  const approved = [entry(GUARD, 'g1', 'g2'), entry(SHARED, 's1', 's2')];
  const key = files => JSON.stringify(protectedEntries(files, scope));
  // Main moved an ordinary file the Lane also changed: same binding.
  assert.equal(key([entry(GUARD, 'g1', 'g2'), entry(SHARED, 's1-main', 's2-merged')]), key(approved));
  // Main changed the approved file: different binding, even with the same result.
  assert.notEqual(key([entry(GUARD, 'g1-main', 'g2'), entry(SHARED, 's1', 's2')]), key(approved));
  // The Lane changed the approved file: different binding.
  assert.notEqual(key([entry(GUARD, 'g1', 'g3'), entry(SHARED, 's1', 's2')]), key(approved));
  // The secret-allow file is bound too: its additions were part of what the owner saw.
  assert.notEqual(key([...approved, entry('.forge-secret-allow.json', 'a', 'b')]), key(approved));
  // Fail closed: unknown paths, no derived check entries, no protected path, or another review reason.
  assert.equal(reviewProtect(project, policy, 'owner', [paths, null], []), undefined);
  assert.equal(reviewProtect(project, policy, 'owner', [paths, paths], undefined), undefined);
  assert.equal(reviewProtect(project, policy, 'owner', [[SHARED], [SHARED]], []), undefined);
  const supervised = preset('supervised');
  supervised.acceptance.ownerApprovalPaths = [GUARD];
  assert.equal(reviewProtect(project, supervised, 'owner', [paths, paths], []), undefined);
  // An actor outside the auto-accept list is held for review of every file: no scope.
  const listed = { ...preset('trusted') };
  listed.acceptance.ownerApprovalPaths = [GUARD];
  listed.acceptance.autoActors = ['someone-else'];
  assert.equal(reviewProtect(project, listed, 'owner', [paths, paths], []), undefined);
  // A check entry is protected even when no pattern names it, and binds like any protected path.
  const checkScope = reviewProtect(
    project,
    preset('trusted'),
    'owner',
    [
      ['ci/verify.sh', SHARED],
      ['ci/verify.sh', SHARED],
    ],
    ['ci/verify.sh'],
  );
  assert(checkScope, 'a hold about a check entry alone is scoped');
  const checkKey = files => JSON.stringify(protectedEntries(files, checkScope));
  const checked = [entry('ci/verify.sh', 'c1', 'c2'), entry(SHARED, 's1', 's2')];
  assert.equal(checkKey([entry('ci/verify.sh', 'c1', 'c2'), entry(SHARED, 'm1', 'm2')]), checkKey(checked));
  assert.notEqual(
    checkKey([entry('ci/verify.sh', 'c1-main', 'c2'), entry(SHARED, 's1', 's2')]),
    checkKey(checked),
  );
  // A protected deletion stays an entry of its own: the same path deleted from other content differs.
  const deleted = { path: GUARD, status: 'deleted', before: { blob: 'g1' } };
  assert.equal(protectedEntries([deleted, entry(SHARED, 's1', 's2')], scope).length, 1);
  assert.notEqual(key([{ ...deleted, before: { blob: 'g1-main' } }]), key([deleted]));
  // No protected entry in a listing leaves nothing to bind to: the driver then compares every file.
  assert.deepEqual(protectedEntries([entry(SHARED, 's1', 's2')], scope), []);
  // A Lane change is a new head: the grant's pinned inputs no longer match, so it never carries.
  const attempt = {
    id: 'a1',
    candidate: { digest: 'd', inputs: { sha256: 'new-head', size: 1 }, dependencies: [] },
    policyDigest: 'p',
    check: { runId: 'r' },
  };
  const grant = {
    actor: 'owner',
    attemptId: 'a0',
    inputs: JSON.stringify({ sha256: 'approved-head', size: 1 }),
    dependencies: JSON.stringify([]),
    policyDigest: 'p',
    paths: null,
    verifiedDigest: 'd',
    at: 0,
  };
  assert.equal(grantedApproval(grant, attempt, 'owner'), undefined);
});
