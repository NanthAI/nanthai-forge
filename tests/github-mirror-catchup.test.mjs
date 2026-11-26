// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { mirrorControlsFixture as fixture } from './github-mirror-controls-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { acceptMirrorReceipt as accept } from './github-mirror-catchup-fixture.mjs';
import { prepareMirror, stepMirror } from '../dist/hosted-github-mirror.js';
const policies = await import(moduleUrl('../convex/projectAutonomy.ts'));
const resume = await import(moduleUrl('../convex/projectGithubMirrorResume.ts'));
const queue = await import(moduleUrl('../convex/projectGithubMirrorQueue.ts'));
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));
const rows = await import(moduleUrl('../convex/projectGithubMirrorRows.ts'));
const gitServe = await import(moduleUrl('../convex/gitServeLaneStore.ts'));

async function drain(f, github, jobId) {
  let job = f.tables.projectGithubMirrorJobs.get(jobId);
  for (let steps = 0; steps < 10 && job.status !== 'done'; steps++) {
    const input = { jobId, step: job.step };
    const begun = JSON.parse(await f.call('begin', store.begin, input));
    const cursor = begun.cursor ? JSON.parse(begun.cursor) : await prepareMirror(begun.seed, github.io);
    const next = await stepMirror(cursor, github.io);
    await f.call('commit', store.commit, {
      ...input,
      cursor: next.phase === 'done' ? null : JSON.stringify(next),
      mapping: next.phase === 'done' ? JSON.stringify(next.entry) : null,
    });
    job = f.tables.projectGithubMirrorJobs.get(jobId);
  }
  assert.equal(job.status, 'done');
}

test('owner CLI recovery works on an enabled mirror but cannot undo a person pause', async () => {
  const f = fixture();
  const credentialId = 'owner-device';
  f.insert('cliCredentials', {
    owner: 'owner',
    name: 'Synthetic',
    scope: 'cli',
    credentialId,
    tokenHash: 'synthetic',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600000,
    revoked: false,
  });
  const device = { subject: 'owner', forgeCredential: credentialId };
  assert.equal(
    (await f.call('device-recovery', resume.resume, { projectId: f.projectId }, device)).status,
    'nothing-to-resume',
  );
  await f.call('person-pause', policies.set, f.change(false));
  await assert.rejects(
    f.call('paused-device-recovery', resume.resume, { projectId: f.projectId }, device),
    e => e.data?.code === 'GITHUB_SYNC_DISABLED',
  );
  await assert.rejects(
    f.call('device-unpause', policies.set, f.change(true), device),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
});

test('pause, land twice, resume publishes both changes in one catch-up commit without another landing', async t => {
  const f = fixture(true, 'synthetic/mirror');
  const github = mirrorFixture({
    before: { 'one.txt': 'old', 'two.txt': 'old' },
    between: { 'one.txt': 'new', 'two.txt': 'old' },
    after: { 'one.txt': 'new', 'two.txt': 'new' },
  });
  const base = accept(f, github.root.state, github.root.state, 0);
  f.patch('projectGithubMirrors', f.mirrorId, {
    mapping: JSON.stringify({ ...github.root, acceptanceId: base.id }),
  });
  await f.call('pause', policies.set, f.change(false));
  const first = accept(f, github.seed.previous, github.root.state, 1);
  await f.call(
    'paused-landing-one',
    { _handler: async ctx => queue.enqueueGithubMirror(ctx, await ctx.db.get(f.projectId), first) },
    {},
  );
  const last = accept(f, github.head, first.candidate.head, 2);
  await f.call(
    'paused-landing-two',
    { _handler: async ctx => queue.enqueueGithubMirror(ctx, await ctx.db.get(f.projectId), last) },
    {},
  );
  assert.equal(f.tables.projectGithubMirrorJobs.size, 0);
  await f.call('unpause', policies.set, f.change(true));
  assert.equal(
    f.tables.projectGithubMirrorJobs.size,
    1,
    'un-pause alone queues catch-up before any follow-up reply or command',
  );
  await f.call('resume', resume.resume, { projectId: f.projectId });
  const jobs = [...f.tables.projectGithubMirrorJobs.values()];
  assert.equal(jobs.length, 1, 'one catch-up job, not a scan or one job per paused receipt');
  assert.equal(jobs[0].receiptId, last.id);
  assert.equal(jobs[0].state, github.head);
  const pending = await f.read();
  assert(!pending.sentence.includes('Nothing needs you'));
  const priorName = process.env.FORGE_GITHUB_SYNC_NAME,
    priorEmail = process.env.FORGE_GITHUB_SYNC_EMAIL;
  process.env.FORGE_GITHUB_SYNC_NAME = github.seed.identity.name;
  process.env.FORGE_GITHUB_SYNC_EMAIL = github.seed.identity.email;
  t.after(() => {
    if (priorName === undefined) delete process.env.FORGE_GITHUB_SYNC_NAME;
    else process.env.FORGE_GITHUB_SYNC_NAME = priorName;
    if (priorEmail === undefined) delete process.env.FORGE_GITHUB_SYNC_EMAIL;
    else process.env.FORGE_GITHUB_SYNC_EMAIL = priorEmail;
  });
  await drain(f, github, jobs[0]._id);
  assert.equal(github.commits.size, 2, 'the paused window is one GitHub commit after its existing parent');
  assert.equal(github.commits.get(github.remote()).tree, github.expected());
  const message = github.commits.get(github.remote()).message;
  assert.match(message, /^Catch up 2 Forge landings\n/);
  for (const receipt of [first, last])
    assert(message.includes(`${receipt.message} (${receipt.id.slice(0, 8)})`));
  assert(!message.includes(first.actor.id), 'the summary contains subjects and receipt ids, not actor ids');
  assert(message.includes(`Forge-Acceptance: ${last.id}`));
  assert.equal((await f.read()).state, 'level');
  await f.call('resume-retry', resume.resume, { projectId: f.projectId });
  assert.equal(f.tables.projectGithubMirrorJobs.size, 1);
});

for (const kind of ['pending', 'inProgress'])
  test(`un-pause replaces a ${kind} mid-sync task and continues its exact cursor`, async () => {
    const f = fixture(true, 'synthetic/mirror');
    const github = mirrorFixture({
      after: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`file-${i}`, `content-${i}`])),
    });
    const progress = await stepMirror(await prepareMirror(github.seed, github.io), github.io);
    assert.notEqual(progress.phase, 'done');
    const cursor = JSON.stringify(progress);
    const jobId = f.insert('projectGithubMirrorJobs', {
      projectId: f.projectId,
      repository: kind === 'inProgress' ? 'Synthetic/Mirror' : 'synthetic/mirror',
      receiptId: github.seed.acceptanceId,
      sequence: 1,
      authorityEpoch: 1,
      state: github.head,
      status: 'running',
      step: 3,
      cursor,
      scheduledId: 'synthetic-old-task',
    });
    f.patch('projectGithubMirrors', f.mirrorId, { activeId: jobId, mapping: JSON.stringify(github.root) });
    const canceled = [];
    f.decorateContext(ctx => {
      ctx.db.system.get = async id =>
        id === 'synthetic-old-task' ? { _id: id, state: { kind }, scheduledTime: Date.now() } : null;
      ctx.scheduler.cancel = async id => canceled.push(id);
    });
    await f.call('pause', policies.set, f.change(false));
    await assert.rejects(
      f.call('paused-step', { _handler: ctx => rows.mirrorJob(ctx, { jobId, step: 3 }) }, {}),
      e => e.code === 'GITHUB_SYNC_DISABLED',
    );
    await f.call('unpause', policies.set, f.change(true));
    const resumed = f.tables.projectGithubMirrorJobs.get(jobId);
    assert.equal(resumed.cursor, cursor);
    assert.equal(
      resumed.step,
      4,
      'an in-progress worker that saw the pause is fenced even before it reports failure',
    );
    assert.deepEqual(canceled, kind === 'pending' ? ['synthetic-old-task'] : []);
    await f.call('late-failure', store.failed, {
      jobId,
      step: 3,
      code: 'GITHUB_SYNC_DISABLED',
      detail: 'late',
    });
    assert.equal(f.tables.projectGithubMirrorJobs.get(jobId).status, 'running');
    await drain(f, github, jobId);
    assert.equal(github.commits.get(github.remote()).tree, github.expected());
    assert.equal(
      github.calls.filter(c => c.method === 'POST' && c.path.endsWith('/blobs')).length,
      101,
      'the 100 checkpointed blobs are not uploaded again',
    );
  });

test('catch-up reads and writes only selected metadata when unrelated mirror history doubles', async t => {
  const meters = [];
  for (const size of [100, 200]) {
    const f = fixture(true, 'synthetic/mirror'),
      github = mirrorFixture();
    f.patch('projectGithubMirrors', f.mirrorId, { mapping: JSON.stringify(github.root) });
    accept(f, github.head, github.root.state, 1);
    for (let i = 0; i < size; i++)
      f.insert('projectGithubMirrorJobs', {
        projectId: f.projectId,
        receiptId: randomUUID(),
        sequence: i + 10,
        repository: 'synthetic/mirror',
        authorityEpoch: 1,
        state: 'b'.repeat(64),
        status: 'done',
        step: 1,
        cursor: null,
      });
    await f.call('catch-up', resume.resume, { projectId: f.projectId });
    const meter = f.counts.at(-1);
    meters.push({ documents: meter.documents, readBytes: meter.readBytes, writes: meter.writes });
    assert.equal(f.tables.projectGithubMirrorJobs.size, size + 1);
  }
  assert.deepEqual(meters[0], meters[1]);
  assert(meters[0].documents <= 15 && meters[0].readBytes < 8192 && meters[0].writes <= 4);
  t.diagnostic(JSON.stringify(meters));
});

test('a same-repository branch retarget excludes legacy main mapping from Candidate CI', async () => {
  const f = fixture(true, 'synthetic/mirror');
  const github = mirrorFixture();
  const receipt = accept(f, github.head, github.root.state, 1);
  const base = { head: github.head, receiptId: receipt.id };
  const oldMapping = { ...github.root, state: github.head, acceptanceId: receipt.id, commit: 'b'.repeat(40) };
  const job = {
    projectId: f.projectId,
    repository: 'synthetic/mirror',
    receiptId: receipt.id,
    sequence: 1,
    authorityEpoch: 1,
    state: github.head,
    status: 'done',
    step: 1,
    cursor: null,
  };
  f.insert('projectGithubMirrorJobs', { ...job, mapping: JSON.stringify(oldMapping) });
  const mirror = { repository: job.repository, mapping: null };
  const lookup = selected =>
    f.call(
      'ci-base',
      {
        _handler: ctx => gitServe.mirroredBase(ctx, f.projectId, base, selected),
      },
      {},
    );
  assert.equal((await lookup(mirror)).commit, oldMapping.commit, 'legacy main still uses its saved mapping');
  const trunk = { ...mirror, targetBranch: 'trunk' };
  assert.equal(await lookup(trunk), null, 'the old branch cannot supply Candidate CI ancestry');
  const newMapping = { ...oldMapping, commit: 'c'.repeat(40) };
  f.insert('projectGithubMirrorJobs', {
    ...job,
    sequence: 2,
    targetBranch: 'trunk',
    mapping: JSON.stringify(newMapping),
  });
  assert.equal((await lookup(trunk)).commit, newMapping.commit);
});

test('retarget recovery queues current main for the new repository without overwriting an old completed job', async () => {
  const f = fixture(true, 'synthetic/mirror'),
    github = mirrorFixture();
  const receipt = accept(f, github.head, github.root.state, 1);
  const oldMapping = { ...github.root, state: github.head, acceptanceId: receipt.id, commit: 'b'.repeat(40) };
  const oldId = f.insert('projectGithubMirrorJobs', {
    projectId: f.projectId,
    repository: 'synthetic/old',
    receiptId: receipt.id,
    sequence: 1,
    authorityEpoch: 1,
    state: github.head,
    status: 'done',
    step: 1,
    cursor: null,
    mapping: JSON.stringify(oldMapping),
  });
  f.patch('projectGithubMirrors', f.mirrorId, {
    repository: 'synthetic/old',
    repositoryKey: 'synthetic/old',
    mapping: JSON.stringify({ ...github.root, state: github.head }),
  });
  const result = await f.call('retarget-current-main', resume.resume, { projectId: f.projectId });
  assert.equal(result.status, 'retargeted');
  const old = f.tables.projectGithubMirrorJobs.get(oldId);
  assert.equal(old.repository, 'synthetic/old');
  assert.equal(old.mapping, JSON.stringify(oldMapping));
  assert.notEqual(result.jobId, oldId);
  const catchup = f.tables.projectGithubMirrorJobs.get(result.jobId);
  assert.equal(catchup.receiptId, receipt.id);
  assert.equal(catchup.repository, 'synthetic/mirror');
  const currentMapping = { ...oldMapping, commit: 'c'.repeat(40) };
  await f.call('finish-retarget-catchup', store.commit, {
    jobId: result.jobId,
    step: catchup.step,
    cursor: null,
    mapping: JSON.stringify(currentMapping),
  });
  const parent = await f.call(
    'git-serve-current-repository',
    {
      _handler: ctx =>
        gitServe.mirroredBase(
          ctx,
          f.projectId,
          { head: github.head, receiptId: receipt.id },
          { mapping: JSON.stringify(currentMapping), repository: 'Synthetic/Mirror' },
        ),
    },
    {},
  );
  assert.equal(
    parent.commit,
    currentMapping.commit,
    'git serve uses the current repository, never its old job',
  );
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      githubMirror: { ...project.autonomyPolicy.githubMirror, repo: 'Synthetic/Mirror' },
    },
  });
  await f.call('retarget-retry', resume.resume, { projectId: f.projectId });
  assert.equal(f.tables.projectGithubMirrorJobs.size, 2);
});

for (const failure of ['missing-receipt', 'changed-authority'])
  test(`un-pause rolls back atomically on ${failure}`, async () => {
    const f = fixture(),
      github = mirrorFixture();
    await f.call('pause', policies.set, f.change(false));
    const receipt = accept(f, github.head, github.root.state, 1);
    if (failure === 'missing-receipt') f.tables.projectHostedAcceptances.clear();
    else {
      const channel = [...f.tables.projectHostedChannels.values()][0];
      const main = JSON.parse(channel.selection);
      main.authority.epoch++;
      f.patch('projectHostedChannels', channel._id, { selection: JSON.stringify(main) });
    }
    await assert.rejects(
      f.call('unpause', policies.set, f.change(true)),
      e =>
        e.data?.code === (failure === 'missing-receipt' ? 'SOURCE_UNAVAILABLE' : 'SOURCE_AUTHORITY_CHANGED'),
    );
    assert.equal(f.tables.hostedProjects.get(f.projectId).autonomyPolicy.githubMirror.autoPush, false);
    assert.equal(f.tables.projectGithubMirrorJobs.size, 0);
    assert.equal(f.scheduled.length, 0);
    assert.equal(
      JSON.parse([...f.tables.projectHostedChannels.values()][0].selection).receipt.id,
      receipt.id,
    );
  });

test('un-pause that also changes the repository queues current main for the new repository in the same edit', async () => {
  const f = fixture(true, 'synthetic/old'),
    github = mirrorFixture();
  const receipt = accept(f, github.head, github.root.state, 1);
  f.patch('projectGithubMirrors', f.mirrorId, {
    mapping: JSON.stringify({ ...github.root, state: github.head, acceptanceId: receipt.id }),
  });
  await f.call('pause', policies.set, f.change(false));
  f.insert('projectGithubBindings', { ...f.bound, repoId: 43, fullName: 'synthetic/new' });
  await f.call('unpause-and-retarget', policies.set, {
    projectId: f.projectId,
    command: JSON.stringify({
      action: 'set-policy',
      operationId: randomUUID(),
      githubMirror: { repo: 'synthetic/new', autoPush: true, inbound: true, laneRefs: false },
    }),
  });
  const queueRow = f.tables.projectGithubMirrors.get(f.mirrorId);
  assert.equal(queueRow.repository, 'synthetic/new');
  const jobs = [...f.tables.projectGithubMirrorJobs.values()];
  assert.equal(jobs.length, 1, 'the edit itself queues one catch-up, no recovery command needed');
  assert.equal(jobs[0].receiptId, receipt.id);
  assert.equal(jobs[0].repository, 'synthetic/new');
  assert.equal(queueRow.activeId, jobs[0]._id);
  assert.equal(f.scheduled.length, 1);
  const read = await f.read();
  assert.notEqual(read.next?.includes('nforge github resume'), true, 'status no longer asks for recovery');
});
