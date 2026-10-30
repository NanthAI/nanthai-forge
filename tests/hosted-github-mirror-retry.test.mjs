// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { prepareMirror } from '../dist/hosted-github-mirror.js';
import { githubRequest } from '../dist/hosted-github-api.js';
import { hostedMirrorStatusText } from '../dist/hosted-github-mirror-status.js';
import { readHostedCliStatus } from '../dist/hosted-cli-status.js';
const queue = await import(moduleUrl('../convex/projectGithubMirrorQueue.ts'));
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));
const action = await import(moduleUrl('../convex/projectGithubMirror.ts'));
const { githubMirrorStatus } = await import(moduleUrl('../convex/projectGithubMirrorStatus.ts'));
const agent = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const { HostedMirrorStatus } = await import(moduleUrl('../web/src/cockpit/HostedMirrorStatus.tsx'));
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

test('unconfigured server projects do not read mirror storage or require mirror tables', async () => {
  const status = await githubMirrorStatus(
    { db: { query: () => assert.fail('unconfigured mirror read') } },
    {
      sourceAuthority: { mode: 'server', epoch: 1 },
      autonomyPolicy: policyPreset('supervised'),
    },
  );
  assert.equal(status, null);
});

async function fixture(t, fail, source) {
  const f = lanesFixture(),
    github = mirrorFixture(source),
    scheduled = [],
    tasks = new Map();
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
    ctx.db.system = { get: async id => tasks.get(id) ?? null };
    ctx.scheduler = {
      runAfter: async (delay, ref, args) => {
        const _id = `task-${scheduled.length}`;
        scheduled.push({ delay, name: getFunctionName(ref), args });
        tasks.set(_id, { _id, scheduledTime: Date.now() + delay, state: { kind: 'pending' } });
        return _id;
      },
      cancel: async id => {
        tasks.get(id).state = { kind: 'canceled' };
      },
    };
  });
  const run = (fn, input) => f.transaction('mirrorRetry', fn, input);
  await run({
    _handler: async ctx =>
      queue.enqueueGithubMirror(ctx, await ctx.db.get(projectId), {
        id: github.seed.acceptanceId,
        authorityEpoch: 1,
        snapshot: { revision: 1 },
        candidate: { head: github.head },
      }),
  });
  const input = scheduled[0].args,
    cursor = 'retained-cursor';
  f.patch('projectGithubMirrorJobs', input.jobId, { cursor });
  const storage = new Map([
    [cursor, new Blob([JSON.stringify(await prepareMirror(github.seed, github.io))])],
  ]);
  for (const [id, bytes] of github.objects) storage.set(id, new Blob([bytes]));
  const originalFetch = globalThis.fetch;
  const values = {
    FORGE_GITHUB_REPO_BINDINGS: `${projectId}=synthetic/mirror`,
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }),
  };
  const prior = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/installation')) return Response.json({ id: 42 });
    if (url.includes('/access_tokens')) return Response.json({ token: 'synthetic-token' });
    if (url.endsWith('/blobs') && fail()) return new Response('synthetic private response', { status: 500 });
    return Response.json(
      await github.io.api(new URL(url).pathname, init.method, init.body && JSON.parse(init.body)),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const methods = { begin: store.begin, commit: store.commit, failed: store.failed };
  const ctx = {
    runMutation: (ref, args) => run(methods[getFunctionName(ref).split(':')[1]], args),
    runQuery: async (_ref, args) =>
      JSON.stringify(
        args.digests.map(id => ({
          descriptor: { object: { sha256: id, size: storage.get(id).size }, recipe: null },
          storageId: id,
          url: null,
        })),
      ),
    storage: {
      get: async id => storage.get(id),
      store: async blob => {
        const id = `cursor-${storage.size}`;
        storage.set(id, blob);
        return id;
      },
    },
  };
  const job = () => f.tables.projectGithubMirrorJobs.get(input.jobId);
  const status = () => run({ _handler: async ctx => githubMirrorStatus(ctx, await ctx.db.get(projectId)) });
  return {
    ...f,
    github,
    projectId,
    run,
    input,
    cursor,
    scheduled,
    tasks,
    ctx,
    job,
    status,
    step: args => action.step._handler(ctx, args ?? scheduled.at(-1).args),
  };
}

test('real action: HTTP 500 retains the cursor, schedules one backoff, then succeeds and goes idle', async t => {
  let failures = 1;
  const f = await fixture(t, () => failures-- > 0);
  await f.step();
  assert.equal(f.job().status, 'retrying');
  assert.equal(f.job().cursor, f.cursor);
  assert.equal(f.job().failures, 1);
  assert.equal(f.scheduled.at(-1).delay, 60_000);
  assert.equal(f.job().httpStatus, 500);
  assert.equal(f.job().apiOperation, 'POST git/blobs');
  assert(f.job().requestBytes > 0);
  await f.step();
  assert.equal(f.job().status, 'done');
  assert.equal(f.job().failures, 0);
  assert.equal(f.job().error, undefined);
  assert.equal(f.scheduled.length, 2, 'no timer after recovery');
  assert.equal(f.github.commits.size, 2);
  await f.step(f.input);
  assert.equal(f.scheduled.length, 2, 'late worker is fenced');
});

test('a 500 after verified blob replies checkpoints partial progress instead of repeating the whole window', async t => {
  let requests = 0;
  const f = await fixture(t, () => ++requests === 2, { before: {}, after: { a: 'first', b: 'second' } });
  await f.step();
  assert.equal(f.job().status, 'retrying');
  assert.notEqual(f.job().cursor, f.cursor);
  await f.step();
  assert.equal(f.job().status, 'done');
  assert.equal(requests, 3, 'the first successful blob is not posted again');
  assert.equal(f.github.calls.filter(call => call.path.endsWith('/blobs')).length, 2);
});

test('partial cursor storage failure still records the API failure and retries the retained cursor visibly', async t => {
  let requests = 0;
  const f = await fixture(t, () => ++requests === 2, { before: {}, after: { a: 'first', b: 'second' } });
  f.ctx.storage.store = async () => {
    throw Error('synthetic storage failure');
  };
  await f.step();
  assert.equal(f.job().status, 'retrying');
  assert.equal(f.job().cursor, f.cursor);
  assert.match(f.job().detail, /HTTP 500.*Partial progress could not be checkpointed/);
  await f.step();
  assert.equal(f.job().status, 'done');
});

test('real action: five persistent 500s end terminal, visible in CLI and Now, with zero idle retries', async t => {
  const f = await fixture(t, () => true);
  for (let i = 0; i < 5; i++) await f.step();
  assert.deepEqual(
    f.scheduled.map(s => s.delay),
    [0, 60_000, 120_000, 240_000, 480_000],
  );
  assert.equal(
    f.scheduled.reduce((n, s) => n + s.delay, 0),
    15 * 60_000,
  );
  assert.equal(f.job().status, 'failed');
  assert.equal(f.job().failures, 5);
  assert.equal(f.job().nextAttemptAt, undefined);
  assert.equal(f.job().cursor, f.cursor);
  const status = await f.status();
  assert.equal(status.status, 'failed');
  assert.equal(status.lagging, true);
  assert.match(hostedMirrorStatusText(status, Date.now()), /failed.*behind.*5\/5.*HTTP 500.*request bytes/);
  const html = renderToStaticMarkup(createElement(HostedMirrorStatus, { status, now: Date.now() }));
  assert.match(html, /role="status"/);
  assert.match(html, /failed.*5\/5.*HTTP 500/);
  const capabilities = JSON.parse(
    await f.run(agent.capabilities, { projectId: f.projectId, mirrorVersion: 1 }),
  );
  assert.deepEqual(capabilities.githubMirror, status);
  const legacy = JSON.parse(await f.run(agent.capabilities, { projectId: f.projectId }));
  assert.equal(legacy.githubMirror, undefined, 'legacy strict capability readers retain their shape');
  const client = agentFixture(t);
  client.caps.githubMirror = capabilities.githubMirror;
  const cli = await readHostedCliStatus(client.root, client.transport());
  assert.equal(cli.value.githubMirror.status, 'failed');
  assert.match(cli.text, /failed.*5\/5.*HTTP 500/);
  assert.equal(
    client.calls.filter(c => c.name === 'projectHostedAgent:capabilities').length,
    1,
    'one finite status call',
  );
  await f.step();
  assert.equal(f.scheduled.length, 5, 'terminal failure schedules nothing');
});

test('dogfood-size retained mirror history costs only selected status rows and no writes', async t => {
  const f = await fixture(t, () => true);
  for (let i = 0; i < 1000; i++)
    f.insert('projectGithubMirrorJobs', {
      projectId: f.projectId,
      receiptId: `historical-${i}`,
      authorityEpoch: 1,
      sequence: i + 2,
      repository: 'synthetic/mirror',
      status: 'done',
      step: 1,
      cursor: null,
      state: 'a'.repeat(64),
    });
  const start = performance.now();
  await f.status();
  const count = f.counts.at(-1);
  assert.equal(count.documents, 4, 'project + queue + main + active job, independent of history');
  assert.equal(count.writes, 0);
  t.diagnostic(
    JSON.stringify({
      retainedJobs: 1001,
      calls: 1,
      documents: count.documents,
      writes: count.writes,
      readBytes: count.readBytes,
      elapsedMs: performance.now() - start,
      rssBytes: process.memoryUsage().rss,
    }),
  );
});

test('resume replaces a failed job stale inProgress task and fences its late failure and commit', async t => {
  const f = await fixture(t, () => true);
  f.patch('projectGithubMirrorJobs', f.input.jobId, { status: 'failed', error: 'GITHUB_SYNC_API' });
  const task = f.tasks.get(f.job().scheduledId);
  task.state = { kind: 'inProgress' };
  const resumed = await f.run(store.resume, { jobId: f.input.jobId });
  assert.equal(resumed.status, 'scheduled');
  assert.equal(task.state.kind, 'canceled');
  assert.equal(f.job().cursor, f.cursor);
  assert.equal(f.job().step, f.input.step + 1);
  await f.run(store.failed, { ...f.input, code: 'GITHUB_SYNC_API', detail: 'late', httpStatus: 500 });
  await f.run(store.commit, { ...f.input, cursor: 'late-cursor', mapping: null });
  assert.equal(f.job().status, 'running');
  assert.equal(f.job().cursor, f.cursor);
  assert.equal(f.scheduled.length, 2);
  assert.equal((await f.run(store.resume, { jobId: f.input.jobId })).status, 'already-running');
  assert.equal(f.scheduled.length, 2, 'fresh pending worker is not duplicated');
});

test('explicit resume recovers an overdue task or a missing scheduled record without losing its cursor', async t => {
  const f = await fixture(t, () => true);
  const task = f.tasks.get(f.job().scheduledId);
  task.state = { kind: 'inProgress' };
  task.scheduledTime = Date.now() - 12 * 60_000;
  await f.run(store.resume, { jobId: f.input.jobId });
  assert.equal(task.state.kind, 'canceled');
  f.tasks.delete(f.job().scheduledId);
  await f.run(store.resume, { jobId: f.input.jobId });
  assert.equal(f.scheduled.length, 3);
  assert.equal(f.job().cursor, f.cursor);
});

test('429 retries; 401 is terminal; duplicate failures cannot spend an attempt twice', async t => {
  const f = await fixture(t, () => false);
  await f.run(store.failed, { ...f.input, code: 'GITHUB_SYNC_API', detail: '429', httpStatus: 429 });
  await f.run(store.failed, { ...f.input, code: 'GITHUB_SYNC_API', detail: 'duplicate', httpStatus: 429 });
  assert.equal(f.job().failures, 1);
  assert.equal(f.scheduled.length, 2);
  await f.run(store.failed, {
    ...f.scheduled.at(-1).args,
    code: 'GITHUB_SYNC_API',
    detail: '401',
    httpStatus: 401,
  });
  assert.equal(f.job().status, 'failed');
  assert.equal(f.scheduled.length, 2);
});

test('API diagnostics count exact UTF-8 request bytes without printing credentials, paths or bodies', async () => {
  const payload = { content: 'synthetic π', encoding: 'utf-8' };
  await assert.rejects(
    githubRequest('private-token', async () => new Response('private-body', { status: 500 }))(
      '/repos/private-token/repo/git/blobs?private-query',
      'POST',
      payload,
    ),
    e => {
      assert.equal(e.status, 500);
      assert.equal(e.requestBytes, Buffer.byteLength(JSON.stringify(payload)));
      assert(!/private-token|private-body|private-query|synthetic/.test(e.message));
      return true;
    },
  );
});
