// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { fixture, NOW } from './public-discovery-fixture.mjs';
import { fakeR2Config, startFakeR2 } from './fake-r2.mjs';

const { run } = await import(moduleUrl('../convex/publicSnapshotWorker.ts'));
const visibility = await import(moduleUrl('../convex/projectVisibility.ts'));
const directorySource = await import(moduleUrl('../convex/publicDirectorySource.ts'));
const publicRead = await import(moduleUrl('../convex/publicRead.ts'));
const publicProfileDependencies = await import(moduleUrl('../convex/publicProfileDependencies.ts'));
const jobs = await import(moduleUrl('../convex/publicSnapshotJobs.ts'));
const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const discovery = await import(moduleUrl('../convex/publicDiscovery.ts'));
const accounts = await import(moduleUrl('../convex/urlAccounts.ts'));
const accountClose = await import(moduleUrl('../convex/accountClose.ts'));
const operator = await import(moduleUrl('../convex/projectBoardOperator.ts'));
const minute = 60_000;

function schedulerFixture(t, options) {
  const { tables, ctx } = fixture(options);
  tables.publicSnapshotJobs = new Map();
  tables.publicProfileDependencies = new Map();
  tables.publicDirectoryChanges = new Map();
  tables.personDays = new Map();
  const tasks = new Map();
  let now = NOW;
  let number = 0;
  const previous = process.env.FORGE_PUBLIC_SNAPSHOTS;
  process.env.FORGE_PUBLIC_SNAPSHOTS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_PUBLIC_SNAPSHOTS;
    else process.env.FORGE_PUBLIC_SNAPSHOTS = previous;
  });
  t.mock.method(Date, 'now', () => now);
  const schedule = (at, fn, args) => {
    const id = `task-${++number}`;
    tasks.set(id, { at, fn: getFunctionName(fn), args, state: { kind: 'pending' } });
    return id;
  };
  Object.assign(ctx.scheduler, {
    runAt: async (...args) => schedule(...args),
    runAfter: async (delay, ...args) => schedule(now + delay, ...args),
    cancel: async id => {
      tasks.get(id).state = { kind: 'canceled' };
    },
  });
  ctx.meta = { getRequestMetadata: async () => ({ scheduledFunctionId: null }) };
  ctx.db.system.get = async id => tasks.get(id) ?? null;
  const row = key => [...tables.publicSnapshotJobs.values()].find(job => job.key === key);
  return {
    ctx,
    tables,
    row,
    tasks,
    setTime: time => {
      now = time;
    },
    event: urgent => jobs.queueProjectSnapshots(ctx, tables.hostedProjects.get('project'), urgent),
    next: key => tasks.get(row(key).task),
    settle: (args, ok) => jobs.settle._handler(ctx, { ...args, ok }),
    claim: ({ args, state }) => {
      state.kind = 'inProgress';
      return jobs.claim._handler(ctx, args);
    },
  };
}

test('change-triggered job deadlines are fixed, privacy supersedes old work and confirmation waits for both purges', async t => {
  const f = schedulerFixture(t);
  await f.event(false);
  assert.equal(f.next('directory').at, NOW + 10 * minute);
  assert.equal(f.next('project/ada/atlas').at, NOW + minute);
  assert.equal(f.next('profile/ada').at, NOW + minute);
  f.setTime(NOW + 15_000);
  const old = f.next('directory');
  await f.event(false);
  assert.equal(f.next('directory'), old);
  assert.equal(f.tasks.size, 3, 'later dirty events use the same three scheduled keys');
  f.setTime(NOW + 10 * minute);
  await f.claim(old);
  await f.event(true);
  const urgent = f.next('directory');
  assert.equal(urgent.at, NOW + 10 * minute, 'revocation never waits for the coalescing window');
  assert.equal(await jobs.current._handler(f.ctx, old.args), false);
  await f.settle(old.args, true);
  assert.equal(f.next('directory'), urgent, 'a stale completion cannot clear the newer revocation');
  await f.claim(urgent);
  await f.settle(urgent.args, false);
  assert.equal(f.row('directory').urgent, true);
  const retry = f.next('directory');
  assert.equal(retry.at, NOW + 10 * minute + 1_000);
  f.setTime(retry.at);
  await f.claim(retry);
  await f.settle(retry.args, true);
  const second = f.next('directory');
  assert.equal(second.at, retry.at + 30_000);
  assert.equal(f.row('directory').step, 'purgeAgain');
  assert.equal(f.row('directory').urgent, true);
  f.setTime(second.at);
  await f.claim(second);
  await f.settle(second.args, true);
  assert.equal(f.row('directory').phase, 'idle');
  assert.equal(f.row('directory').urgent, false);
  assert.equal(f.row('directory').task, undefined, 'confirmed work creates no recurring wake');
});

test('an exhausted urgent job alerts once, remains unconfirmed and leaves no recurring wake', async t => {
  const f = schedulerFixture(t);
  const error = t.mock.method(console, 'error', () => {});
  await f.event(true);
  const key = 'project/ada/atlas';
  const delays = [];
  for (let failure = 0; failure < 7; failure++) {
    const task = f.next(key);
    f.setTime(task.at);
    await f.claim(task);
    await f.settle(task.args, false);
    if (failure < 6) delays.push(f.next(key).at - task.at);
    else await f.settle(task.args, false);
  }
  assert.deepEqual(delays, [1000, 4000, 16000, 64000, 256000, 300000]);
  const failed = f.row(key);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.task, undefined);
  assert.equal(failed.confirmedGeneration, undefined);
  assert.equal(error.mock.callCount(), 1);
  await f.event(false);
  assert.equal(f.row(key).phase, 'failed', 'ordinary activity cannot restart a failed revocation');
  const resume = { id: failed._id, serial: failed.serial };
  assert.equal(await jobs.resumeFailed._handler(f.ctx, resume), true);
  assert.equal(await jobs.resumeFailed._handler(f.ctx, resume), false);
  assert.equal(f.row(key).generation, failed.generation);
});

async function publishingFixture(t, options) {
  const f = schedulerFixture(t, options);
  const r2 = await startFakeR2(fakeR2Config, { local: true });
  t.after(() => r2.close());
  const variables = {
    R2_ACCOUNT_ID: fakeR2Config.accountId,
    R2_BUCKET: fakeR2Config.bucket,
    R2_ACCESS_KEY_ID: fakeR2Config.accessKeyId,
    R2_SECRET_ACCESS_KEY: fakeR2Config.secretAccessKey,
    R2_ENDPOINT: r2.endpoint,
    CONVEX_CLOUD_URL: 'https://example.convex.cloud',
    FORGE_WEB_URL: 'https://site.example',
    FORGE_PUBLIC_SNAPSHOT_ZONE: 'a'.repeat(32),
    FORGE_PUBLIC_SNAPSHOT_PURGE_TOKEN: 'synthetic-only',
  };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const fetch = globalThis.fetch;
  const purged = new Map();
  const refused = [];
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(input);
    if (url.origin === r2.endpoint) return fetch(input, init);
    assert.equal(url.hostname, 'api.cloudflare.com');
    const failure = refused.shift();
    if (failure) return Promise.resolve(new Response(null, { status: failure }));
    for (const key of JSON.parse(init.body).files) purged.set(key, (purged.get(key) ?? 0) + 1);
    return Promise.resolve(Response.json({ success: true }));
  });
  const internal = {
    publicSnapshotJobs: jobs,
    publicRead,
    publicDirectorySource: directorySource,
    publicProfileDependencies,
    projectBoardOperator: operator,
  };
  f.ctx.runQuery = f.ctx.runMutation = (ref, args) => {
    const [module, name] = getFunctionName(ref).split(':');
    return internal[module][name]._handler(f.ctx, args);
  };
  const execute = async task => {
    f.setTime(task.at);
    task.state = { kind: 'inProgress' };
    if (task.fn === 'publicSnapshotWorker:run') await run._handler(f.ctx, task.args);
    else {
      const [module, name] = task.fn.split(':');
      await internal[module][name]._handler(f.ctx, task.args);
    }
    task.state = { kind: 'success' };
  };
  const start = key => execute(f.next(key));
  const pages = async name => {
    for (const task of f.tasks.values())
      if (task.state.kind === 'pending' && task.fn === `publicProfileDependencies:${name}`)
        await execute(task);
  };
  const drain = async () => {
    for (let step = 0; step < 70; step++) {
      const task = [...f.tasks.values()]
        .filter(
          task =>
            task.state.kind === 'pending' &&
            /^(publicSnapshotWorker:run|publicSnapshotJobs:ownerPage|publicProfileDependencies:|projectBoardOperator:relist)/.test(
              task.fn,
            ),
        )
        .sort((a, b) => a.at - b.at)[0];
      if (!task) return;
      await execute(task);
    }
    assert.fail('publication failed to settle');
  };
  return {
    ...f,
    start,
    pages,
    drain,
    r2,
    purged,
    refused,
    read: key => JSON.parse(r2.objects.get(r2.key(`public-pages/v1/${key}.json`))),
  };
}

test('private flip stays unconfirmed after a failed tombstone and until every serving surface is purged twice', async t => {
  const f = await publishingFixture(t);
  const { r2, start, pages, purged } = f;
  const project = 'project/ada/atlas';
  const profile = 'profile/ada';
  const member = 'profile/jo';
  const memberKey = r2.key(`public-pages/v1/${member}.json`);
  f.tables.forgeAccounts.set('memberAccount', { _id: 'memberAccount', owner: 'member', handle: 'jo' });
  f.tables.accountHandles.set('memberAlias', { _id: 'memberAlias', owner: 'member', handle: 'jo' });
  f.tables.personDays.set('memberDay', {
    _id: 'memberDay',
    person: 'member',
    day: '2026-11-17',
    value: JSON.stringify({ p: { project: { l: 1, la: 0, n: 0, na: 0, v: 0, t: [NOW, NOW], r: {} } } }),
  });
  const projectKey = r2.key(`public-pages/v1/${project}.json`);
  const args = {
    projectId: 'project',
    expectedRevision: f.tables.hostedProjects.get('project').revision,
    operationId: 'hide-atlas',
    visibility: 'private',
  };
  const pending = () => visibility.hidePending._handler(f.ctx, { projectId: args.projectId });
  await f.event(false);
  await jobs.queueProjectSnapshots(
    f.ctx,
    { ...f.tables.hostedProjects.get('project'), owner: 'member', slug: 'other' },
    false,
  );
  for (const key of [project, profile, member, 'directory']) await start(key);
  assert.equal(JSON.parse(r2.objects.get(projectKey)).state, 'public');
  assert.equal(JSON.parse(r2.objects.get(memberKey)).contributions.projects[0].slug, 'atlas');
  await visibility.setVisibility._handler(f.ctx, args);
  const firstHide = f.next(project);
  await visibility.setVisibility._handler(f.ctx, args);
  assert.equal(f.next(project), firstHide, 'the same operation schedules no duplicate revocation');
  assert.equal(await pending(), true);
  const owner = f.ctx.auth.getUserIdentity;
  f.ctx.auth.getUserIdentity = async () => ({ subject: 'outsider' });
  assert.equal(await pending(), false);
  f.ctx.auth.getUserIdentity = owner;
  await pages('revokePage');
  f.refused.push(429);
  await start(member);
  assert.equal(JSON.parse(r2.objects.get(memberKey)).state, 'hidden');
  assert.equal(f.row(member).step, 'blankProfile', 'a refused purge delays the rewrite and confirmation');
  assert.equal(await pending(), true);
  await start(member);
  assert.equal(purged.get('https://site.example/jo?forge-cache=public-pages-v1'), 1);
  await start(member);
  const rewritten = JSON.parse(r2.objects.get(memberKey));
  assert.equal(rewritten.state, 'public');
  assert.deepEqual(rewritten.contributions.projects, []);
  assert.equal(rewritten.contributions.totals.landings, 0);
  r2.failPuts = 1;
  await start(project);
  assert.equal(JSON.parse(r2.objects.get(projectKey)).state, 'public');
  assert.equal(await pending(), true);
  for (const key of [project, profile, 'directory']) await start(key);
  assert.equal(JSON.parse(r2.objects.get(projectKey)).state, 'hidden');
  assert.deepEqual(JSON.parse(r2.objects.get(r2.key('public-pages/v1/sitemap.json'))).projects, []);
  await start(profile); // rewrite, followed by the second purge
  for (const key of [project, profile, 'directory']) await start(key);
  assert.equal(await pending(), true, 'the member profile second purge is still pending');
  await start(member);
  await pages('confirmPage');
  assert.equal(await pending(), false);
  for (const path of [
    '/ada/atlas',
    '/ada',
    '/jo',
    '/sitemap.xml',
    '/explore',
    '/-/public/v1/explore/active/8.json',
  ])
    assert.equal(purged.get(`https://site.example${path}?forge-cache=public-pages-v1`), 2);
});

for (const [name, change, address, redacted] of [
  ['trash', (ctx, input) => lifecycle.trash._handler(ctx, input), null, 'all'],
  [
    'project rename',
    (ctx, input) => lifecycle.rename._handler(ctx, { ...input, name: 'Renamed', slug: 'renamed' }),
    'ada/renamed',
    'old',
  ],
  [
    'handle rename',
    (ctx, input) => accounts.set._handler(ctx, { handle: 'ada-new', operationId: input.operationId }),
    'ada-new/atlas',
    'old',
  ],
  [
    'suspension',
    ctx =>
      operator.applySwitch(ctx, { scope: 'account', owner: 'owner', off: true, reason: 'Synthetic test' }),
    null,
    'all',
  ],
  [
    'members-only Plan',
    (ctx, input) => discovery.setSettings._handler(ctx, { ...input, planVisibility: 'members' }),
    'ada/atlas',
    'plan',
  ],
  [
    'Lane title opt-out',
    (ctx, input) => discovery.setSettings._handler(ctx, { ...input, laneTitles: false }),
    'ada/atlas',
    'lanes',
  ],
]) {
  test(`${name} revokes affected snapshots through the scheduler and purges serving keys`, async t => {
    const f = await publishingFixture(t, { laneTitles: true });
    await f.event(false);
    await f.drain();
    const old = 'project/ada/atlas';
    assert.equal(f.read(old).state, 'public');
    assert.match(JSON.stringify(f.read(old)), /Secret Lane title/);
    assert.deepEqual(f.read('sitemap').projects, [['ada', 'atlas']]);
    await change(f.ctx, {
      projectId: 'project',
      operationId: 'change',
      expectedRevision: f.tables.hostedProjects.get('project').revision,
    });
    await f.drain();
    assert.equal(f.purged.get('https://site.example/ada/atlas?forge-cache=public-pages-v1'), 2);
    assert.equal(
      f.purged.get('https://site.example/-/public/v1/project/ada/atlas.json?forge-cache=public-pages-v1'),
      2,
    );
    if (redacted === 'all' || redacted === 'old') {
      assert.equal(f.read(old).state, 'hidden');
      assert.deepEqual(f.read('sitemap').projects, address ? [address.split('/')] : []);
      assert.equal(f.purged.get('https://site.example/sitemap.xml?forge-cache=public-pages-v1'), 2);
    } else if (redacted === 'plan') assert.deepEqual(f.read(old).plan, { shown: false });
    else assert.deepEqual(f.read(old).lanes.titles, []);
    if (address) assert.equal(f.read(`project/${address}`).state, 'public');
    if (name === 'handle rename') {
      assert.equal(f.read('profile/ada').state, 'hidden');
      assert.equal(f.read('profile/ada-new').state, 'public');
    }
    if (name === 'trash') {
      await lifecycle.restore._handler(f.ctx, {
        projectId: 'project',
        operationId: 'restore',
        expectedRevision: f.tables.hostedProjects.get('project').revision,
      });
      await f.drain();
      assert.equal(f.read(old).state, 'public');
      assert.deepEqual(f.read('sitemap').projects, [['ada', 'atlas']]);
    }
  });
}

test('starting account closure tombstones its public profile and purges both copies', async t => {
  const f = await publishingFixture(t);
  const profile = 'profile/jo';
  f.tables.forgeAccounts.set('memberAccount', {
    _id: 'memberAccount',
    _creationTime: NOW,
    owner: 'member',
    handle: 'jo',
  });
  f.tables.accountHandles.set('memberAlias', {
    _id: 'memberAlias',
    _creationTime: NOW,
    owner: 'member',
    handle: 'jo',
  });
  await jobs.queueProjectSnapshots(
    f.ctx,
    { ...f.tables.hostedProjects.get('project'), owner: 'member', slug: 'other' },
    false,
  );
  await f.drain();
  assert.equal(f.read(profile).state, 'public');
  assert.deepEqual(
    await accountClose.closeFor._handler(f.ctx, {
      owner: 'member',
      handle: 'jo',
      operationId: '00000000-0000-4000-8000-000000000003',
    }),
    { stage: 'closing' },
  );
  await f.drain();
  assert.equal(f.read(profile).state, 'hidden');
  assert.equal(f.purged.get('https://site.example/jo?forge-cache=public-pages-v1'), 2);
  assert.equal(
    f.purged.get('https://site.example/-/public/v1/profile/jo.json?forge-cache=public-pages-v1'),
    2,
  );
});

test('a lost action lease retries the same generation once; a finished lease does not create work', async t => {
  const f = schedulerFixture(t);
  await f.event(true);
  const urgent = f.next('project/ada/atlas');
  const claimed = await f.claim(urgent);
  const recovery = f.next('project/ada/atlas');
  f.setTime(recovery.at);
  await jobs.lost._handler(f.ctx, recovery.args);
  const retry = f.next('project/ada/atlas');
  assert.notEqual(retry, urgent);
  assert.equal(f.row('project/ada/atlas').generation, claimed.generation);
  await jobs.lost._handler(f.ctx, recovery.args);
  assert.equal(f.next('project/ada/atlas'), retry);
});

function withoutEdgePurge(t, mode) {
  const names = [
    'FORGE_PUBLIC_SNAPSHOT_ZONE',
    'FORGE_PUBLIC_SNAPSHOT_PURGE_TOKEN',
    'FORGE_PUBLIC_SNAPSHOT_PURGE',
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  if (mode) process.env.FORGE_PUBLIC_SNAPSHOT_PURGE = mode;
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
}

test('dev incident: a deployment with no purge binding stops at its first attempt, alerts once and keeps the owner profile hidden', async t => {
  const f = await publishingFixture(t);
  const error = t.mock.method(console, 'error', () => {});
  withoutEdgePurge(t);
  await f.event(true);
  await f.start('profile/ada');
  const row = f.row('profile/ada');
  assert.equal(
    f.read('profile/ada').state,
    'hidden',
    'a revocation that cannot purge never serves the old copy',
  );
  assert.deepEqual([row.phase, row.attempt, row.task], ['failed', 1, undefined]);
  assert.equal(error.mock.callCount(), 1);
  assert.equal(f.purged.size, 0);
});

test('dev incident: with the explicit TTL mode the owner profile is hidden, rewritten and confirmed without a purge call', async t => {
  const f = await publishingFixture(t);
  withoutEdgePurge(t, 'ttl');
  await f.event(true);
  await f.start('profile/ada');
  assert.equal(f.read('profile/ada').state, 'hidden');
  await f.start('profile/ada');
  assert.equal(f.read('profile/ada').state, 'public', 'the redacted profile replaces the tombstone');
  const second = f.next('profile/ada');
  assert.equal(second.at, NOW + 60_000, 'the edge lifetime plus the longest in-flight fill');
  await f.drain();
  for (const key of ['profile/ada', 'project/ada/atlas', 'directory']) {
    const row = f.row(key);
    assert.deepEqual([row.phase, row.urgent, row.confirmedGeneration], ['idle', false, row.generation]);
  }
  assert.equal(f.purged.size, 0, 'no provider call is made without a binding');
});

test('a configured purge binding wins over the TTL mode and keeps the 30-second second purge', async t => {
  const f = await publishingFixture(t);
  process.env.FORGE_PUBLIC_SNAPSHOT_PURGE = 'ttl';
  t.after(() => delete process.env.FORGE_PUBLIC_SNAPSHOT_PURGE);
  await f.event(true);
  await f.start('project/ada/atlas');
  assert.equal(f.next('project/ada/atlas').at, NOW + 30_000);
  assert.ok(f.purged.size > 0);
});
