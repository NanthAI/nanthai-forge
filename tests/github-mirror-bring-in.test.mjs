// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item c63c2171: bringing GitHub's commit into Forge is one explicit action by the owner person.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorControlsFixture as fixture } from './github-mirror-controls-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { acceptMirrorReceipt as accept } from './github-mirror-catchup-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const resume = await import(moduleUrl('../convex/projectGithubMirrorResume.ts'));
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));
const inboundQueue = await import(moduleUrl('../convex/projectGithubInboundQueue.ts'));

/** A one-way mirror whose publish stopped because GitHub's main moved without Forge. */
function moved(inbound = false) {
  const f = fixture(inbound, 'synthetic/mirror'),
    github = mirrorFixture();
  const base = accept(f, github.root.state, github.root.state, 0);
  f.patch('projectGithubMirrors', f.mirrorId, {
    mapping: JSON.stringify({ ...github.root, acceptanceId: base.id }),
  });
  const receipt = accept(f, github.head, github.root.state, 1);
  const publish = f.insert('projectGithubMirrorJobs', {
    projectId: f.projectId,
    repository: 'synthetic/mirror',
    receiptId: receipt.id,
    sequence: 1,
    authorityEpoch: 1,
    state: github.head,
    status: 'failed',
    step: 2,
    cursor: null,
    error: 'GITHUB_SYNC_CHANGED',
    detail: 'GitHub main moved away from the retained Forge mirror mapping.',
  });
  f.patch('projectGithubMirrors', f.mirrorId, { activeId: publish });
  return { f, publish, base };
}
const device = f => {
  f.insert('cliCredentials', {
    owner: 'owner',
    name: 'Synthetic',
    scope: 'cli',
    credentialId: 'owner-device',
    tokenHash: 'synthetic',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600000,
    revoked: false,
  });
  return { subject: 'owner', forgeCredential: 'owner-device' };
};

test('one press by the owner person queues GitHub’s commit as an inbound landing on a one-way mirror', async t => {
  const { f, publish } = moved();
  assert.equal((await f.read()).state, 'moved');
  assert.match((await f.read()).next, /brings GitHub’s commit into Forge/);
  const reply = await f.call('bring-in', resume.bringIn, { projectId: f.projectId });
  assert.equal(reply.status, 'bringing-in');
  const meter = f.counts.at(-1);
  assert(meter.documents <= 7 && meter.writes <= 5, JSON.stringify(meter));
  t.diagnostic(
    JSON.stringify({ documents: meter.documents, readBytes: meter.readBytes, writes: meter.writes }),
  );
  const inbound = f.tables.projectGithubMirrorJobs.get(reply.jobId);
  assert.equal(JSON.parse(inbound.inbound).requested, true);
  assert.equal(inbound.sequence, 0);
  assert.equal(f.tables.projectGithubMirrors.get(f.mirrorId).activeId, reply.jobId);
  const held = f.tables.projectGithubMirrorJobs.get(publish);
  assert.equal(held.status, 'queued', 'the stopped publish waits behind it and re-seeds on top of it');
  assert.equal(held.seed, undefined);
  assert.equal(f.scheduled.length, 1, 'one mirror step, no GitHub write from the press itself');
  // The worker may take it in although the mirror stays one-way.
  const begun = JSON.parse(await f.call('begin', store.begin, { jobId: reply.jobId, step: inbound.step }));
  assert.equal(begun.inbound, true);
  assert.equal(
    effectiveInbound(f),
    false,
    'direction unchanged: pushes made on GitHub are still not taken in',
  );
  // Retry-safe by state.
  const again = await f.call('bring-in-again', resume.bringIn, { projectId: f.projectId });
  assert.deepEqual(again, { status: 'already-running', jobId: reply.jobId });
  assert.equal(f.tables.projectGithubMirrorJobs.size, 2);
});
const effectiveInbound = f => f.tables.hostedProjects.get(f.projectId).autonomyPolicy.githubMirror.inbound;

test('an unrequested inbound job still cannot run on a one-way mirror', async () => {
  const { f } = moved();
  const queue = f.tables.projectGithubMirrors.get(f.mirrorId);
  const id = await f.call(
    'webhook-like',
    {
      _handler: async ctx =>
        inboundQueue.ensureInbound(ctx, await ctx.db.get(f.projectId), { ...queue, activeId: null }),
    },
    {},
  );
  await assert.rejects(
    f.call('begin', store.begin, { jobId: id, step: 0 }),
    e => e.data?.code === 'GITHUB_SYNC_DISABLED' || e.code === 'GITHUB_SYNC_DISABLED',
  );
});

test('only the owner person may choose GitHub’s commit, and only when GitHub moved', async () => {
  const { f } = moved();
  await assert.rejects(
    f.call('device', resume.bringIn, { projectId: f.projectId }, device(f)),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    f.call('stranger', resume.bringIn, { projectId: f.projectId }, 'someone-else'),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(f.tables.projectGithubMirrorJobs.size, 1);
  const level = fixture(false, 'synthetic/mirror');
  await assert.rejects(
    level.call('level', resume.bringIn, { projectId: level.projectId }),
    e => e.data?.code === 'GITHUB_SYNC_PENDING',
  );
  assert.equal(level.tables.projectGithubMirrorJobs.size, 0);
});

// Review e7fd13b7 (must-fix): the owner chose to keep GitHub's commit. If its landing fails, Forge must not later take
// it out of GitHub main: the mapping stays on Forge's last push, no note is set, and the mirror stops as "moved" again.
test('a requested bring-in that fails to land leaves GitHub main alone; the mirror stops as moved again', async () => {
  const { randomUUID } = await import('node:crypto');
  const mirrorQueue = await import(moduleUrl('../convex/projectGithubMirrorQueue.ts'));
  const { f, publish, base } = moved();
  const before = f.tables.projectGithubMirrors.get(f.mirrorId).mapping;
  const reply = await f.call('bring-in', resume.bringIn, { projectId: f.projectId });
  const submissionId = randomUUID();
  f.patch('projectGithubMirrorJobs', reply.jobId, {
    status: 'running',
    inbound: JSON.stringify({
      phase: 'landing',
      requested: true,
      commit: 'b'.repeat(40),
      tree: 'd'.repeat(40),
      message: 'hand push',
      equivalent: 'e'.repeat(64),
      base: { head: base.candidate.head, receiptId: base.id },
      laneId: randomUUID(),
      landingOperationId: randomUUID(),
      submissionId,
    }),
  });
  f.tables.projectHostedLandingRequests.set('landing-row', {
    _id: 'landing-row',
    _creationTime: 1,
    projectId: f.projectId,
    submissionId,
    phase: 'terminal-failed',
    value: JSON.stringify({
      phase: 'terminal-failed',
      error: { code: 'CHECK_NOT_PASSED', message: 'A test failed.' },
    }),
  });
  // Review faa6eaa2: until the next landing settles it, status says GitHub keeps the commit (never "takes it out").
  const waiting = await f.read();
  assert.equal(waiting.state, 'moved');
  assert.match(waiting.sentence, /GitHub’s main keeps it/);
  assert.doesNotMatch(`${waiting.sentence} ${waiting.next}`, /takes it out|let it drop/);
  assert.match(waiting.next, /reset GitHub main to the commit Forge pushed last/);
  const mirroredAt = f.tables.projectGithubMirrors.get(f.mirrorId).mirroredAt;
  // Any later Forge landing settles the failed inbound job.
  const later = accept(f, 'f'.repeat(64), base.candidate.head, 2);
  await f.call(
    'enqueue',
    { _handler: async ctx => mirrorQueue.enqueueGithubMirror(ctx, await ctx.db.get(f.projectId), later) },
    {},
  );
  const queue = f.tables.projectGithubMirrors.get(f.mirrorId);
  assert.deepEqual(
    JSON.parse(queue.mapping),
    JSON.parse(before),
    'the mapping stays on the commit Forge pushed last',
  );
  assert.equal(JSON.parse(queue.inbound).note, undefined, 'no note: nothing is taken out of GitHub main');
  const inbound = f.tables.projectGithubMirrorJobs.get(reply.jobId);
  assert.equal(inbound.status, 'failed');
  assert.match(inbound.detail, /GitHub main keeps it and the mirror stays stopped/);
  assert.equal(queue.mirroredAt, mirroredAt, 'nothing was pushed, so the mirrored time stays');
  const settled = await f.read();
  assert.doesNotMatch(`${settled.sentence} ${settled.next}`, /takes it out|let it drop/);
  const job = f.tables.projectGithubMirrorJobs.get(publish);
  const begun = JSON.parse(await f.call('begin', store.begin, { jobId: publish, step: job.step }));
  assert.doesNotMatch(begun.seed?.message ?? '', /out of main/, 'the publish carries no take-out note');
});
