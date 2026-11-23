// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 0a99ab23: approval links open the page that decides them. A Lane's request and a held landing link to
// /<handle>/<slug>/lanes/<id> under the app root; a settings request links to Needs me; a project without an address
// keeps the /approve form, and /approve itself is one lookup (urlProjects:approvalTarget) that names the Lane page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { policyPreset as preset } from '../dist/autonomy-policy.js';
const { APP_ROOT, approvalPath } = await import(moduleUrl('../src/project-routes.ts'));
const { ROOT, hrefFor, isPublicProjectView, parseAppPath } = await import(
  moduleUrl('../web/src/app/paths.ts')
);
const laneReview = await import(moduleUrl('../convex/projectLaneReview.ts'));
const { approveLinkArgs, approveTargetHref } = await import(moduleUrl('../web/src/app/ApproveRedirect.tsx'));
const approvals = await import(moduleUrl('../convex/projectHostedApprovals.ts'));
const review = await import(moduleUrl('../convex/projectHostedOwnerReview.ts'));
const urls = await import(moduleUrl('../convex/urlProjects.ts'));
const needsMe = await import(moduleUrl('../convex/projectNeedsMe.ts'));
const { settingReply } = await import(moduleUrl('../convex/projectSettingApprovals.ts'));
const { needsView } = await import(moduleUrl('../web/src/app/needs/model.ts'));

const web = 'https://forge.example.invalid';
const owner = { subject: 'owner', forgeCredential: 'synthetic-device' };
function environment(t) {
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
}
/** A project with a public address (@ada/tide-pool) and the owner's device. */
async function addressed(t, policy) {
  environment(t);
  const f = await finishFixture(t);
  f.patch('hostedProjects', f.projectId, {
    slug: 'tide-pool',
    ...(policy ? { autonomyPolicy: policy } : {}),
  });
  f.insert('forgeAccounts', { owner: 'owner', handle: 'ada' });
  f.insert('cliCredentials', {
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'Synthetic device',
    tokenHash: 'synthetic-hash',
    issuedAt: 1_790_000_000_000,
    scope: 'cli',
    // Far enough ahead that the fixture's clock never reaches it.
    expiresAt: 4_102_444_800_000,
    revoked: false,
  });
  return f;
}
const laneUrl = laneId => `${web}${APP_ROOT}/ada/tide-pool/lanes/${laneId}`;

test('0a99ab23: the server and the app build approval addresses on one root', () => {
  assert.equal(APP_ROOT, ROOT, 'src/project-routes.ts APP_ROOT and web/src/app/paths.ts ROOT move together');
  const address = { handle: 'ada', slug: 'tide-pool' };
  assert.equal(approvalPath(address, 'p1', 'lane-1'), '/ada/tide-pool/lanes/lane-1');
  assert.equal(
    approvalPath(address, 'p1', 'lane-1', 'sub-1'),
    '/ada/tide-pool/lanes/lane-1?submission=sub-1',
    'a held landing names its exact submission',
  );
  assert.equal(
    approvalPath(address, 'p1', 'setting:policy'),
    '/ada/tide-pool?view=needs',
    "a settings request opens the owner's Needs me",
  );
  assert.equal(
    approvalPath(address, 'p1', null, 'sub-1'),
    '/ada/tide-pool?view=needs',
    'no one Lane: Needs me',
  );
  // Signed out, view=needs asks for sign-in (not the public front page); signed in it is Needs me.
  const needs = parseAppPath('/ada/tide-pool');
  assert.equal(isPublicProjectView(needs, false, 'needs'), false);
  assert.equal(isPublicProjectView(needs, true, 'needs'), false);
  assert.equal(isPublicProjectView(needs, false, null), true, 'a plain front-page visit stays public');
  assert.equal(approvalPath(null, 'p 1', 'setting:policy'), '/approve?project=p+1&lane=setting%3Apolicy');
  assert.equal(approvalPath(null, 'p1', 'lane-1', 'sub-1'), '/approve?project=p1&submission=sub-1');
  // Each address is one the app parses back to the Lane page or Needs me.
  assert.deepEqual(parseAppPath('/ada/tide-pool/lanes/lane-1'), {
    frame: 'project',
    handle: 'ada',
    project: 'tide-pool',
    place: 'lanes',
    section: '',
    rest: 'lane-1',
  });
  assert.equal(parseAppPath('/ada/tide-pool').place, 'needs');
});

test('0a99ab23: /approve is a page of the app that reads its link and names the Lane page', () => {
  const page = { frame: 'public', page: 'approve' };
  assert.deepEqual(parseAppPath(hrefFor(page)), page);
  assert.equal(hrefFor(page), `${ROOT}/approve`);
  const search = value => approveLinkArgs(new URLSearchParams(value));
  assert.deepEqual(search('project=p1&submission=s1'), { projectId: 'p1', submission: 's1' });
  assert.deepEqual(search('project=p1&lane=l1'), { projectId: 'p1', lane: 'l1' });
  assert.equal(search('project=p1'), null, 'a link naming nothing reads nothing');
  assert.equal(search('lane=l1'), null);
  assert.equal(
    approveTargetHref({ handle: 'ada', slug: 'tide-pool', laneId: 'l1' }),
    '/ada/tide-pool/lanes/l1',
  );
  assert.equal(approveTargetHref({ handle: 'ada', slug: 'tide-pool', laneId: null }), '/ada/tide-pool');
  assert.equal(
    approveTargetHref({ handle: 'ada', slug: 'tide-pool', laneId: 'l1' }, 's1'),
    '/ada/tide-pool/lanes/l1?submission=s1',
  );
});

test('0a99ab23: a Lane request links to its Lane page in the reply, the board note, observe and the list', async t => {
  const f = await addressed(t);
  const laneId = f.lane.laneId;
  const ask = {
    projectId: f.projectId,
    operationId: randomUUID(),
    laneId,
    reason: 'billing migration: look first',
  };
  const requested = JSON.parse(await f.tx('request', approvals.request, ask, owner));
  assert.equal(requested.url, laneUrl(laneId));
  const note = [...f.tables.projectBoardMessages.values()].at(-1);
  assert.ok(note.body.includes(laneUrl(laneId)), 'the board note carries the Lane link');
  const observed = JSON.parse(
    await f.tx('observe', approvals.observe, { projectId: f.projectId, laneId }, owner),
  );
  assert.equal(observed.url, laneUrl(laneId));
  const listed = JSON.parse(await f.tx('list', approvals.list, { projectId: f.projectId }, owner));
  assert.deepEqual(
    listed.requests.map(request => request.url),
    [laneUrl(laneId)],
  );
  // The old link's lookup names the same Lane page.
  const target = await f.tx('target', urls.approvalTarget, { projectId: f.projectId, lane: laneId }, 'owner');
  assert.deepEqual(target, { handle: 'ada', slug: 'tide-pool', laneId });
  // The request is asked before the Lane holds a landing: Needs me lists it ahead, so it can be decided there too.
  const view = needsView(await f.tx('needs', needsMe.read, { projectId: f.projectId }, 'owner'));
  assert.deepEqual(
    view.ahead.map(row => [row.laneId, row.needsOwner]),
    [[laneId, true]],
  );
  assert.equal(view.count, 0, 'asked ahead is listed, never counted');
  // The Lane page decides it from its own read's row, for the owner only, and still after a newer save.
  const pageRead = who =>
    f.tx('lane', laneReview.read, { projectId: f.projectId, laneId }, who).then(JSON.parse);
  const page = await pageRead('owner');
  assert.equal(page.request.laneId, laneId);
  assert.equal(page.request.needsOwner, true);
  assert.equal(page.request.state, 'requested');
  // Item 4f1f7984: once granted, Needs me stops listing it; the Lane page still shows it, read-only; settled, neither does.
  const [rowId] = [...f.tables.projectHostedApprovals].find(([, r]) => r.laneId === laneId);
  const decision = {
    projectId: f.projectId,
    operationId: randomUUID(),
    laneId,
    decision: 'grant',
    head: f.lane.head,
  };
  await f.tx('decide', approvals.decide, decision, 'owner');
  assert.deepEqual(
    needsView(await f.tx('needs', needsMe.read, { projectId: f.projectId }, 'owner')).ahead,
    [],
    'a granted request is not asked ahead',
  );
  const granted = await pageRead('owner');
  assert.equal(granted.request.state, 'granted');
  assert.equal(granted.request.needsOwner, false);
  f.patch('projectHostedApprovals', rowId, { live: false, ended: { kind: 'settled', at: 3 } });
  assert.equal((await pageRead('owner')).request, undefined, 'a settled request is not shown');
  // A retry of the recorded decision, after the Lane was set aside, answers the same instead of NOT_FOUND.
  assert.equal(
    JSON.parse(await f.tx('retry', approvals.decide, decision, 'owner')).approval.status,
    'granted',
  );
  f.patch('hostedProjects', f.projectId, { visibility: 'public' });
  assert.equal((await pageRead('reader')).request, undefined, 'a reader who cannot decide gets no request');
});

test('0a99ab23: a held landing links to its Lane page; the /approve submission lookup names the same Lane', async t => {
  const policy = { ...preset('trusted'), agentDefaults: { preflight: 'advise' } };
  policy.acceptance = { ...policy.acceptance, ownerApprovalPaths: ['selected.txt'], admissionCheck: false };
  const f = await addressed(t, policy);
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(state.id)).submission.observation.pendingReason, 'waiting-for-review');
  const link = JSON.parse(
    await f.tx('link', review.link, { projectId: f.projectId, operationId: state.operationId }, owner),
  );
  assert.equal(link.held, true);
  assert.equal(link.url, `${laneUrl(f.lane.laneId)}?submission=${state.id}`);
  assert.equal(link.approver, 'ada');
  const target = await f.tx(
    'target',
    urls.approvalTarget,
    { projectId: f.projectId, submission: state.id },
    'owner',
  );
  assert.deepEqual(target, { handle: 'ada', slug: 'tide-pool', laneId: f.lane.laneId });
  const read = await f.tx('needs', needsMe.read, { projectId: f.projectId }, 'owner');
  const row = read.held.find(entry => entry.submissionId === state.id);
  assert.equal(row.url, `${laneUrl(f.lane.laneId)}?submission=${state.id}`);
});

test('0a99ab23: a settings request opens Needs me; /approve answers only a reader of the project', async t => {
  const f = await addressed(t);
  const row = { projectId: f.projectId, laneId: 'setting:policy', status: 'requested', setting: {} };
  // The write's reply keeps the /approve form with no extra read; the lookup below opens Needs me from it.
  assert.equal(
    settingReply(row).url,
    `${web}/approve?project=${encodeURIComponent(f.projectId)}&lane=setting%3Apolicy`,
  );
  const lookup = (args, who = 'owner') =>
    f.tx('target', urls.approvalTarget, { projectId: f.projectId, ...args }, who);
  assert.deepEqual(await lookup({ lane: 'setting:policy' }), {
    handle: 'ada',
    slug: 'tide-pool',
    laneId: null,
  });
  assert.deepEqual(await lookup({ submission: randomUUID() }), {
    handle: 'ada',
    slug: 'tide-pool',
    laneId: null,
  });
  f.patch('hostedProjects', f.projectId, { visibility: 'private' });
  assert.equal(await lookup({ lane: f.lane.laneId }, 'stranger'), null, 'a private project stays unnamed');
  assert.equal(
    await f.tx('target', urls.approvalTarget, { projectId: 'not-an-id', lane: 'x' }, 'owner'),
    null,
  );
  // A project with no address yet keeps the /approve form for every request.
  f.patch('hostedProjects', f.projectId, { slug: undefined, visibility: 'public' });
  const ask = {
    projectId: f.projectId,
    operationId: randomUUID(),
    laneId: f.lane.laneId,
    reason: 'look first',
  };
  const requested = JSON.parse(await f.tx('request', approvals.request, ask, owner));
  assert.equal(
    requested.url,
    `${web}/approve?project=${encodeURIComponent(f.projectId)}&lane=${encodeURIComponent(f.lane.laneId)}`,
  );
});

test("0a99ab23: a fork run status on GitHub keeps a private project's address out of its link", async t => {
  const f = await addressed(t);
  f.patch('hostedProjects', f.projectId, { visibility: 'private' });
  const { forkGate } = await import(moduleUrl('../convex/projectGithubPullFork.ts'));
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  const laneId = f.lane.laneId;
  const job = (pullKey, receipt) =>
    f.insert('projectGithubMirrorJobs', {
      projectId: f.projectId,
      receiptId: `pull:${receipt}`,
      sequence: 0.5,
      repository: 'synthetic/mirror',
      authorityEpoch: 1,
      status: 'done',
      step: 1,
      cursor: null,
      state: '0'.repeat(64),
      pullKey,
      waitKey: randomUUID(),
      inbound: JSON.stringify({
        phase: 'checking',
        pull: { number: 7, head: 'b'.repeat(40), fork: true },
        laneId,
      }),
    });
  const gate = async (label, jobId) => {
    await f.tx(
      label,
      { _handler: async ctx => forkGate(ctx, await ctx.db.get(jobId), await ctx.db.get(f.projectId)) },
      {},
    );
    return f
      .pending()
      .filter(task => task.name === 'projectGithubPullStatus:post')
      .at(-1).args[0].link;
  };
  const opaque = `${web}/approve?project=${encodeURIComponent(f.projectId)}&lane=${encodeURIComponent(laneId)}`;
  assert.equal(await gate('private', job('7', randomUUID())), opaque, 'private: the opaque lookup form');
  const note = [...f.tables.projectBoardMessages.values()].at(-1);
  assert.ok(note.body.includes(laneUrl(laneId)), 'the board note, inside the project, links the Lane page');
});
