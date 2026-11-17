// SPDX-License-Identifier: Apache-2.0
// P8: owner-person pause/resume retains the link/direction; disconnect uses the CLI path and cannot repeat removal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
const policy = await import(moduleUrl('../convex/projectAutonomy.ts'));
const binding = await import(moduleUrl('../convex/githubBindingStore.ts'));
const mirror = await import(moduleUrl('../convex/projectGithubMirrorRead.ts'));
const resume = await import(moduleUrl('../convex/projectGithubMirrorResume.ts'));
const queue = await import(moduleUrl('../convex/projectGithubInboundQueue.ts'));
const rows = await import(moduleUrl('../convex/projectGithubMirrorRows.ts'));
const refusal = e => (e.data?.code ?? e.code) === 'PROJECT_UNAVAILABLE';
function fixture(inbound = true) {
  const f = lanesFixture();
  const projectId = f.insert('hostedProjects', {
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    sourceAuthority: { mode: 'server', epoch: 1 },
    autonomyPolicy: {
      ...policyPreset('supervised'),
      githubMirror: { repo: 'example/repo', autoPush: true, laneRefs: false, inbound },
    },
  });
  const bound = {
    projectId,
    repoId: 42,
    fullName: 'example/repo',
    installationId: 9,
    boundBy: 'owner',
    boundAt: 1,
  };
  const bindingId = f.insert('projectGithubBindings', bound);
  const mirrorId = f.insert('projectGithubMirrors', {
    projectId,
    repository: 'example/repo',
    repositoryKey: 'example/repo',
    activeId: null,
    mapping: null,
  });
  const read = () => f.call('mirror', mirror.read, { projectId });
  const change = autoPush => ({
    projectId,
    command: JSON.stringify({
      action: 'set-policy',
      operationId: randomUUID(),
      githubMirror: { repo: 'example/repo', autoPush, inbound: autoPush && inbound, laneRefs: false },
    }),
  });
  return { ...f, projectId, bindingId, mirrorId, bound, read, change };
}
test('pause then resume retains repository, two-way direction and mirror history without inbound work while paused', async () => {
  const f = fixture();
  const before = structuredClone(f.tables.projectGithubBindings.get(f.bindingId));
  const pause = f.change(false);
  await f.call('pause', policy.set, pause);
  await f.call('pause-retry', policy.set, pause);
  const paused = await f.read();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.inbound, true);
  const stored = f.tables.hostedProjects.get(f.projectId);
  assert.equal(
    stored.autonomyPolicy.githubMirror.inbound,
    false,
    'older policy readers retain a valid disabled mirror',
  );
  assert.equal(stored.githubMirrorPausedInbound, true, 'the resume choice uses the same project record');
  assert.equal(paused.repoId, 42);
  assert.match(paused.sentence, /link stays/);
  assert.equal(queue.twoWay(f.tables.hostedProjects.get(f.projectId)), null);
  assert.equal(f.scheduled.length, 0, 'pause schedules no work');
  await f.call('resume-policy', policy.set, f.change(true));
  await f.call('resume-job', resume.resume, { projectId: f.projectId });
  const after = await f.read();
  assert.equal(after.direction, 'two-way');
  assert.equal(after.repository, 'example/repo');
  assert.deepEqual(f.tables.projectGithubBindings.get(f.bindingId), before);
  assert(f.tables.projectGithubMirrors.has(f.mirrorId));
});
test('disconnect ends the mirror and its binding atomically, preserves source, and replay cannot remove a new connection', async () => {
  const f = fixture();
  const request = { projectId: f.projectId, operationId: randomUUID(), repoId: 42 };
  await f.call('disconnect', binding.remove, request);
  assert.equal(f.tables.hostedProjects.get(f.projectId).autonomyPolicy.githubMirror, undefined);
  assert.equal(f.tables.projectGithubBindings.size, 0);
  assert.equal((await f.read()).state, 'off');
  assert(f.tables.projectGithubMirrors.has(f.mirrorId), 'mirror history remains');
  f.insert('projectGithubBindings', f.bound);
  await f.call('disconnect-retry', binding.remove, request);
  assert.equal(f.tables.projectGithubBindings.size, 1, 'new connection survives an old retry');
});
test('another person, a device and an agent credential cannot pause, resume or disconnect; the web offers no owner controls to devices', async () => {
  for (const actor of ['stranger', 'device', 'agent']) {
    const f = fixture();
    let subject = actor;
    if (actor !== 'stranger') {
      subject = 'owner';
      f.insert('cliCredentials', {
        owner: subject,
        name: 'Synthetic',
        scope: 'cli',
        credentialId: `${actor}-key`,
        tokenHash: 'synthetic',
        issuedAt: 1,
        expiresAt: Date.now() + 600000,
        revoked: false,
      });
      f.decorateContext(ctx => {
        ctx.auth.getUserIdentity = async () => ({ subject, forgeCredential: `${actor}-key` });
      });
    }
    for (const [name, fn, input] of [
      ['pause', policy.set, f.change(false)],
      ['disconnect', binding.remove, { projectId: f.projectId, operationId: randomUUID(), repoId: 42 }],
      [
        'disconnect-named',
        binding.remove,
        { projectId: f.projectId, operationId: randomUUID(), repoId: 0, repository: 'example/repo' },
      ],
      ['resume', resume.resume, { projectId: f.projectId }],
    ])
      await assert.rejects(f.call(name, fn, input, subject), refusal, actor + ' ' + name);
    assert.equal(f.tables.projectGithubBindings.size, 1);
    assert.equal(f.tables.hostedProjects.get(f.projectId).autonomyPolicy.githubMirror.autoPush, true);
    if (actor !== 'stranger') assert.equal((await f.read()).owner, false);
  }
});
test('paused two-way policy fences an already queued mirror step before it can reach GitHub', async () => {
  const f = fixture();
  const jobId = f.insert('projectGithubMirrorJobs', {
    projectId: f.projectId,
    repository: 'example/repo',
    receiptId: randomUUID(),
    sequence: 1,
    authorityEpoch: 1,
    state: 'a'.repeat(64),
    status: 'running',
    step: 0,
    cursor: null,
  });
  f.patch('projectGithubMirrors', f.mirrorId, { activeId: jobId });
  await f.call('pause', policy.set, f.change(false));
  await assert.rejects(
    f.call('step', { _handler: ctx => rows.mirrorJob(ctx, { jobId, step: 0 }) }, {}),
    e => (e.data?.code ?? e.code) === 'GITHUB_SYNC_DISABLED',
  );
});
test('mirror view reads selected metadata only when unrelated binding history doubles', async t => {
  const f = fixture();
  const meters = [];
  for (const size of [100, 200]) {
    for (let i = f.tables.projectGithubBindings.size; i <= size; i++)
      f.insert('projectGithubBindings', { ...f.bound, repoId: 1000 + i, fullName: `example/other-${i}` });
    await f.read();
    const meter = f.counts.at(-1);
    meters.push({ documents: meter.documents, readBytes: meter.readBytes, writes: meter.writes });
  }
  assert.deepEqual(meters[0], meters[1], 'unrelated repository count never changes mirror I/O');
  assert.equal(meters[0].writes, 0, 'view does not repair or schedule');
  assert.equal(meters[0].documents, 5, 'selected metadata and empty probes stay bounded');
  assert(meters[0].readBytes < 2048);
  t.diagnostic(JSON.stringify(meters));
});
test('a preconfigured mirror without a binding disconnects by exact repository; retries preserve a newer connection', async () => {
  const f = fixture();
  f.tables.projectGithubBindings.delete(f.bindingId);
  assert.equal((await f.read()).repoId, null);
  const request = {
    projectId: f.projectId,
    operationId: randomUUID(),
    repoId: 0,
    repository: 'example/repo',
  };
  await assert.rejects(
    f.call('wrong-mirror', binding.remove, { ...request, repository: 'example/other' }),
    e => (e.data?.code ?? e.code) === 'WORK_OPERATION_CHANGED',
  );
  await f.call('disconnect-named', binding.remove, request);
  assert.equal((await f.read()).state, 'off');
  f.insert('projectGithubBindings', f.bound);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policyPreset('supervised'),
      githubMirror: { repo: 'example/repo', autoPush: true, inbound: true, laneRefs: false },
    },
  });
  await assert.rejects(
    f.call('omitted-retry', binding.remove, {
      projectId: f.projectId,
      operationId: request.operationId,
      repoId: 0,
    }),
    e => (e.data?.code ?? e.code) === 'WORK_OPERATION_CHANGED',
  );
  await f.call('disconnect-named-retry', binding.remove, request);
  assert.equal(f.tables.projectGithubBindings.size, 1);
  assert.equal((await f.read()).direction, 'two-way');
  await assert.rejects(
    f.call('changed-retry', binding.remove, { ...request, repository: 'example/other' }),
    e => (e.data?.code ?? e.code) === 'WORK_OPERATION_CHANGED',
  );
});

test('pausing and resuming a one-way mirror never enables GitHub inbound landings', async () => {
  const f = fixture(false);
  await f.call('pause-one-way', policy.set, f.change(false));
  assert.equal((await f.read()).inbound, false);
  await f.call('resume-one-way', policy.set, f.change(true));
  assert.equal((await f.read()).direction, 'one-way');
  assert.equal(f.tables.projectGithubBindings.size, 1);
});
