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
      visibility === 'public' ? `${web}/ada/tide-pool/lanes/${f.lane.laneId}` : opaque(f),
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

// Follow-up (receipt 03d241c7): a terminal-failure description never carries free-form detail for a private project.
const secretDetail = 'tests/secret-path.test.mjs failed for ada/tide-pool';
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));
for (const visibility of ['private', 'public']) {
  test(`d357d772: ${visibility} project: a pull request job's terminal mirror failure description`, async t => {
    const f = await fixture(t, visibility);
    const failing = job(f, {}, { status: 'running', step: 1 });
    f.insert('projectGithubMirrors', {
      projectId: f.projectId,
      repository: 'synthetic/mirror',
      activeId: failing,
      mapping: null,
    });
    await f.tx('failed', store.failed, {
      jobId: failing,
      step: 1,
      code: 'GITHUB_SYNC_REJECTED',
      detail: secretDetail,
    });
    const status = posted(f);
    assert.equal(status.state, 'error');
    if (visibility === 'public') assert.equal(status.description, `GITHUB_SYNC_REJECTED: ${secretDetail}`);
    else {
      assert.equal(status.description, 'GITHUB_SYNC_REJECTED: Open the Lane in Forge for details.');
      assert.doesNotMatch(status.description, /secret|ada|tide/);
    }
  });

  test(`d357d772: ${visibility} project: a check that could not start settles with the error code only when private`, async t => {
    const f = await fixture(t, visibility);
    const starting = job(f, {}, { waitKey: 'k' });
    await f.tx(
      'settle',
      queue.settle,
      {
        jobId: starting,
        outcome: 'error',
        description: `Forge could not start the check (CODE: ${secretDetail}).`,
        privateDescription: 'Forge could not start the check (CODE). Open the Lane in Forge for details.',
        waitKey: 'k',
      },
      'owner',
    );
    const status = posted(f);
    if (visibility === 'public') assert.match(status.description, /secret-path/);
    else {
      assert.equal(
        status.description,
        'Forge could not start the check (CODE). Open the Lane in Forge for details.',
      );
      assert.doesNotMatch(status.description, /secret|ada|tide/);
    }
  });
}

// Receipt 0334007f review: a status queued while the project was public is re-checked when it posts. The post path
// asks the project's current visibility once and sends the private form (opaque link or none, code plus fixed
// sentence) when the project turned private in between.
const check = await import(moduleUrl('../src/github-pull-check.ts'));
const poster = await import(moduleUrl('../convex/projectGithubPullStatus.ts'));
const statusStore = await import(moduleUrl('../convex/projectGithubPullStatusStore.ts'));
const asPoster = f => ({ runQuery: (_ref, args) => f.tx('visibility', statusStore.publicNow, args) });
for (const turn of ['stays public', 'turns private', 'is removed']) {
  test(`d357d772: queued while public, the project ${turn} before the post`, async t => {
    const f = await fixture(t, 'public');
    const settling = job(f, {});
    await run(f, 'settle', async ctx =>
      queue.settlePull(
        ctx,
        await ctx.db.get(settling),
        'failure',
        secretDetail,
        `GITHUB_SYNC_REJECTED: ${check.openLane}`,
      ),
    );
    const queued = posted(f);
    assert.equal(queued.link, readable(f));
    assert.equal(queued.description, secretDetail);
    if (turn === 'turns private') f.patch('hostedProjects', f.projectId, { visibility: 'private' });
    if (turn === 'is removed') f.patch('hostedProjects', f.projectId, { removal: 'trash' });
    const sent = await poster.statusToPost(asPoster(f), queued);
    if (turn === 'stays public') {
      assert.equal(sent.link, readable(f));
      assert.equal(sent.description, secretDetail);
    } else {
      assert.equal(sent.link, opaque(f));
      assert.equal(sent.description, `GITHUB_SYNC_REJECTED: ${check.openLane}`);
      assert.doesNotMatch(JSON.stringify(sent), /secret|ada|tide/);
    }
  });
}

test('d357d772: a recorded public-form failure is reposted as the fixed sentence once the project is private', async t => {
  const f = await fixture(t, 'private');
  const failed = job(f, { statusPost: { state: 'failure', description: secretDetail, error: 'HTTP 500' } });
  f.insert('projectGithubMirrors', {
    projectId: f.projectId,
    repository: 'synthetic/mirror',
    activeId: null,
    mapping: null,
    verifyFailedId: failed,
  });
  assert.equal(await run(f, 'repost', ctx => repostPullStatus(ctx, f.projectId)), true);
  assert.equal(posted(f).description, 'Forge check failed.');
  assert.equal(posted(f).link, opaque(f));
});

// Review round (receipt 0334007f follow-up): payloads queued before the check carry no mark; a private queue is marked
// and reads nothing; a recorded description is kept for a private project only when it is already the private form.
test('d357d772: a payload queued before the post-time check is read, and a private one is redacted', async t => {
  const f = await fixture(t, 'private');
  const legacy = { projectId: f.projectId, state: 'failure', description: secretDetail, link: readable(f) };
  assert.deepEqual(await poster.statusToPost(asPoster(f), legacy), {
    description: 'Forge check failed.',
    link: null,
  });
  const pub = await fixture(t, 'public');
  const same = { projectId: pub.projectId, state: 'failure', description: secretDetail, link: readable(pub) };
  assert.deepEqual(await poster.statusToPost(asPoster(pub), same), {
    description: secretDetail,
    link: readable(pub),
  });
});

test('d357d772: a status queued private is marked and its post reads nothing', async t => {
  const f = await fixture(t, 'private');
  const failing = job(f, {});
  await run(f, 'settle', async ctx =>
    queue.settlePull(ctx, await ctx.db.get(failing), 'failure', secretDetail),
  );
  const queued = posted(f);
  assert.equal(queued.checked, true);
  assert.equal(queued.privateForm, undefined);
  const noRead = { runQuery: () => assert.fail('a private queue must not read the project') };
  assert.equal((await poster.statusToPost(noRead, queued)).link, opaque(f));
});

test('d357d772: only the private form is safe to repost for a private project', () => {
  const safe = [
    'Forge check failed.',
    'GITHUB_SYNC_REJECTED: Open the Lane in Forge for details.',
    'Forge could not start the check (CHECK_UNAVAILABLE). Open the Lane in Forge for details.',
    'Does not apply to Forge main (STATE_CONFLICT). Open the Lane in Forge for details.',
  ];
  for (const text of safe) assert.equal(check.isPrivateSafeDescription(text), true, text);
  const unsafe = [
    secretDetail,
    'GITHUB_SYNC_FAILED: Worker failed in synthetic/private. Open the Lane in Forge for details.',
    'Forge could not start the check (see ada/tide-pool). Open the Lane in Forge for details.',
  ];
  for (const text of unsafe) assert.equal(check.isPrivateSafeDescription(text), false, text);
});
