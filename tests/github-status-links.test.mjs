// SPDX-License-Identifier: Apache-2.0
// Item d357d772: a GitHub status carries no private project's handle, slug or title. Every status Forge posts for a
// private project (pending and started on a fork run, settled, reposted) links the opaque /approve form, which a
// member's session resolves to the Lane and anyone else gets not-found; a public project keeps the readable Lane page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';

const urls = await import(moduleUrl('../convex/urlProjects.ts'));
const queue = await import(moduleUrl('../convex/projectGithubPullQueue.ts'));
const { forkGate } = await import(moduleUrl('../convex/projectGithubPullFork.ts'));
const { repostPullStatus } = await import(moduleUrl('../convex/projectGithubPullStatusStore.ts'));

const web = 'https://forge.example.invalid';
const head = 'b'.repeat(40);
async function fixture(t, visibility) {
  const synthetic = {
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
    FORGE_WEB_URL: web,
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
  const f = await finishFixture(t);
  f.patch('hostedProjects', f.projectId, { slug: 'tide-pool', visibility });
  f.insert('forgeAccounts', { owner: 'owner', handle: 'ada' });
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  return f;
}
const opaque = f =>
  `${web}/approve?project=${encodeURIComponent(f.projectId)}&lane=${encodeURIComponent(f.lane.laneId)}`;
const readable = f => `${web}/ada/tide-pool/lanes/${f.lane.laneId}`;
const job = (f, pull, extra = {}) =>
  f.insert('projectGithubMirrorJobs', {
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
      pull: { number: 7, head, fork: false, ...pull },
      laneId: f.lane.laneId,
    }),
    ...extra,
  });
const posted = f =>
  f
    .pending()
    .filter(task => task.name === 'projectGithubPullStatus:post')
    .at(-1).args[0];
const run = (f, label, work) => f.tx(label, { _handler: work }, {});

for (const visibility of ['private', 'public']) {
  const expected = f => (visibility === 'public' ? readable(f) : opaque(f));
  test(`d357d772: ${visibility} project: the fork run's pending and started statuses`, async t => {
    const f = await fixture(t, visibility);
    const pendingJob = job(f, { fork: true }, { waitKey: randomUUID() });
    await run(f, 'pending', async ctx =>
      forkGate(ctx, await ctx.db.get(pendingJob), await ctx.db.get(f.projectId)),
    );
    // A public pending status keeps the approve link the board note carries (the app-root form).
    assert.equal(
      posted(f).link,
      visibility === 'public' ? `${web}/-/ada/tide-pool/lanes/${f.lane.laneId}` : opaque(f),
      'pending',
    );
    // The owner grants the request: the same job now says the run started.
    const row = [...f.tables.projectHostedApprovals.entries()].find(([, r]) => r.laneId === f.lane.laneId);
    f.patch('projectHostedApprovals', row[0], {
      status: 'granted',
      decision: { operationId: randomUUID(), by: 'owner', at: 1, head: row[1].head, via: 'lane' },
    });
    const operationId = row[1].operationId;
    f.patch('projectGithubMirrorJobs', pendingJob, {
      inbound: JSON.stringify({
        phase: 'checking',
        pull: { number: 7, head, fork: true, approval: operationId },
        laneId: f.lane.laneId,
      }),
    });
    await run(f, 'started', async ctx =>
      forkGate(ctx, await ctx.db.get(pendingJob), await ctx.db.get(f.projectId)),
    );
    assert.equal(posted(f).link, expected(f), 'started');
  });

  test(`d357d772: ${visibility} project: the settled status`, async t => {
    const f = await fixture(t, visibility);
    const settling = job(f, {});
    await run(f, 'settle', async ctx => queue.settlePull(ctx, await ctx.db.get(settling), 'success'));
    const status = posted(f);
    assert.equal(status.state, 'success');
    assert.equal(status.link, expected(f));
  });

  test(`d357d772: ${visibility} project: the reposted status`, async t => {
    const f = await fixture(t, visibility);
    const failed = job(f, {
      statusPost: { state: 'failure', description: 'Forge check failed.', error: 'HTTP 500' },
    });
    f.insert('projectGithubMirrors', {
      projectId: f.projectId,
      repository: 'synthetic/mirror',
      activeId: null,
      mapping: null,
      verifyFailedId: failed,
    });
    assert.equal(await run(f, 'repost', ctx => repostPullStatus(ctx, f.projectId)), true);
    assert.equal(posted(f).link, expected(f));
  });
}

test('d357d772: a private project with no Lane to name carries no link; a public one links the project', async t => {
  const projectLink = (f, laneId) =>
    run(f, 'link', async ctx => queue.projectLink(ctx, await ctx.db.get(f.projectId), laneId));
  const priv = await fixture(t, 'private');
  assert.equal(await projectLink(priv), null);
  const pub = await fixture(t, 'public');
  assert.equal(await projectLink(pub), `${web}/ada/tide-pool`);
});

test('d357d772: the opaque link opens the Lane for a member and is not-found for anyone else', async t => {
  const f = await fixture(t, 'private');
  const args = { projectId: f.projectId, lane: f.lane.laneId };
  const found = await f.tx('member', urls.approvalTarget, args, 'owner');
  assert.deepEqual(found, { handle: 'ada', slug: 'tide-pool', laneId: f.lane.laneId });
  assert.equal(await f.tx('stranger', urls.approvalTarget, args, 'stranger'), null);
});
