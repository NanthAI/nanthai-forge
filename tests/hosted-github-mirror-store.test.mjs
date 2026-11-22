// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { effectivePolicy, policyPreset } from '../dist/autonomy-policy.js';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { auditReason } from '../dist/main-audit.js';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
const queue = await import(moduleUrl('../convex/projectGithubMirrorQueue.ts'));
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));
const objects = await import(moduleUrl('../convex/projectGithubMirrorObjects.ts'));
const action = await import(moduleUrl('../convex/projectGithubMirror.ts'));
const retarget = await import(moduleUrl('../convex/projectGithubMirrorRetarget.ts'));
const owner = await import(moduleUrl('../convex/projectGithubMirrorResume.ts'));
const verifyStore = await import(moduleUrl('../convex/projectGithubPullStatusStore.ts'));
const verifyPost = await import(moduleUrl('../convex/projectGithubPullStatus.ts'));
const { githubMirrorStatus } = await import(moduleUrl('../convex/projectGithubMirrorStatus.idle.ts'));
const cadence = await import(moduleUrl('../convex/projectGithubMirrorCadence.ts'));
const mirrorVerify = await import(moduleUrl('../convex/projectGithubMirrorVerify.ts'));
const { writeMirrorVerification } = await import(moduleUrl('../convex/projectGithubMirrorVerifyStatus.ts'));
const { observeCheckStart } = await import(moduleUrl('../convex/projectHostedCheckClock.ts'));

/** Owner-proven repository bindings are a deployment setting; tests bind their own synthetic project. */
const bindRepository = (t, projectId, repo) => {
  const prior = process.env.FORGE_GITHUB_REPO_BINDINGS;
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${projectId}=${repo}`;
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_GITHUB_REPO_BINDINGS;
    else process.env.FORGE_GITHUB_REPO_BINDINGS = prior;
  });
};

function fixture() {
  const f = lanesFixture(),
    scheduled = [],
    tasks = new Map(),
    delays = [],
    blobs = new Map();
  const projectId = f.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    sourceAuthority: { mode: 'server', epoch: 1 },
    autonomyPolicy: {
      ...policyPreset('supervised'),
      githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false },
    },
  });
  f.decorateContext(ctx => {
    ctx.db.system = { get: id => tasks.get(id) ?? ctx.db.get(id) };
    ctx.meta = { ...ctx.meta, getRequestMetadata: async () => ({ scheduledFunctionId: null }) };
    ctx.scheduler = {
      runAfter: async (delay, ref, args) => {
        scheduled.push({ name: getFunctionName(ref), args });
        delays.push(delay);
        const id = `scheduled-${scheduled.length}`;
        tasks.set(id, { _id: id, state: { kind: 'pending' }, scheduledTime: Date.UTC(2026, 0, 2) + delay });
        return id;
      },
      cancel: async id => tasks.set(id, { _id: id, state: { kind: 'canceled' } }),
    };
  });
  const run = (name, fn, input) => f.transaction(name, { _handler: fn }, input);
  const receipt = () => ({
    id: randomUUID(),
    authorityEpoch: 1,
    snapshot: { revision: scheduled.length + 1 },
    candidate: { head: 'a'.repeat(64) },
  });
  const enqueue = (r, evidence) =>
    run('enqueueMirror', async ctx =>
      queue.enqueueGithubMirror(ctx, await ctx.db.get(projectId), r, evidence),
    );
  return { ...f, run, projectId, scheduled, delays, tasks, blobs, receipt, enqueue };
}

function timedMirror(f, push, pushedAt, durations) {
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { ...project.autonomyPolicy.githubMirror, push },
    },
  });
  const row = f.insert('projectGithubMirrors', {
    projectId: f.projectId,
    repository: 'synthetic/mirror',
    activeId: null,
    mapping: JSON.stringify(mirrorFixture().root),
    pushedAt,
    checkWalls: durations.map((milliseconds, index) => ({
      runId: `check-${index}`,
      at: pushedAt - index,
      milliseconds,
    })),
  });
  return row;
}

function mirrorLanding(f, now, revision) {
  return { ...f.receipt(), at: new Date(now).toISOString(), snapshot: { revision } };
}

test('a mirror retains its last 20 full-check wall times without counting a duplicate or scoped run', async t => {
  const now = Date.UTC(2026, 0, 2);
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  const mirror = timedMirror(
    f,
    'automatic',
    now - 10_000,
    Array.from({ length: 20 }, () => 60_000),
  );
  const terminal = {
    id: 'latest-full',
    projectId: f.projectId,
    status: 'passed',
    endedAt: new Date(now).toISOString(),
  };
  observeCheckStart(terminal, new Date(now - 150_000).toISOString());
  await f.run('recordFullMirrorTiming', ctx => mirrorVerify.noteMirrorCheck(ctx, terminal));
  await f.run('replayFullMirrorTiming', ctx => mirrorVerify.noteMirrorCheck(ctx, terminal));
  const reduced = { ...terminal, id: 'latest-reduced', gate: { mode: 'scoped' } };
  observeCheckStart(reduced, new Date(now - 20_000).toISOString());
  await f.run('ignoreReducedMirrorTiming', ctx => mirrorVerify.noteMirrorCheck(ctx, reduced));
  const walls = f.tables.projectGithubMirrors.get(mirror).checkWalls;
  assert.equal(walls.length, 20);
  assert.deepEqual(walls[0], { runId: 'latest-full', at: now, milliseconds: 150_000 });
  assert.equal(walls[1].runId, 'check-0');
  assert.equal(walls.at(-1).runId, 'check-18');
});

for (const [mode, durations, wait] of [
  ['automatic', [], 0],
  ['automatic', [180_000, 300_000], 230_000],
  ['every-landing', [240_000], 0],
  ['batch-quick-landings', [], 0],
  ['batch-quick-landings', [30_000], 50_000],
  ['automatic', [20 * 60_000], 590_000],
]) {
  test(`mirror cadence ${mode} with ${durations.length} full checks uses its configured burst window`, async t => {
    const now = Date.UTC(2026, 0, 2);
    t.mock.method(Date, 'now', () => now);
    const f = fixture();
    const mirror = timedMirror(f, mode, now - 10_000, durations);
    await f.enqueue(mirrorLanding(f, now, 2));
    assert.equal(f.delays[0], wait);
    assert.equal(f.tables.projectGithubMirrors.get(mirror).hold?.until, wait ? now + wait : undefined);
  });
}

test('a burst owns one wake from the last push and a revert flushes through its own sequence', async t => {
  let now = Date.UTC(2026, 0, 2);
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  const mirror = timedMirror(f, 'batch-quick-landings', now - 10_000, [60_000]);
  const first = await f.enqueue(mirrorLanding(f, now, 2));
  const held = f.tables.projectGithubMirrorJobs.get(first.jobId);
  now += 10_000;
  await f.enqueue(mirrorLanding(f, now, 3));
  assert.deepEqual(f.delays, [50_000, 0], 'the earlier State can stage before the ref deadline');
  assert.equal(f.tables.projectGithubMirrors.get(mirror).hold.until, now + 40_000);
  assert.deepEqual(
    await f.run('prepareEarlierState', ctx =>
      cadence.beginMirrorBurst(
        ctx,
        f.tables.projectGithubMirrors.get(mirror),
        f.tables.projectGithubMirrorJobs.get(first.jobId),
        false,
      ),
    ),
    { ready: true, through: 3 },
  );
  now += 10_000;
  await f.enqueue(mirrorLanding(f, now, 4), { revert: true });
  assert.equal(f.tasks.get(held.scheduledId).state.kind, 'canceled');
  assert.deepEqual(f.delays, [50_000, 0, 0]);
  assert.equal(await f.run('staleMirrorWake', store.begin._handler, f.scheduled[0].args), null);
  const burst = await f.run('beginMirrorBurst', ctx =>
    cadence.beginMirrorBurst(
      ctx,
      f.tables.projectGithubMirrors.get(mirror),
      f.tables.projectGithubMirrorJobs.get(first.jobId),
      true,
    ),
  );
  assert.deepEqual(burst, { ready: true, through: 4 });
});

test('an Automatic mirror publishes a landing outside the window and flushes configured deploy paths', async t => {
  let now = Date.UTC(2026, 0, 2);
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  const mirror = timedMirror(f, 'automatic', now - 120_000, [60_000]);
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { ...project.autonomyPolicy.githubMirror, pushNowPaths: ['deploy/**'] },
    },
  });
  const first = await f.enqueue(mirrorLanding(f, now, 2), { paths: ['source/main.ts'] });
  assert.equal(f.delays[0], 0);
  const root = mirrorFixture().root;
  const job = f.tables.projectGithubMirrorJobs.get(first.jobId);
  await f.run('publishQuietLanding', store.commit._handler, {
    jobId: first.jobId,
    step: 0,
    cursor: null,
    mapping: JSON.stringify({ ...root, acceptanceId: job.receiptId, state: job.state }),
  });
  now += 10_000;
  await f.enqueue(mirrorLanding(f, now, 3), { paths: ['source/main.ts'] });
  assert.equal(f.delays[1], 50_000);
  await f.enqueue(mirrorLanding(f, now, 4), { paths: ['deploy/worker.ts'] });
  assert.equal(f.delays[2], 0);
  assert.equal(f.tables.projectGithubMirrors.get(mirror).hold.until, now);
});

test('Every landing keeps separate ref moves when a previous push completes after queued landings', async t => {
  let now = Date.UTC(2026, 0, 2);
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  const mirror = timedMirror(f, 'every-landing', now - 120_000, [180_000]);
  const first = await f.enqueue(mirrorLanding(f, now, 2));
  const second = await f.enqueue(mirrorLanding(f, now + 1000, 3));
  await f.enqueue(mirrorLanding(f, now + 2000, 4));
  now += 3000;
  const root = mirrorFixture().root;
  const job = f.tables.projectGithubMirrorJobs.get(first.jobId);
  await f.run('publishFirst', store.commit._handler, {
    jobId: first.jobId,
    step: 0,
    cursor: null,
    mapping: JSON.stringify({ ...root, acceptanceId: job.receiptId, state: job.state }),
  });
  assert.equal(f.tables.projectGithubMirrors.get(mirror).activeId, second.jobId);
  assert.equal(f.tables.projectGithubMirrors.get(mirror).hold, undefined);
  assert.deepEqual(f.delays, [0, 0]);
});

test('a replayed commit status keeps one pending post before audit success', async () => {
  const f = mirrorFixture();
  const sha = f.root.commit;
  const link = `https://forge.example/example/repo/code/${f.root.acceptanceId}`;
  await writeMirrorVerification(f.io.api, f.seed.repository, sha, 'pending', link, false);
  await writeMirrorVerification(f.io.api, f.seed.repository, sha, 'pending', link, true);
  await writeMirrorVerification(f.io.api, f.seed.repository, sha, 'success', link, false);
  assert.deepEqual(
    f.statuses.get(sha).map(({ state, target_url }) => [state, target_url]),
    [
      ['success', link],
      ['pending', link],
    ],
  );
});

test('known red holds the outbound ref to its cap while an inbound head runs', async t => {
  let now = Date.UTC(2026, 0, 2);
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  const mirror = timedMirror(f, 'every-landing', now - 10_000, []);
  f.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    red: { head: 'a'.repeat(64), since: new Date(now).toISOString(), runId: 'audit-red' },
  });
  const first = await f.enqueue(mirrorLanding(f, now, 2));
  const inboundQueue = await import(moduleUrl('../convex/projectGithubInboundQueue.ts'));
  const inbound = await f.run('inboundDuringHold', async ctx =>
    inboundQueue.ensureInbound(ctx, await ctx.db.get(f.projectId), await ctx.db.get(mirror)),
  );
  assert.deepEqual(f.delays, [900_000, 0]);
  assert.equal(f.tables.projectGithubMirrors.get(mirror).activeId, inbound);
  await f.run('finishInboundDuringHold', async ctx =>
    inboundQueue.finish(ctx, await ctx.db.get(inbound), await ctx.db.get(mirror), null, 'done'),
  );
  assert.equal(f.tables.projectGithubMirrors.get(mirror).activeId, first.jobId);
  assert.deepEqual(f.delays, [900_000, 0, 900_000], 'handoff preserves the original red deadline');
  now += 900_000;
  const burst = await f.run('beginMirrorBurst', ctx =>
    cadence.beginMirrorBurst(
      ctx,
      f.tables.projectGithubMirrors.get(mirror),
      f.tables.projectGithubMirrorJobs.get(first.jobId),
      true,
    ),
  );
  assert.deepEqual(burst, { ready: true, through: 2 });
  assert.equal(f.tables.projectGithubMirrors.get(mirror).hold, undefined);
});

test('a failed audit closes only the audited pending head and a later clean audit covers earlier pushes', async () => {
  const f = fixture();
  const git = mirrorFixture();
  timedMirror(f, 'every-landing', 180_000, []);
  const fields = {
    projectId: f.projectId,
    repository: 'synthetic/mirror',
    repositoryKey: 'synthetic/mirror',
    authorityEpoch: 1,
    status: 'done',
    cursor: null,
    step: 3,
    state: git.root.state,
  };
  const older = f.insert('projectGithubMirrorJobs', {
    ...fields,
    receiptId: git.root.acceptanceId,
    sequence: 2,
    verify: 'pending',
    mapping: JSON.stringify(git.root),
    verifyLink: 'https://forge.example/example/repo/code/older',
  });
  const latest = f.insert('projectGithubMirrorJobs', {
    ...fields,
    receiptId: randomUUID(),
    sequence: 3,
    verify: 'pending',
    mapping: JSON.stringify({ ...git.root, commit: '7'.repeat(40) }),
    verifyLink: 'https://forge.example/example/repo/code/latest',
  });
  const audit = f.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    red: { head: git.root.state, since: '2026-01-02T00:00:00.000Z', runId: 'audit-red' },
  });
  await f.run('auditRedMirror', ctx =>
    mirrorVerify.noteMirrorCheck(ctx, {
      id: 'audit-red',
      projectId: f.projectId,
      status: 'failed',
      gate: { mode: 'audit', reason: auditReason({ sequence: 3, count: 2, attempt: 0, key: 'synthetic' }) },
    }),
  );
  assert.equal(f.tables.projectGithubMirrorJobs.get(older).verify, 'pending');
  assert.equal(f.tables.projectGithubMirrorJobs.get(latest).verify, 'failure');
  assert.deepEqual(f.scheduled[0].args.ids, [latest]);
  const selection = await f.run('selectStatus', mirrorVerify.select._handler, {
    projectId: f.projectId,
    repository: 'SYNTHETIC/Mirror',
    ids: [latest],
  });
  assert.deepEqual(selection, [
    {
      jobId: latest,
      sha: '7'.repeat(40),
      state: 'failure',
      link: 'https://forge.example/example/repo/code/latest',
    },
  ]);
  f.patch('projectHostedMainAudits', audit, {
    red: undefined,
    lastGreen: { runId: 'audit-green', sequence: 4, head: git.head },
  });
  await f.run('auditGreenMirror', ctx =>
    mirrorVerify.noteMirrorCheck(ctx, {
      id: 'audit-green',
      projectId: f.projectId,
      status: 'passed',
      gate: { mode: 'audit' },
    }),
  );
  assert.equal(f.tables.projectGithubMirrorJobs.get(older).verify, 'success');
  assert.equal(f.tables.projectGithubMirrorJobs.get(latest).verify, 'failure');
  assert.deepEqual(
    f.scheduled.map(row => row.args.ids),
    [[latest], [older]],
  );
});

test('coverage changes wait for an audit and a later exact full landing settles older pending heads', async () => {
  const f = fixture();
  const git = mirrorFixture();
  const now = Date.UTC(2026, 0, 2);
  const mirror = timedMirror(f, 'every-landing', now - 600_000, []);
  const receipt = mirrorLanding(f, now, 2);
  const run = { status: 'passed', request: { expectedHead: receipt.candidate.head }, gate: { mode: 'full' } };
  const coverage = await f.enqueue(receipt, { run, coverage: true });
  assert.equal(f.tables.projectGithubMirrorJobs.get(coverage.jobId).exactCheck, undefined);
  f.patch('projectGithubMirrorJobs', coverage.jobId, {
    status: 'done',
    verify: 'pending',
    verifySent: 'pending',
    mapping: JSON.stringify(git.root),
  });
  f.patch('projectGithubMirrors', mirror, { pendingVerify: 1, activeId: null });
  const full = mirrorLanding(f, now, 3);
  f.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    lastGreen: { head: full.candidate.head, sequence: 3, runId: 'full-run' },
  });
  const accepted = await f.enqueue(full, { run });
  const prior = f.tables.projectGithubMirrorJobs.get(coverage.jobId);
  assert.equal(prior.verify, 'success');
  assert.equal(prior.verifySent, 'pending');
  assert.equal(f.tables.projectGithubMirrorJobs.get(accepted.jobId).exactCheck, true);
  assert.equal(f.tables.projectGithubMirrors.get(mirror).pendingVerify, 0);
});
test('idle schedules zero; acceptance wakes once; retries and queued landings serialize', async () => {
  const f = fixture();
  assert.equal(f.scheduled.length, 0);
  const first = f.receipt();
  await f.enqueue(first);
  await f.enqueue(first);
  const second = f.receipt();
  await f.enqueue(second);
  assert.equal(f.scheduled.length, 1);
  const original = f.scheduled[0].args;
  const entry = { ...mirrorFixture().root, acceptanceId: first.id, state: first.candidate.head };
  await f.run('commitMirror', store.commit._handler, {
    ...original,
    cursor: null,
    mapping: JSON.stringify(entry),
  });
  assert.equal(f.scheduled.length, 2, 'exactly one next job');
  await f.run('replayCommit', store.commit._handler, {
    ...original,
    cursor: null,
    mapping: JSON.stringify(entry),
  });
  assert.equal(f.scheduled.length, 2);
  const next = f.scheduled[1].args;
  await f.run('commitMirror', store.commit._handler, {
    ...next,
    cursor: null,
    mapping: JSON.stringify({ ...entry, acceptanceId: second.id }),
  });
  assert.equal(f.scheduled.length, 2, 'drained queue has no idle wake');
  assert.equal([...f.tables.projectGithubMirrors.values()][0].activeId, null);
});
test('policy disabled, native authority and changed repository never block main or schedule work', async () => {
  const f = fixture();
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'native-owner', epoch: 1 } });
  await f.enqueue(f.receipt());
  f.patch('hostedProjects', f.projectId, {
    sourceAuthority: project.sourceAuthority,
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { repo: 'synthetic/mirror', autoPush: false, laneRefs: false },
    },
  });
  await f.enqueue(f.receipt());
  assert.equal(f.scheduled.length, 0);
  f.patch('hostedProjects', f.projectId, project);
  await f.enqueue(f.receipt());
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { repo: 'synthetic/other', autoPush: true, laneRefs: false },
    },
  });
  await f.enqueue(f.receipt());
  assert.equal(f.scheduled.length, 1);
  assert([...f.tables.projectGithubMirrorJobs.values()].some(j => j.error === 'GITHUB_SYNC_BINDING'));
});
test('continuations fence stale actions and failure recovery resumes the same step', async () => {
  const f = fixture();
  await f.enqueue(f.receipt());
  const input = f.scheduled[0].args;
  await f.run('advanceMirror', store.commit._handler, { ...input, cursor: 'cursor-1', mapping: null });
  assert.equal(f.scheduled.length, 2);
  await f.run('oldFailure', store.failed._handler, {
    ...input,
    code: 'GITHUB_SYNC_FAILED',
    detail: 'old failure',
  });
  const active = f.scheduled[1].args;
  await f.run('mirrorFailed', store.failed._handler, {
    ...active,
    code: 'GITHUB_SYNC_CHANGED',
    detail: 'GitHub main moved',
  });
  assert.equal(f.scheduled.length, 2, 'failure never installs a poller');
  await f.run('mirrorResume', store.resume._handler, { jobId: active.jobId });
  assert.deepEqual(f.scheduled[2].args, { ...active, step: active.step + 2 });
});
test('source resolution batches 100 descriptors with bounded document reads, fails closed on changed authority', async t => {
  const f = fixture();
  await f.enqueue(f.receipt());
  const input = f.scheduled[0].args,
    digests = [];
  for (let i = 0; i < 100; i++) {
    const digest = i.toString(16).padStart(64, '0');
    digests.push(digest);
    f.insert('projectObjects', {
      projectId: f.projectId,
      digest,
      size: 4,
      nonce: 'synthetic',
      storageId: `storage-${i}`,
      removed: false,
    });
  }
  const result = JSON.parse(
    await f.run(
      'resolveMirror',
      (ctx, input) => {
        delete ctx.db.patch;
        return objects.resolve._handler(ctx, input);
      },
      { ...input, digests },
    ),
  );
  assert.equal(result.length, 100);
  const counts = f.counts.at(-1);
  assert(counts.documents <= 105, 'one function call per 100 source objects');
  assert.equal(counts.writes, 0);
  assert(!counts.touched.includes('projectWorkRecords'));
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'native-owner', epoch: 2 } });
  await assert.rejects(
    f.run(
      'resolveMirror',
      (ctx, input) => {
        delete ctx.db.patch;
        return objects.resolve._handler(ctx, input);
      },
      { ...input, digests },
    ),
    e => e.code === 'SOURCE_AUTHORITY_CHANGED',
  );
  t.diagnostic(
    JSON.stringify({
      descriptors: 100,
      calls: 1,
      documents: counts.documents,
      writes: counts.writes,
      readBytes: counts.readBytes,
    }),
  );
});
test('real hosted main publication queues exactly one mirror even when completion is disabled', async () => {
  const f = await acceptanceFixture();
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...effectivePolicy(project),
      githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false },
    },
  });
  const { state } = await f.ready();
  const result = await f.accept(state);
  assert.equal(result.status, 'landed');
  await f.accept(state);
  const mirrors = [...f.tables._scheduled_functions.values()].filter(
    t => t.name === 'projectGithubMirror:step',
  );
  assert.equal(mirrors.length, 1);
  assert.equal([...f.tables.projectGithubMirrorJobs.values()][0].state, result.receipt.candidate.head);
});
test('source action verifies raw hashes and reconstructs recipes using project-bound descriptors', async () => {
  const { digest } = await import('../dist/hash.js');
  const { buildObjectRecipe } = await import('../dist/object-chunks.js');
  const data = Buffer.alloc(3 * 1024 * 1024, 77),
    built = buildObjectRecipe(data);
  const raw = new Map(built.objects);
  raw.set(digest(built.bytes), built.bytes);
  const logical = { sha256: digest(data), size: data.length };
  const calls = [];
  const reader = action.mirrorSource(
    {
      runQuery: async (_ref, input) => {
        calls.push(input.digests.length);
        return JSON.stringify(
          input.digests.map(id => ({
            descriptor:
              id === logical.sha256
                ? { object: logical, recipe: { sha256: digest(built.bytes), size: built.bytes.length } }
                : { object: { sha256: id, size: raw.get(id).length }, recipe: null },
            storageId: id,
            url: null,
          })),
        );
      },
      storage: { get: async id => new Blob([raw.get(id)]) },
    },
    { jobId: 'synthetic', step: 0 },
  );
  const [blob] = await reader.blobs([logical.sha256]);
  assert.deepEqual(await blob.read(), data);
  assert(calls.every(n => n <= 100));
  raw.set(digest(built.bytes), Buffer.from('wrong bytes'));
  const [bad] = await reader.blobs([logical.sha256]);
  await assert.rejects(bad.read(), e => e.code === 'SOURCE_HASH_MISMATCH');
});

for (const { files, gitlinks = false } of [
  { files: 0 },
  { files: 2 },
  { files: 5000 },
  { files: 5000, gitlinks: true },
])
  test(`real Convex action mirrors ${files} changed ${gitlinks ? 'gitlinks' : 'files'} with bounded calls`, async t => {
    const f = await acceptanceFixture();
    bindRepository(t, f.projectId, 'synthetic/mirror');
    const project = f.tables.hostedProjects.get(f.projectId);
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...effectivePolicy(project),
        githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false },
      },
    });
    const supplied = files
      ? 'Keep the supplied subject\n\nKeep the body.\n\nReviewed-by: Synthetic Reviewer <review@example.invalid>\nCo-Authored-By: Synthetic Sol <noreply@openai.com>'
      : undefined;
    const { state, item } = await f.ready(null, supplied === undefined ? {} : { message: supplied });
    const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
    await f.runAcceptance('mirrorSeedIntent', records.writeHostedRecord, {
      ...f.auth,
      expectedVersion: null,
      record: {
        kind: 'intent',
        id: item.candidate.intentId,
        version: 0,
        at: '2026-01-01T00:00:00.000Z',
        outcome: 'An accepted outcome',
        constraints: '',
        creatorAccountId: 'owner',
        assigneeAccountIds: [],
        base: { head: f.main.head, receiptId: f.main.receipt.id },
        status: 'active',
      },
    });
    const accepted = await f.accept(state);
    assert.equal(accepted.receipt.message, supplied);
    const input = [...f.tables._scheduled_functions.values()].find(t => t.name === 'projectGithubMirror:step')
      .args[0];
    const before = {},
      after = {};
    for (let i = 0; i < files; i++) {
      before[`file-${i}`] = gitlinks
        ? { mode: 'gitlink', text: i.toString(16).padStart(40, '0') }
        : `old ${i}`;
      after[`file-${i}`] = gitlinks
        ? { mode: 'gitlink', text: (i + files).toString(16).padStart(40, '0') }
        : `new ${i}`;
    }
    const github = mirrorFixture({ before, after });
    const receiptRow = [...f.tables.projectHostedAcceptances.values()][0];
    f.patch('projectHostedAcceptances', receiptRow._id, {
      value: JSON.stringify({
        ...accepted.receipt,
        previous: { ...accepted.receipt.previous, head: github.seed.previous },
        candidate: { ...accepted.receipt.candidate, head: github.head },
      }),
    });
    f.patch('projectGithubMirrorJobs', input.jobId, {
      state: github.head,
      ...(files === 2 ? { exactCheck: true } : {}),
    });
    const queueRow = [...f.tables.projectGithubMirrors.values()][0];
    f.patch('projectGithubMirrors', queueRow._id, { mapping: JSON.stringify(github.root) });
    const storage = new Map();
    for (const [id, value] of github.states) storage.set(id, new Blob([JSON.stringify(value)]));
    for (const [id, value] of github.objects) storage.set(id, new Blob([value]));
    for (const [id, blob] of storage)
      f.insert('projectObjects', {
        projectId: f.projectId,
        digest: id,
        size: blob.size,
        removed: false,
        nonce: 'synthetic',
        storageId: id,
      });
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const names = [
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'FORGE_GITHUB_SYNC_NAME',
      'FORGE_GITHUB_SYNC_EMAIL',
    ];
    const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
    Object.assign(process.env, {
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      FORGE_GITHUB_SYNC_NAME: 'Forge Sync',
      FORGE_GITHUB_SYNC_EMAIL: files === 0 ? 'noreply@forge.example' : '123+fixture@users.noreply.github.com',
    });
    const previousFetch = globalThis.fetch,
      calls = [],
      authCalls = [];
    globalThis.fetch = async (url, init) => {
      if (new URL(url).hostname.endsWith('.r2.cloudflarestorage.com')) return previousFetch(url, init);
      if (url.endsWith('/installation')) {
        authCalls.push(url);
        return new Response(
          JSON.stringify({
            id: 42,
            ...(files === 2 ? { permissions: { statuses: 'write' } } : {}),
          }),
        );
      }
      if (url.includes('/access_tokens')) {
        assert.deepEqual(JSON.parse(init.body).permissions, {
          contents: 'write',
          ...(files === 2 ? { statuses: 'write' } : {}),
        });
        authCalls.push(url);
        return new Response(JSON.stringify({ token: 'synthetic-token' }));
      }
      return new Response(
        JSON.stringify(
          await github.io.api(new URL(url).pathname, init.method, init.body && JSON.parse(init.body)),
        ),
      );
    };
    t.after(() => {
      globalThis.fetch = previousFetch;
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    });
    const modules = { begin: store.begin, commit: store.commit, failed: store.failed };
    const ctx = {
      runMutation: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push(name);
        const result = await f.transaction('mirrorMutation', modules[name.split(':')[1]], args);
        if (files === 2 && name.endsWith(':begin') && calls.length === 1) {
          process.env.FORGE_GITHUB_SYNC_NAME = 'Changed after lost begin reply';
          calls.push(`${name} (lost reply retry)`);
          const replay = await f.transaction('mirrorMutation', store.begin, args);
          assert.equal(
            result,
            replay,
            'the original commit identity and message are durable before API writes',
          );
        }
        return result;
      },
      runQuery: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push(name);
        return f.transaction(
          'mirrorQuery',
          {
            _handler: (ctx, input) => {
              delete ctx.db.patch;
              return objects.resolve._handler(ctx, input);
            },
          },
          args,
        );
      },
      storage: {
        get: async id => storage.get(id),
        store: async blob => {
          const id = `cursor-${storage.size}`;
          storage.set(id, blob);
          return id;
        },
      },
    };
    const start = performance.now();
    await action.step._handler(ctx, input);
    let job = f.tables.projectGithubMirrorJobs.get(input.jobId);
    while (job.status === 'running') {
      await action.step._handler(ctx, { jobId: job._id, step: job.step });
      job = f.tables.projectGithubMirrorJobs.get(input.jobId);
    }
    assert.equal(job.status, 'done', job.detail);
    assert.equal(JSON.parse(job.mapping).state, github.head);
    assert.equal(JSON.parse(job.mapping).committer.name, 'Forge Sync');
    if (files === 0) assert.equal(JSON.parse(job.mapping).committer.email, 'noreply@forge.example');
    assert.equal(JSON.parse(job.mapping).message, JSON.parse(job.seed).message);
    assert.equal(
      JSON.parse(job.seed).message,
      // A supplied message ends in its trailers: Forge's join them as one block (Item 3968a655).
      `${supplied ?? 'An accepted outcome'}${supplied ? '\n' : '\n\n'}Forge-State: ${github.head}\nForge-Acceptance: ${accepted.receipt.id}\nForge-View: ${accepted.receipt.candidate.id}`,
    );
    if (files) assert.equal(github.commits.get(github.remote()).message, JSON.parse(job.seed).message);
    const steps = Math.max(1, Math.ceil(files / 100));
    assert.equal(calls.length, 2 * steps + 1 + (files ? steps : 0) + (files === 2 ? 1 : 0));
    assert.equal(authCalls.length, 2 * steps);
    assert.equal(JSON.parse(job.mapping).tree, github.expected());
    const metrics = f.counts.filter(c => c.name.startsWith('mirrorMutation') || c.name === 'mirrorQuery');
    assert(metrics.every(c => c.documents <= 105 && c.writes <= 3));
    assert(!metrics.some(c => c.touched.includes('projectWorkRecords')));
    assert.equal(github.calls.length, files ? (gitlinks ? 4 : files + 4 + Number(files === 2)) : 1);
    if (files === 2) {
      const [status] = github.statuses.get(github.remote());
      assert.equal(status.context, 'forge/verify');
      assert.equal(status.state, 'success');
      assert.equal(job.verify, 'success');
    } else if (files) {
      assert.equal(f.tables.projectGithubMirrors.get(queueRow._id).verifyError, 'GITHUB_APP_PERMISSIONS');
      assert.equal(github.statuses.size, 0);
    }
    const completedCalls = calls.length;
    await action.step._handler(ctx, input);
    assert.equal(github.commits.size, files ? 2 : 1, 'replay creates no second commit');
    assert.equal(calls.length, completedCalls + 1);
    t.diagnostic(
      JSON.stringify({
        files,
        gitlinks,
        convexCalls: completedCalls,
        documents: metrics.reduce((n, c) => n + c.documents, 0),
        writes: metrics.reduce((n, c) => n + c.writes, 0),
        steps,
        authCalls: authCalls.length,
        gitDataCalls: github.calls.length,
        elapsedMs: performance.now() - start,
        rssBytes: process.memoryUsage().rss,
      }),
    );
  });

/** Incident d4eb053e: a project that landed before its mirror was turned on has no mapping, so the
 * first job needs the GitHub commit and Forge State the project was imported from. */
for (const mapped of [false, true])
  test(`the first mirror job's seed ${mapped ? 'ignores' : 'carries'} the import commit and State when a mapping ${mapped ? 'exists' : 'is missing'}`, async t => {
    const f = await acceptanceFixture();
    bindRepository(t, f.projectId, 'synthetic/mirror');
    const project = f.tables.hostedProjects.get(f.projectId);
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...effectivePolicy(project),
        githubMirror: { repo: 'synthetic/mirror', autoPush: true, laneRefs: false },
      },
    });
    const { state, item } = await f.ready();
    const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
    await f.runAcceptance('mirrorSeedIntent', records.writeHostedRecord, {
      ...f.auth,
      expectedVersion: null,
      record: {
        kind: 'intent',
        id: item.candidate.intentId,
        version: 0,
        at: '2026-01-01T00:00:00.000Z',
        outcome: 'An accepted outcome',
        constraints: '',
        creatorAccountId: 'owner',
        assigneeAccountIds: [],
        base: { head: f.main.head, receiptId: f.main.receipt.id },
        status: 'active',
      },
    });
    await f.accept(state);
    const input = [...f.tables._scheduled_functions.values()].find(t => t.name === 'projectGithubMirror:step')
      .args[0];
    const imported = { commit: 'c'.repeat(40), head: 'd'.repeat(64) };
    f.insert('projectGithubImports', {
      projectId: f.projectId,
      visibility: 'private',
      owner: 'owner',
      operationId: randomUUID(),
      request: 'synthetic',
      repository: 'synthetic/mirror',
      commit: imported.commit,
      at: '2026-01-01T00:00:00.000Z',
      step: 0,
      cursor: '',
      phase: 'ready',
      totalKnown: true,
      completed: 0,
      total: 0,
      bytes: 0,
      totalBytes: 0,
      publication: {
        backupId: 'projectBackups-1',
        generationId: 'projectWorkGenerations-1',
        head: imported.head,
        root: 'e'.repeat(64),
      },
    });
    if (mapped) {
      const queueRow = [...f.tables.projectGithubMirrors.values()][0];
      f.patch('projectGithubMirrors', queueRow._id, { mapping: JSON.stringify(mirrorFixture().root) });
    }
    const prior = [process.env.FORGE_GITHUB_SYNC_NAME, process.env.FORGE_GITHUB_SYNC_EMAIL];
    Object.assign(process.env, {
      FORGE_GITHUB_SYNC_NAME: 'Forge Sync',
      FORGE_GITHUB_SYNC_EMAIL: '123+fixture@users.noreply.github.com',
    });
    t.after(() => {
      for (const [name, value] of [
        ['FORGE_GITHUB_SYNC_NAME', prior[0]],
        ['FORGE_GITHUB_SYNC_EMAIL', prior[1]],
      ])
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    });
    const seed = JSON.parse(await f.transaction('mirrorBegin', store.begin, input)).seed;
    assert.deepEqual(seed.import, mapped ? undefined : { commit: imported.commit, state: imported.head });
  });

const inboundModule = await import(moduleUrl('../convex/projectGithubInboundQueue.ts'));
/** Two-way sync on the same synthetic project, with one published mirror commit recorded. */
async function twoWayFixture(inbound = true) {
  const f = fixture();
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { repo: 'Synthetic/Mirror', autoPush: true, laneRefs: false, inbound },
    },
  });
  const first = f.receipt();
  await f.enqueue(first);
  const entry = { ...mirrorFixture().root, acceptanceId: first.id, state: first.candidate.head };
  await f.run('commitMirror', store.commit._handler, {
    ...f.scheduled[0].args,
    cursor: null,
    mapping: JSON.stringify(entry),
  });
  const receive = after =>
    f.run('inboundReceive', inboundModule.receive._handler, {
      repository: 'synthetic/mirror',
      ref: 'refs/heads/main',
      after,
    });
  const queueRow = () => [...f.tables.projectGithubMirrors.values()][0];
  const jobs = () => [...f.tables.projectGithubMirrorJobs.values()];
  return { ...f, entry, first, receive, queueRow, jobs };
}
test('two-way: a GitHub push queues one inbound job; Forge pushes and one-way mirrors write nothing', async () => {
  const f = await twoWayFixture();
  assert.equal(f.queueRow().repositoryKey, 'synthetic/mirror');
  const scheduled = f.scheduled.length;
  await f.receive(f.entry.commit);
  const own = f.counts.at(-1);
  assert.equal(own.writes, 0, 'Forge’s own push writes nothing');
  assert(own.documents <= 2, `own push reads ${own.documents}`);
  await f.run('inboundReceive', inboundModule.receive._handler, {
    repository: 'synthetic/mirror',
    ref: 'refs/heads/other',
    after: 'b'.repeat(40),
  });
  assert.equal(f.scheduled.length, scheduled);
  await f.receive('b'.repeat(40));
  await f.receive('c'.repeat(40));
  const inbound = f.jobs().filter(job => job.inbound);
  assert.equal(inbound.length, 1, 'pushes coalesce while the job waits');
  assert.equal(inbound[0].sequence, 0);
  assert.equal(f.queueRow().activeId, inbound[0]._id);
  assert.equal(f.scheduled.length, scheduled + 1, 'one wake, no poller');
  assert.equal(f.scheduled.at(-1).name, 'projectGithubMirror:step');
  const oneWay = await twoWayFixture(false);
  const before = oneWay.scheduled.length;
  await oneWay.receive('b'.repeat(40));
  assert.equal(oneWay.counts.at(-1).writes, 0);
  assert.equal(oneWay.scheduled.length, before);
});
test('two-way: a publish that finds GitHub main moved yields to an inbound job instead of failing', async () => {
  const f = await twoWayFixture();
  const second = f.receipt();
  await f.enqueue(second);
  const publish = f.scheduled.at(-1).args;
  await f.run('mirrorFailed', store.failed._handler, {
    ...publish,
    code: 'GITHUB_SYNC_CHANGED',
    detail: 'GitHub main moved unexpectedly.',
  });
  const job = f.tables.projectGithubMirrorJobs.get(publish.jobId);
  assert.equal(job.status, 'queued');
  assert.equal(job.error, undefined);
  assert.equal(job.seed, undefined, 'it re-seeds from the mapping the inbound job records');
  const inbound = f.jobs().find(row => row.inbound);
  assert.equal(f.queueRow().activeId, inbound._id);
  assert.deepEqual(f.scheduled.at(-1).args, { jobId: inbound._id, step: 0 });
});
test('two-way: the inbound landing settles with the acceptance that landed it', async () => {
  for (const phase of ['landed', 'terminal-failed']) {
    const f = await twoWayFixture();
    // A Forge landing accepted while the inbound one was in flight waits behind it.
    await f.receive('b'.repeat(40));
    const job = f.jobs().find(row => row.inbound);
    const waiting = f.receipt();
    await f.enqueue(waiting);
    const older = f.jobs().find(row => row.receiptId === waiting.id);
    assert.equal(older.status, 'queued');
    const submissionId = randomUUID(),
      laneId = randomUUID();
    f.patch('projectGithubMirrorJobs', job._id, {
      status: 'running',
      inbound: JSON.stringify({
        phase: 'landing',
        commit: 'b'.repeat(40),
        tree: 'd'.repeat(40),
        message: 'Merge pull request #1',
        equivalent: 'e'.repeat(64),
        base: { head: f.first.candidate.head, receiptId: f.first.id },
        laneId,
        landingOperationId: randomUUID(),
        submissionId,
      }),
    });
    const landing = 'landing-row';
    // Pending: an acceptance changes nothing but queues its publish.
    f.tables.projectHostedLandingRequests.set(landing, {
      _id: landing,
      _creationTime: 1,
      projectId: f.projectId,
      submissionId,
      phase: 'checking',
      value: JSON.stringify({ phase: 'checking', error: null }),
    });
    const pendingReceipt = f.receipt();
    await f.enqueue(pendingReceipt);
    assert.equal(f.queueRow().activeId, job._id, 'the inbound job holds the queue while it lands');
    f.tables.projectHostedLandingRequests.set(landing, {
      ...f.tables.projectHostedLandingRequests.get(landing),
      phase,
      value: JSON.stringify({
        phase,
        error: phase === 'landed' ? null : { code: 'CHECK_NOT_PASSED', message: 'A test failed.' },
      }),
    });
    const base = f.receipt();
    const settled = {
      ...base,
      candidate: { ...base.candidate, id: randomUUID() },
      snapshot: { revision: 100 },
    };
    await f.enqueue(settled);
    const done = f.tables.projectGithubMirrorJobs.get(job._id);
    const mapping = JSON.parse(f.queueRow().mapping);
    assert.equal(mapping.commit, 'b'.repeat(40));
    assert.equal(mapping.tree, 'd'.repeat(40));
    assert.equal(mapping.state, 'e'.repeat(64), 'GitHub’s commit stands for its own tree');
    assert.equal(mapping.parent, f.entry.commit);
    const outcome = JSON.parse(f.queueRow().inbound);
    if (phase === 'landed') {
      assert.equal(done.status, 'done');
      assert.equal(mapping.acceptanceId, settled.id);
      for (const id of [waiting.id, pendingReceipt.id])
        assert.equal(
          f.jobs().find(row => row.receiptId === id).status,
          'done',
          'older publishes are contained',
        );
      const next = f.jobs().find(row => row.receiptId === settled.id);
      assert.equal(f.queueRow().activeId, next._id);
      assert.equal(outcome.note, undefined);
    } else {
      assert.equal(done.status, 'failed');
      assert.equal(done.error, 'GITHUB_INBOUND_FAILED');
      assert.match(done.detail, /did not land on Forge/);
      assert.equal(mapping.acceptanceId, f.first.id, 'the next inbound Lane starts from accepted main');
      const older2 = f.jobs().find(row => row.receiptId === waiting.id);
      assert.equal(f.queueRow().activeId, older2._id, 'older publishes run first, in order');
      assert.equal(f.jobs().find(row => row.receiptId === settled.id).status, 'queued');
      assert.equal(outcome.note, true);
      assert.equal(outcome.error, 'CHECK_NOT_PASSED: A test failed.');
    }
  }
});
const pullQueue = await import(moduleUrl('../convex/projectGithubPullQueue.ts'));
const prHead = (f, head, number = 7) =>
  f.run('pullReceive', pullQueue.receive._handler, {
    repository: 'Synthetic/Mirror',
    number,
    head,
    fork: true,
  });
const pullJobs = (f, number) => f.jobs().filter(job => job.pullKey === String(number));
const pullOf = job => JSON.parse(job.inbound).pull;
test('two-way PR: a head queues one check job; redelivery writes nothing; a newer head drops an unstarted one', async () => {
  const f = await twoWayFixture();
  const scheduled = f.scheduled.length;
  await prHead(f, 'b'.repeat(40));
  const [first] = pullJobs(f, 7);
  assert.equal(first.sequence, 0.5, 'after an inbound push job (0), before publishes');
  assert.deepEqual(JSON.parse(first.inbound), {
    phase: 'pending',
    pull: { number: 7, head: 'b'.repeat(40), fork: true },
  });
  assert.equal(f.queueRow().activeId, first._id);
  assert.equal(f.scheduled.length, scheduled + 1, 'one wake, no poller');
  assert.equal(f.scheduled.at(-1).name, 'projectGithubMirror:step');
  await prHead(f, 'b'.repeat(40));
  assert.equal(f.counts.at(-1).writes, 0, 'a redelivered head writes nothing');
  assert(f.counts.at(-1).documents <= 4, `redelivery reads ${f.counts.at(-1).documents}`);
  await prHead(f, 'd'.repeat(40), 8);
  const [waiting] = pullJobs(f, 8);
  assert.equal(waiting.status, 'queued');
  await prHead(f, 'e'.repeat(40), 8);
  const dropped = f.tables.projectGithubMirrorJobs.get(waiting._id);
  assert.equal(dropped.status, 'done');
  assert.equal(pullOf(dropped).outcome, 'superseded');
  assert.equal(pullJobs(f, 8).length, 2);
  assert.equal(f.scheduled.length, scheduled + 1, 'a dropped head posted nothing and woke nothing');
  // A GitHub push still gets its own inbound job; a queued PR job is not one to coalesce into.
  await f.receive('f'.repeat(40));
  const push = f.jobs().filter(job => job.inbound && !job.pullKey);
  assert.equal(push.length, 1);
  assert.equal(push[0].sequence, 0);
  const oneWay = await twoWayFixture(false);
  const before = oneWay.scheduled.length;
  await prHead(oneWay, 'b'.repeat(40));
  assert.equal(oneWay.counts.at(-1).writes, 0);
  assert.equal(oneWay.scheduled.length, before);
});
const policies = await import(moduleUrl('../convex/projectAutonomy.ts'));
test('friction 77518c88: a freshly connected two-way project checks its first PR, fork or same-repo, with no landing first', async t => {
  for (const fork of [true, false]) {
    const f = fixture();
    f.jobs = () => [...f.tables.projectGithubMirrorJobs.values()];
    const project = f.tables.hostedProjects.get(f.projectId);
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: { ...project.autonomyPolicy, githubMirror: undefined },
    });
    bindRepository(t, f.projectId, 'Synthetic/Mirror');
    const rows = () => [...f.tables.projectGithubMirrors.values()];
    const connect = (githubMirror, operationId = randomUUID()) =>
      f.transaction('connect', policies.set, {
        projectId: f.projectId,
        command: JSON.stringify({ action: 'set-policy', operationId, githubMirror }),
      });
    // Before connecting, a PR for the repository writes nothing.
    await f.run('pullReceive', pullQueue.receive._handler, {
      repository: 'Synthetic/Mirror',
      number: 3,
      head: 'a'.repeat(40),
      fork,
    });
    assert.equal(f.jobs().length, 0);
    await connect({ repo: 'Synthetic/Mirror', autoPush: true, laneRefs: false, inbound: true });
    assert.equal(rows().length, 1, 'connect creates the queue row; no accepted landing exists');
    assert.equal(rows()[0].repositoryKey, 'synthetic/mirror');
    assert.equal(rows()[0].mapping, null);
    assert.equal(f.tables.projectGithubMirrorJobs.size, 0, 'connect starts no job and wakes nothing');
    assert.equal(f.scheduled.length, 0);
    // The first PR head is queued and its check job woken, exactly as after a landing.
    await f.run('pullReceive', pullQueue.receive._handler, {
      repository: 'Synthetic/Mirror',
      number: 7,
      head: 'b'.repeat(40),
      fork,
    });
    const [job] = pullJobs(f, 7);
    assert.equal(job.status, 'queued');
    assert.deepEqual(JSON.parse(job.inbound).pull, { number: 7, head: 'b'.repeat(40), fork });
    assert.equal(rows()[0].activeId, job._id);
    assert.deepEqual(
      f.scheduled.map(row => row.name),
      ['projectGithubMirror:step'],
    );
    // A repeat connect or an unrelated policy edit adds no row and reads no queue.
    await connect({ repo: 'Synthetic/Mirror', autoPush: true, laneRefs: false, inbound: true });
    assert.equal(rows().length, 1);
    await f.transaction('edit', policies.set, {
      projectId: f.projectId,
      command: JSON.stringify({
        action: 'set-policy',
        operationId: randomUUID(),
        acceptance: { mode: 'auto-on-pass' },
      }),
    });
    assert(!f.counts.at(-1).touched.includes('projectGithubMirrors'), 'other edits never read the queue');
  }
});
test('two-way PR: a terminal job failure releases the queue and settles forge/verify as error', async () => {
  const f = await twoWayFixture();
  await prHead(f, 'b'.repeat(40));
  const receipt = f.receipt();
  await f.enqueue(receipt);
  const [job] = pullJobs(f, 7);
  await f.run('mirrorFailed', store.failed._handler, {
    jobId: job._id,
    step: job.step,
    code: 'GITHUB_PULL_BEHIND',
    detail: 'The PR and GitHub main both changed src/a.ts; update the branch from main.',
  });
  const failed = f.tables.projectGithubMirrorJobs.get(job._id);
  assert.equal(failed.status, 'failed');
  assert.equal(pullOf(failed).outcome, 'error');
  const next = f.jobs().find(row => row.receiptId === receipt.id);
  assert.equal(f.queueRow().activeId, next._id, 'publishes never wait behind a failed PR check');
  const post = f.scheduled.find(row => row.name === 'projectGithubPullStatus:post');
  assert.equal(post.args.state, 'error');
  assert.equal(post.args.sha, 'b'.repeat(40));
  assert.match(post.args.description, /^GITHUB_PULL_BEHIND: /);
  assert(post.args.description.length <= 140);
});
test('two-way PR: the check run settles forge/verify once; a newer head supersedes a checking one', async () => {
  const f = await twoWayFixture();
  await prHead(f, 'b'.repeat(40));
  const [job] = pullJobs(f, 7);
  const { pullOperationId } = await import('../dist/github-pull-check.js');
  const runId = randomUUID(),
    composeOperationId = pullOperationId(),
    checkOperationId = pullOperationId(),
    laneId = randomUUID();
  const run = (id, operationId = checkOperationId) => ({
    projectId: f.projectId,
    id,
    status: 'passed',
    request: { operationId },
  });
  const checking = waitKey =>
    f.patch('projectGithubMirrorJobs', job._id, {
      status: 'done',
      waitKey,
      inbound: JSON.stringify({
        phase: 'checking',
        pull: { number: 7, head: 'b'.repeat(40), fork: true, ...(waitKey === runId ? { runId } : {}) },
        laneId,
        composeOperationId,
      }),
    });
  checking(composeOperationId);
  await f.run('composeDone', ctx => pullQueue.notifyPullCompose(ctx, f.projectId, composeOperationId));
  assert.deepEqual(f.scheduled.at(-1), {
    name: 'projectGithubPull:start',
    args: { jobId: job._id, key: composeOperationId },
  });
  checking(runId);
  // Every other run (version 4 operation id) skips the lookup: zero reads.
  await f.run('otherRun', ctx => pullQueue.notifyPullCheck(ctx, run(runId, randomUUID())));
  assert.equal(f.counts.at(-1).documents, 0, 'a non-PR run reads nothing');
  await f.run('otherCompose', ctx => pullQueue.notifyPullCompose(ctx, f.projectId, randomUUID()));
  assert.equal(f.counts.at(-1).documents, 0, 'a non-PR composition reads nothing');
  await f.run('otherPullRun', ctx => pullQueue.notifyPullCheck(ctx, run(randomUUID())));
  assert.equal(f.counts.at(-1).writes, 0, 'an unknown PR run reads one empty index range');
  await f.run('runDone', ctx => pullQueue.notifyPullCheck(ctx, run(runId)));
  const settle = f.scheduled.at(-1);
  assert.equal(settle.name, 'projectGithubPullQueue:settle');
  assert.deepEqual(settle.args, {
    jobId: job._id,
    outcome: 'success',
    description: 'Forge check passed.',
    runId,
  });
  await f.run('settle', pullQueue.settle._handler, settle.args);
  const posts = () => f.scheduled.filter(row => row.name === 'projectGithubPullStatus:post');
  assert.deepEqual(
    posts().map(row => [row.args.state, row.args.sha]),
    [['success', 'b'.repeat(40)]],
  );
  assert(
    f.scheduled.some(row => row.name === 'projectGithubPull:retire'),
    'the PR Lane is retired',
  );
  const settled = f.tables.projectGithubMirrorJobs.get(job._id);
  assert.equal(pullOf(settled).outcome, 'success');
  assert.equal(settled.waitKey, undefined);
  await f.run('settleAgain', pullQueue.settle._handler, settle.args);
  assert.equal(posts().length, 1, 'one final status per head');
  // A second PR still checking is superseded by its newer head: error status on the old head.
  await prHead(f, 'c'.repeat(40), 9);
  const [old] = pullJobs(f, 9);
  f.patch('projectGithubMirrorJobs', old._id, {
    status: 'done',
    waitKey: runId,
    inbound: JSON.stringify({
      phase: 'checking',
      pull: { number: 9, head: 'c'.repeat(40), fork: false, runId },
      laneId,
    }),
  });
  await prHead(f, 'd'.repeat(40), 9);
  assert.equal(pullOf(f.tables.projectGithubMirrorJobs.get(old._id)).outcome, 'superseded');
  assert.deepEqual(posts().at(-1).args, {
    projectId: f.projectId,
    repository: 'Synthetic/Mirror',
    sha: 'c'.repeat(40),
    state: 'error',
    description: 'Superseded by a newer push to this pull request.',
    link: null,
    // SM-E: the post names its job so a failed post can be recorded on it.
    jobId: old._id,
  });
});
test('two-way PR fork: the owner decision starts or settles the waiting head; expiry and a newer head close the request', async () => {
  const f = await twoWayFixture();
  const { pullOperationId, forkStatus } = await import('../dist/github-pull-check.js');
  const posts = () => f.scheduled.filter(row => row.name === 'projectGithubPullStatus:post');
  /** A fork head waiting on its Lane's approval request, as the fork gate leaves it. */
  const waitingFork = async (number, head) => {
    await prHead(f, head, number);
    const job = pullJobs(f, number).at(-1),
      approval = pullOperationId(),
      laneId = randomUUID();
    f.patch('projectGithubMirrorJobs', job._id, {
      status: 'done',
      waitKey: approval,
      inbound: JSON.stringify({ phase: 'checking', pull: { number, head, fork: true, approval }, laneId }),
    });
    const rowId = f.insert('projectHostedApprovals', {
      projectId: f.projectId,
      laneId,
      operationId: approval,
      requester: 'owner',
      reason: 'fork',
      head: 'a'.repeat(64),
      at: 1,
      status: 'requested',
      live: false,
      pullRequest: number,
      version: 1,
    });
    return { job, approval, row: () => f.tables.projectHostedApprovals.get(rowId) };
  };
  // Granted: one indexed read, the run starts under the request's key, nothing is written.
  const a = await waitingFork(7, 'b'.repeat(40));
  await f.run('granted', ctx => pullQueue.notifyPullApproval(ctx, a.row(), 'granted'));
  assert.deepEqual(f.scheduled.at(-1), {
    name: 'projectGithubPull:start',
    args: { jobId: a.job._id, key: a.approval },
  });
  assert.equal(f.counts.at(-1).writes, 0);
  assert.equal(posts().length, 0);
  // Nobody decided in 30 days: forge/verify settles error with that reason; the request closes.
  await f.run('expire', pullQueue.expire._handler, { jobId: a.job._id, key: a.approval });
  assert.deepEqual(
    posts().map(row => [row.args.state, row.args.sha, row.args.description]),
    [['error', 'b'.repeat(40), forkStatus.expired]],
  );
  assert.equal(a.row().live, false);
  assert.equal(a.row().ended.kind, 'settled');
  await f.run('expireAgain', pullQueue.expire._handler, { jobId: a.job._id, key: a.approval });
  await f.run('lateDecline', ctx => pullQueue.notifyPullApproval(ctx, a.row(), 'declined'));
  assert.equal(posts().length, 1, 'a settled head changes nothing more');
  // Declined or withdrawn: settled error, named.
  for (const [number, status] of [
    [8, 'declined'],
    [9, 'withdrawn'],
  ]) {
    const w = await waitingFork(number, String(number).repeat(40));
    await f.run(status, ctx => pullQueue.notifyPullApproval(ctx, w.row(), status));
    assert.equal(posts().at(-1).args.state, 'error');
    assert.equal(posts().at(-1).args.description, forkStatus[status]);
    assert.equal(pullOf(f.tables.projectGithubMirrorJobs.get(w.job._id)).outcome, 'error');
    assert.equal(w.row().ended.kind, 'settled');
  }
  // A newer push supersedes the waiting head and closes its request; the new head asks again.
  const s = await waitingFork(10, 'c'.repeat(40));
  await prHead(f, 'd'.repeat(40), 10);
  assert.equal(pullOf(f.tables.projectGithubMirrorJobs.get(s.job._id)).outcome, 'superseded');
  assert.equal(s.row().ended.kind, 'settled');
  assert.equal(f.tables.projectHostedApprovals.size, 4, 'fork requests are never live rows');
  assert(![...f.tables.projectHostedApprovals.values()].some(row => row.live));
});

const pointAt = (f, repo) =>
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...f.tables.hostedProjects.get(f.projectId).autonomyPolicy,
      githubMirror: { repo, autoPush: true, laneRefs: false },
    },
  });
const mirrorStatus = f =>
  f.run('status', async ctx => githubMirrorStatus(ctx, await ctx.db.get(f.projectId)));
const queueRow = f => [...f.tables.projectGithubMirrors.values()][0];
const jobs = f => [...f.tables.projectGithubMirrorJobs.values()];

test('SM-E mirror queue: a retarget re-points the queue so the next publish is a queued job, not a never-active failure', async () => {
  const f = fixture();
  await f.enqueue(f.receipt());
  const [first] = jobs(f);
  pointAt(f, 'synthetic/other');
  assert.equal(
    await f.run('retarget', ctx => retarget.retargetGithubMirror(ctx, f.projectId, 'synthetic/other')),
    true,
  );
  assert.equal(queueRow(f).repository, 'synthetic/other');
  assert.equal(queueRow(f).activeId, null);
  assert.equal(queueRow(f).mapping, null);
  assert.equal(f.tables.projectGithubMirrorJobs.get(first._id).status, 'done');
  await f.enqueue(f.receipt());
  const next = jobs(f).find(job => job._id !== first._id);
  assert.equal(next.status, 'queued');
  assert.equal(next.repository, 'synthetic/other');
  assert.equal(queueRow(f).activeId, next._id);
  assert.equal(f.scheduled.length, 2, 'one wake for each repository, nothing idle');
  assert(!jobs(f).some(job => job.error === 'GITHUB_SYNC_BINDING'));
  assert.equal(
    await f.run('again', ctx => retarget.retargetGithubMirror(ctx, f.projectId, 'synthetic/other')),
    false,
    'a repeat changes nothing',
  );
});

test('SM-E mirror status: a failed job that is not the active job is shown, and the owner resume repairs it', async () => {
  const f = fixture();
  await f.enqueue(f.receipt());
  const [first] = jobs(f);
  // A project retargeted before the fix: the old publish ended and every later one failed unseen.
  f.patch('projectGithubMirrorJobs', first._id, { status: 'done' });
  f.patch('projectGithubMirrors', queueRow(f)._id, { activeId: null });
  pointAt(f, 'synthetic/other');
  await f.enqueue(f.receipt());
  assert.equal(jobs(f).filter(job => job.error === 'GITHUB_SYNC_BINDING').length, 1);
  const stuck = await mirrorStatus(f);
  assert.equal(stuck.status, 'failed');
  assert.equal(stuck.error, 'GITHUB_SYNC_BINDING');
  assert.equal(stuck.failedJobs, 1);
  assert.match(stuck.nextStep, /nforge github resume PROJECT/);
  const healed = await f.run('resume', ctx => owner.resume._handler(ctx, { projectId: f.projectId }));
  assert.equal(healed.status, 'retargeted');
  const after = await mirrorStatus(f);
  assert.notEqual(after.status, 'failed');
  assert.equal(after.failedJobs, undefined);
  await f.enqueue(f.receipt());
  assert.equal(queueRow(f).activeId !== null, true, 'the next publish becomes the active job');
  // Owner only.
  await assert.rejects(
    f.call('stranger', owner.resume, { projectId: f.projectId }, 'someone-else'),
    error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE',
  );
});

test('SM-E mirror queue: the owner resumes a terminally failed job; a healthy queue reads no failed-job rows', async () => {
  const f = fixture();
  await f.enqueue(f.receipt());
  const input = f.scheduled[0].args;
  await f.run('terminal', store.failed._handler, {
    ...input,
    code: 'GITHUB_INBOUND_CONFLICT',
    detail: 'both changed a.txt',
  });
  const job = jobs(f)[0];
  assert.equal(job.status, 'failed');
  assert.match(job.detail, /nforge github resume PROJECT/);
  assert(!/npx convex/.test(job.detail), 'the failure names a command a user can run');
  const status = await mirrorStatus(f);
  assert.equal(status.status, 'failed');
  assert.match(status.nextStep, /nforge github resume PROJECT/);
  const resumed = await f.run('resume', ctx => owner.resume._handler(ctx, { projectId: f.projectId }));
  assert.equal(resumed.status, 'scheduled');
  assert.equal(f.tables.projectGithubMirrorJobs.get(job._id).status, 'running');
});

const prJob = (f, extra = {}) => {
  const queue = queueRow(f);
  return f.insert('projectGithubMirrorJobs', {
    projectId: f.projectId,
    receiptId: `pull:${randomUUID()}`,
    sequence: 0.5,
    repository: 'synthetic/mirror',
    authorityEpoch: 1,
    status: 'done',
    step: 1,
    cursor: null,
    state: '0'.repeat(64),
    pullKey: '7',
    inbound: JSON.stringify({
      phase: 'checking',
      pull: { number: 7, head: 'b'.repeat(40), fork: false, outcome: 'success' },
    }),
    ...extra,
    ...(queue ? {} : {}),
  });
};

test('SM-E forge/verify: a final status that never reached GitHub is recorded, shown with its next step, and re-posted by the owner', async () => {
  const f = fixture();
  await f.enqueue(f.receipt());
  f.patch('projectGithubMirrorJobs', jobs(f)[0]._id, { status: 'done' });
  f.patch('projectGithubMirrors', queueRow(f)._id, { activeId: null, mapping: null });
  const pull = prJob(f);
  // Earlier attempts only retry; the last one records the failure on the job and does not throw.
  const recorded = [];
  const ctx = {
    runMutation: async (ref, args) => recorded.push({ name: getFunctionName(ref), args }),
    scheduler: { runAfter: async () => 'task' },
  };
  const post = {
    projectId: f.projectId,
    repository: 'synthetic/mirror',
    sha: 'b'.repeat(40),
    state: 'success',
    description: 'Forge check passed.',
    link: null,
    jobId: pull,
  };
  await verifyPost.post._handler(ctx, { ...post, attempt: 1 });
  assert.equal(recorded.length, 0, 'a retry is not a failure yet');
  await verifyPost.post._handler(ctx, { ...post, attempt: 3 });
  assert.deepEqual(
    recorded.map(call => call.name),
    ['projectGithubPullStatusStore:statusFailed'],
  );
  await f.run('record', verifyStore.statusFailed._handler, {
    jobId: pull,
    state: 'success',
    description: 'Forge check passed.',
    error: 'GITHUB_STATUS_POST_FAILED',
  });
  const status = await mirrorStatus(f);
  assert.equal(status.status, 'failed', 'a settled head is not all-clear while GitHub still shows pending');
  assert.equal(status.error, 'GITHUB_VERIFY_POST_FAILED');
  assert.match(status.detail, /PR #7 at bbbbbbbbbbbb/);
  assert.match(status.nextStep, /nforge github resume PROJECT/);
  const result = await f.run('resume', ctx => owner.resume._handler(ctx, { projectId: f.projectId }));
  assert.equal(result.statusReposted, true);
  const repost = f.scheduled.at(-1);
  assert.equal(repost.name, 'projectGithubPullStatus:post');
  assert.equal(repost.args.jobId, pull);
  assert.equal(repost.args.clear, true);
  assert.equal(repost.args.state, 'success');
  // Its success clears the record; the status is quiet again.
  await f.run('posted', verifyStore.statusPosted._handler, { jobId: pull });
  assert.equal(queueRow(f).verifyFailedId, undefined);
  assert.notEqual((await mirrorStatus(f)).status, 'failed');
});

test('ci-status: mirror commit wakes indexed waiters in bounded pages and replay adds no publication', async () => {
  const f = fixture();
  const first = f.receipt();
  await f.enqueue(first);
  const job = [...f.tables.projectGithubMirrorJobs.values()][0];
  job.ciWaiters = true;
  for (let i = 0; i < 19; i++)
    f.insert('projectHostedCheckRuns', {
      projectId: f.projectId,
      runId: `ci-${i}`,
      candidateId: `candidate-${i}`,
      status: i === 18 ? 'cancelled' : 'queued',
      ciMirrorJob: job._id,
      value: 'x'.repeat(128 * 1024),
    });
  const input = {
    jobId: job._id,
    step: 0,
    cursor: null,
    mapping: JSON.stringify({ ...mirrorFixture().root, acceptanceId: first.id, state: first.candidate.head }),
  };
  await f.run('commit-with-ci-waiters', store.commit._handler, input);
  const wake = await import(moduleUrl('../convex/projectCiStatusMirror.ts'));
  for (let i = 0; i < 2; i++) await f.run('wake-page', wake.wake._handler, { jobId: job._id });
  assert.equal(f.scheduled.filter(s => s.name === 'projectCiStatusPublish:publish').length, 18);
  assert.equal(f.scheduled.filter(s => s.name === 'projectCiStatusMirror:wake').length, 2);
  assert([...f.tables.projectHostedCheckRuns.values()].every(row => row.ciMirrorJob === undefined));
  const calls = f.scheduled.length;
  await f.run('replay-with-ci-waiters', store.commit._handler, input);
  await f.run('wake-drained', wake.wake._handler, { jobId: job._id });
  assert.equal(f.scheduled.length, calls);
  for (const count of f.counts.filter(c => ['commit-with-ci-waiters', 'wake-page'].includes(c.name)))
    assert(
      (count.readBytesByTable.projectHostedCheckRuns ?? 0) < 1100 * 1024,
      'each page reads at most eight 128 KiB legacy run rows, not the waiting cohort',
    );
});
