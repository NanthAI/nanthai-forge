// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';

import { policyPreset } from '../dist/autonomy-policy.js';
import { digest } from '../dist/hash.js';
import { prepareMirror, treeChunks, treeChunkBytes } from '../dist/hosted-github-mirror.js';
import { githubRequest } from '../dist/hosted-github-api.js';
import { gitHash } from '../dist/hosted-github-git.js';
import { isRetryable4xx, unexpectedMirrorFailure } from '../dist/hosted-github-retry.js';
import { hostedMirrorStatusText } from '../dist/hosted-github-mirror-status.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { readHostedCliStatus } from '../dist/hosted-cli-status.js';

import { interceptDefaultR2, defaultR2Config, defaultR2Objects } from './default-r2.mjs';
import { workflowTreeRefusal } from './github-api-fake.mjs';
const agent = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const queue = await import(moduleUrl('../convex/projectGithubMirrorQueue.ts'));
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));
const action = await import(moduleUrl('../convex/projectGithubMirror.ts'));
const { githubMirrorStatus } = await import(moduleUrl('../convex/projectGithubMirrorStatus.idle.ts'));
const { stoppedMirror, mirrorRow } = await import(moduleUrl('../convex/projectGithubMirrorRows.ts'));
const { retargetGithubMirror } = await import(moduleUrl('../convex/projectGithubMirrorRetarget.ts'));
const { yieldToInbound } = await import(moduleUrl('../convex/projectGithubInboundQueue.ts'));

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

async function fixture(t, fail, source, respond = () => undefined) {
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
    ctx.db.system = {
      get: async id => tasks.get(id) ?? null,
      normalizeId: (table, ref) => {
        assert.equal(table, '_storage');
        return ref;
      },
    };
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
  const input = scheduled[0].args;
  const cursorBytes = Buffer.from(JSON.stringify(await prepareMirror(github.seed, github.io)));
  // Source bytes are R2 objects in the default bucket; the retained cursor is an R2 source reference.
  const objectUrl = sha =>
    `https://${defaultR2Config.accountId}.r2.cloudflarestorage.com/${defaultR2Config.bucket}/v1/p/${projectId}/o/${sha}`;
  const objectSizes = new Map();
  const put = (sha, bytes) => {
    defaultR2Objects.set(`${defaultR2Config.bucket}/v1/p/${projectId}/o/${sha}`, Buffer.from(bytes));
    objectSizes.set(sha, bytes.length);
  };
  put(digest(cursorBytes), cursorBytes);
  const cursor = `r2source:${digest(cursorBytes)}:${cursorBytes.length}`;
  f.patch('projectGithubMirrorJobs', input.jobId, { cursor });
  for (const [id, bytes] of github.objects) put(id, bytes);
  const originalFetch = globalThis.fetch,
    tokenPermissions = [];
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
    if (new URL(url).hostname.endsWith('.r2.cloudflarestorage.com')) return originalFetch(url, init);
    if (url.endsWith('/installation')) return Response.json({ id: 42 });
    if (url.includes('/access_tokens')) {
      // The mirror push token names contents write, plus workflows write only
      // for workflow changes; never anything else.
      const permissions = JSON.parse(init.body).permissions;
      assert(
        [{ contents: 'write' }, { contents: 'write', workflows: 'write' }].some(set =>
          isDeepStrictEqual(set, permissions),
        ),
      );
      tokenPermissions.push(permissions);
      return Response.json({ token: `synthetic-token-${tokenPermissions.length - 1}` });
    }
    // GitHub's own rule (incident 708b6943), checked against GitHub by its contract suite.
    if (url.endsWith('/git/trees') && init.method === 'POST') {
      const granted = tokenPermissions[Number(init.headers.Authorization.split('-').at(-1))];
      const refused = workflowTreeRefusal(granted, JSON.parse(init.body));
      if (refused) return refused;
    }
    const response = respond(url, init);
    if (response) return response;
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
    runQuery: async (ref, args) => {
      const name = getFunctionName(ref);
      assert.equal(name, 'projectGithubMirrorObjects:resolve');
      return JSON.stringify(
        args.digests.map(id => ({
          descriptor: { object: { sha256: id, size: objectSizes.get(id) }, recipe: null },
          url: objectUrl(id),
        })),
      );
    },
  };
  const job = () => f.tables.projectGithubMirrorJobs.get(input.jobId);
  const status = () => run({ _handler: async ctx => githubMirrorStatus(ctx, await ctx.db.get(projectId)) });
  return {
    ...f,
    github,
    tokenPermissions,
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
  assert(f.scheduled.at(-1).delay >= 48_000 && f.scheduled.at(-1).delay <= 72_000);
  assert.equal(f.job().httpStatus, 500);
  assert.equal(f.job().apiOperation, 'POST git/blobs');
  assert(f.job().requestBytes > 0);
  assert.match(hostedMirrorStatusText(await f.status(), Date.now()), /retrying .* 1\/\d failed attempts/);
  await f.step();
  assert.equal(f.job().status, 'done');
  assert.equal(f.job().failures, 0);
  assert.equal(f.job().error, undefined);
  assert.equal(f.scheduled.length, 2, 'no timer after recovery');
  assert.equal(f.github.commits.size, 2);
  await f.step(f.input);
  assert.equal(f.scheduled.length, 2, 'late worker is fenced');
});

test('real action: GitHub 422 on trees fails once with its bounded message in job detail and status', async t => {
  const f = await fixture(
    t,
    () => false,
    undefined,
    url =>
      url.endsWith('/git/trees')
        ? Response.json(
            {
              message: 'GitRPC::BadObjectState',
              errors: [{ resource: 'Tree', field: 'tree', code: 'invalid' }],
              documentation_url: 'https://docs.github.com/rest',
              echoed: 'synthetic-token',
            },
            { status: 422 },
          )
        : undefined,
  );
  await f.step();
  const job = f.job();
  assert.equal(job.status, 'failed');
  assert.equal(job.httpStatus, 422);
  assert.equal(job.apiOperation, 'POST git/trees');
  assert.match(job.detail, /GitHub error: "GitRPC::BadObjectState; Tree tree invalid"\./);
  assert(!/synthetic-token|docs\.github\.com/.test(job.detail));
  assert.notEqual(job.cursor, f.cursor, 'verified blob progress is checkpointed');
  assert.equal(f.scheduled.length, 1, 'a 422 schedules no retry');
  const status = await f.status();
  // Incident 67771ca6: the stop record names the receipt whose publish holds the mirror.
  assert.equal(
    status.detail,
    `Job for State ${f.github.head.slice(0, 8)} (receipt ${job.receiptId.slice(0, 8)}): ${job.detail}`,
  );
  assert.equal(status.receiptId, job.receiptId);
  assert.match(hostedMirrorStatusText(status, Date.now()), /GitRPC::BadObjectState/);
});

for (const { status, body, code, detail } of [
  {
    status: 422,
    body: { message: 'Repository rule violations found\nCannot update this protected ref.' },
    code: 'GITHUB_RULE_BLOCKED',
    detail: /Cannot update this protected ref/,
  },
  {
    status: 422,
    body: {
      message: `Validation Failed ${'Details omitted from the display. '.repeat(20)}`,
      errors: [{ code: 'GH013', message: 'Commits must have verified signatures.' }],
    },
    code: 'GITHUB_RULE_BLOCKED',
    detail: /Commits must have verified signatures/,
  },
  {
    status: 422,
    body: { message: 'Reference update failed' },
    code: 'GITHUB_SYNC_API',
    detail: /Reference update failed/,
  },
  {
    status: 403,
    body: { message: 'Resource not accessible by integration' },
    code: 'GITHUB_SYNC_API',
    detail: /Resource not accessible by integration/,
  },
])
  test(`real action: a ref write refusal matching ${detail} is retained as ${code}`, async t => {
    const gitCalls = [];
    const f = await fixture(
      t,
      () => false,
      undefined,
      (url, init) => {
        const path = new URL(url).pathname;
        if (!path.includes('/git/')) return;
        gitCalls.push(`${init.method} ${path.split('/git/')[1]}`);
        if (path.endsWith('/git/refs/heads/main')) return Response.json(body, { status });
      },
    );
    await f.step();
    const job = f.job();
    assert.equal(job.status, 'failed');
    assert.equal(job.error, code);
    assert.equal(job.httpStatus, status);
    assert.equal(job.apiOperation, 'PATCH git/refs');
    assert.match(job.detail, detail);
    assert.match(job.detail, /nforge github resume PROJECT/);
    if (code === 'GITHUB_RULE_BLOCKED') assert.match(job.detail, /Review the blocking rule in GitHub/);
    assert.equal(f.scheduled.length, 1, 'the refusal enqueues no retry');
    assert.equal(f.github.remote(), f.github.root.commit);
    assert.deepEqual(gitCalls, [
      'POST blobs',
      'POST trees',
      'GET ref/heads/main',
      'POST commits',
      'PATCH refs/heads/main',
    ]);
    const mirrorStatus = await f.status();
    assert.equal(mirrorStatus.error, code);
    assert.match(hostedMirrorStatusText(mirrorStatus, Date.parse(f.github.seed.at)), detail);
  });

test('a ruleset refusing Candidate ref creation has the dedicated mirror error', async () => {
  const api = githubRequest('synthetic-token', async () =>
    Response.json(
      { message: 'GH013: Repository rule violations found. Cannot create this ref.' },
      { status: 422 },
    ),
  );
  await assert.rejects(
    api('/repos/git/trees/git/refs', 'POST', { ref: 'refs/heads/candidate', sha: 'a'.repeat(40) }),
    {
      code: 'GITHUB_RULE_BLOCKED',
      operation: 'POST git/refs',
      githubError: 'GH013: Repository rule violations found. Cannot create this ref.',
    },
  );
});

// adff6f58: GitHub read-after-write lag on objects this job just created.
const treeSha = gitHash('blob', Buffer.from('new'));
const commitReply = () =>
  Response.json(
    { message: 'Tree SHA does not exist', documentation_url: 'https://docs.github.com/rest' },
    { status: 422 },
  );
const treeReply = sha =>
  Response.json({ message: `tree.sha ${sha} is not a valid blob`, status: '422' }, { status: 422 });

test('real action: 422 "Tree SHA does not exist" on commits retries after 2 s, then drains with one commit', async t => {
  let lag = 1;
  const f = await fixture(
    t,
    () => false,
    undefined,
    url => (url.endsWith('/git/commits') && lag-- > 0 ? commitReply() : undefined),
  );
  await f.step();
  assert.equal(f.job().status, 'retrying');
  assert.equal(f.job().httpStatus, 422);
  assert.equal(f.job().apiOperation, 'POST git/commits');
  assert.match(f.job().detail, /GitHub error: "Tree SHA does not exist"/);
  assert.equal(f.job().failures, 1);
  assert.equal(f.scheduled.at(-1).delay, 2_000);
  assert(f.job().nextAttemptAt > Date.now());
  const lagging = await f.status();
  assert.equal(lagging.attemptLimit, 3, 'lag budget: first try + 2 scheduled retries');
  assert.match(hostedMirrorStatusText(lagging, Date.now()), /retrying .* 1\/3 failed attempts .* retry at/);
  await f.step();
  assert.equal(f.job().status, 'done');
  assert.equal(f.job().failures, 0);
  assert.equal(f.job().error, undefined);
  assert.equal(f.scheduled.length, 2, 'one scheduled retry, no timer after recovery');
  assert.equal(f.github.commits.size, 2, 'exactly one commit for the State');
  assert.equal(f.github.remote(), JSON.parse(f.job().mapping).commit);
});

test('real action: 422 "is not a valid blob" on trees re-uploads in step, retries on schedule and drains', async t => {
  let lag = 2; // the first try and its in-step retry both fail
  const f = await fixture(
    t,
    () => false,
    undefined,
    url => (url.endsWith('/git/trees') && lag-- > 0 ? treeReply(treeSha) : undefined),
  );
  await f.step();
  assert.equal(f.job().status, 'retrying');
  assert.equal(f.job().apiOperation, 'POST git/trees');
  assert.match(f.job().detail, new RegExp(`tree.sha ${treeSha} is not a valid blob`));
  assert.equal(f.scheduled.at(-1).delay, 2_000);
  await f.step();
  assert.equal(f.job().status, 'done');
  assert.equal(f.scheduled.length, 2);
  assert.equal(f.github.remote(), JSON.parse(f.job().mapping).commit);
});

test('real action: a persistent missing-object 422 gets exactly two scheduled retries, then ends terminal with GitHub message', async t => {
  const f = await fixture(
    t,
    () => false,
    undefined,
    url => (url.endsWith('/git/commits') ? commitReply() : undefined),
  );
  const commits = () =>
    f.github.calls.filter(call => call.path.endsWith('/commits') && call.method === 'POST');
  for (let i = 0; i < 3; i++) await f.step();
  assert.deepEqual(
    f.scheduled.map(s => s.delay),
    [0, 2_000, 10_000],
  );
  assert.equal(f.job().status, 'failed');
  assert.equal(f.job().failures, 3);
  assert.match(f.job().detail, /GitHub error: "Tree SHA does not exist"/);
  assert.equal(f.job().nextAttemptAt, undefined);
  assert.equal(f.scheduled.length, 3, 'terminal: nothing scheduled after the budget');
  assert.equal(commits().length, 0, 'rejected commits never reach the store');
  assert.equal(f.github.remote(), f.github.root.commit, 'no ref change');
  const status = await f.status();
  assert.equal(status.status, 'failed');
  assert.match(status.detail, /Tree SHA does not exist/);
  assert.match(
    hostedMirrorStatusText(status, Date.now()),
    /failed .* 3 failed attempts .*Tree SHA does not exist/,
  );
});

test('real action: a persistent tree 422 for a SHA outside this job, or any other 422, stays terminal at once', async t => {
  const foreign = await fixture(
    t,
    () => false,
    undefined,
    url => (url.endsWith('/git/trees') ? treeReply('f'.repeat(40)) : undefined),
  );
  await foreign.step();
  assert.equal(foreign.job().status, 'failed');
  assert.equal(foreign.scheduled.length, 1);
  const other = await fixture(
    t,
    () => false,
    undefined,
    url =>
      url.endsWith('/git/commits')
        ? Response.json({ message: 'Parent SHA does not exist' }, { status: 422 })
        : undefined,
  );
  await other.step();
  assert.equal(other.job().status, 'failed');
  assert.equal(other.scheduled.length, 1);
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

test('progressing large binary blobs do not exhaust the retry budget across different requests', async t => {
  const bytes = Buffer.from(Uint8Array.from({ length: 341451 }, (_, i) => (i * 131 + 17) & 255));
  let requests = 0;
  const f = await fixture(t, () => ++requests % 2 === 1, {
    before: {},
    after: Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => {
        const content = Buffer.from(bytes);
        content[0] = i;
        return [`blob-${i}`, { text: content, mode: 'file' }];
      }),
    ),
  });
  for (let i = 0; i < 6; i++) {
    await f.step();
    assert.equal(f.job().status, 'retrying');
    assert.equal(f.job().failures, 1, 'verified durable progress starts the next request budget');
    assert.equal(f.job().requestBytes, 455302);
    assert(f.scheduled.at(-1).delay >= 48_000 && f.scheduled.at(-1).delay <= 72_000);
  }
  await f.step();
  assert.equal(f.job().status, 'done');
  assert.equal(requests, 12);
  assert.equal(f.github.calls.filter(call => call.path.endsWith('/blobs')).length, 6);
  assert.equal(f.scheduled.length, 7, 'no idle retry after draining');
});

test('partial cursor storage failure still records the API failure and retries the retained cursor visibly', async t => {
  let requests = 0;
  const f = await fixture(t, () => ++requests === 2, { before: {}, after: { a: 'first', b: 'second' } });
  f.patch('projectGithubMirrorJobs', f.input.jobId, { failures: 3 });
  // Cursor checkpoints are R2 objects: their PUT fails.
  t.after(
    interceptDefaultR2((input, init, serve) =>
      init?.method === 'PUT' ? new Response(null, { status: 500 }) : serve(input, init),
    ),
  );
  await f.step();
  assert.equal(f.job().status, 'retrying');
  assert.equal(f.job().cursor, f.cursor);
  assert.equal(f.job().failures, 4, 'unsaved progress cannot reset the retained request budget');
  assert.match(f.job().detail, /HTTP 500.*Partial progress could not be checkpointed/);
  await f.step();
  assert.equal(f.job().status, 'done');
});

test('real action: eight persistent 500s end terminal, visible in CLI and Now, with zero idle retries', async t => {
  const f = await fixture(t, () => true);
  for (let i = 0; i < 8; i++) await f.step();
  const delays = f.scheduled.map(s => s.delay);
  assert.equal(delays.length, 8);
  assert.equal(delays[0], 0);
  [60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000].forEach((base, i) =>
    assert(delays[i + 1] >= base * 0.8 && delays[i + 1] <= base * 1.2, `jittered ${base}`),
  );
  assert.equal(f.job().status, 'failed');
  assert.match(f.job().detail, /kept failing after every retry/);
  assert.equal(f.job().failures, 8);
  assert.equal(f.job().nextAttemptAt, undefined);
  assert.equal(f.job().cursor, f.cursor);
  const status = await f.status();
  assert.equal(status.status, 'failed');
  assert.equal(status.lagging, true);
  // SM-E: a stopped mirror names its next step.
  assert.match(status.nextStep, /nforge github resume PROJECT/);
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
  assert.match(cli.text, /failed.* \d failed attempts.*HTTP 500/);
  assert.equal(
    client.calls.filter(c => c.name === 'projectHostedAgent:capabilities').length,
    1,
    'one finite status call',
  );
  await f.step();
  assert.equal(f.scheduled.length, 8, 'terminal failure schedules nothing');
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

for (const kind of ['pending', 'inProgress'])
  test(`resume replaces a failed job ${kind} task, cancels only pending work and fences late failure and commit`, async t => {
    const f = await fixture(t, () => true);
    f.patch('projectGithubMirrorJobs', f.input.jobId, { status: 'failed', error: 'GITHUB_SYNC_API' });
    const task = f.tasks.get(f.job().scheduledId);
    task.state = { kind };
    const resumed = await f.run(store.resume, { jobId: f.input.jobId });
    assert.equal(resumed.status, 'scheduled');
    assert.equal(task.state.kind, kind === 'pending' ? 'canceled' : 'inProgress');
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
  assert.equal(task.state.kind, 'inProgress', 'the old running action retires through its generation fence');
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

// Incident 2026-11-09 (State c36418d6): a transport fault is a NetworkTransportError,
// not a ForgeError. It was recorded as a generic terminal GITHUB_SYNC_FAILED with
// no retry, and the queue held GitHub main until an operator resumed the job.
test('real action: a transport fault keeps its named cause, retries on schedule and drains', async t => {
  let faults = 1;
  const f = await fixture(
    t,
    () => false,
    undefined,
    url => {
      if (url.endsWith('/blobs') && faults-- > 0) throw new TypeError('fetch failed');
    },
  );
  await f.step();
  assert.equal(f.job().status, 'retrying');
  assert.equal(f.job().error, 'GITHUB_SYNC_NETWORK');
  assert.match(f.job().detail, /^Mirror step stopped on EXCHANGE_REQUEST_FAILED: Network request failed/);
  assert(!/synthetic-token/.test(f.job().detail));
  assert(f.scheduled.at(-1).delay >= 48_000 && f.scheduled.at(-1).delay <= 72_000);
  assert.match(
    hostedMirrorStatusText(await f.status(), Date.now()),
    /retrying .*1\/\d failed attempts.*GITHUB_SYNC_NETWORK/,
  );
  await f.step();
  assert.equal(f.job().status, 'done');
  assert.equal(f.github.commits.size, 2);
  assert.equal(f.scheduled.length, 2, 'no timer after recovery');
});

test('real action: an unexpected exception keeps a bounded redacted cause, retries 8 times, then names the resume command', async t => {
  const f = await fixture(
    t,
    () => false,
    undefined,
    // A 201 whose body is not JSON: response.json() raises a plain SyntaxError.
    url =>
      url.endsWith('/blobs')
        ? new Response('synthetic-token-0 https://example.invalid/x?sig=1', { status: 201 })
        : undefined,
  );
  for (let i = 0; i < 8; i++) await f.step();
  assert.equal(f.scheduled.length, 8);
  const job = f.job();
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'GITHUB_SYNC_FAILED');
  assert.match(job.detail, /^Mirror step stopped on SyntaxError: not valid JSON\. Next: /);
  assert(!/synthetic-token|example\.invalid|sig=1/.test(job.detail), 'no token, URL or body text');
  // SM-E: the failure names a command a user can run, not an operator-only mutation.
  assert(job.detail.includes('nforge github resume PROJECT'));
  assert(!job.detail.includes('npx convex'));
  assert.equal(job.cursor, f.cursor, 'the retained cursor is kept for resume');
  await f.step();
  assert.equal(f.scheduled.length, 8, 'terminal failure schedules nothing');
});

test('unexpected mirror failures: named codes, bounded and credential-free detail', () => {
  const network = unexpectedMirrorFailure(
    Object.assign(new Error('Network request caller deadline reached.'), {
      name: 'NetworkTransportError',
      code: 'EXCHANGE_REQUEST_TIMEOUT',
    }),
  );
  assert.deepEqual(network, {
    code: 'GITHUB_SYNC_NETWORK',
    detail: 'Mirror step stopped on EXCHANGE_REQUEST_TIMEOUT: Network request caller deadline reached.',
  });
  const io = unexpectedMirrorFailure(
    Object.assign(new Error('Source I/O did not complete.'), {
      name: 'SourceIoError',
      code: 'SOURCE_R2_UNAVAILABLE',
      stage: 'read',
      httpStatus: 503,
    }),
  );
  assert.equal(io.code, 'GITHUB_SYNC_FAILED');
  assert.match(io.detail, /SourceIoError \(SOURCE_R2_UNAVAILABLE, stage read, HTTP 503\)/);
  const odd = unexpectedMirrorFailure(
    Object.assign(new Error(`ghs_${'a'.repeat(40)} secret-x ${'z'.repeat(400)}`), { name: 'Custom' }),
    ['secret-x'],
  );
  assert.equal(odd.code, 'GITHUB_SYNC_FAILED');
  assert.match(odd.detail, /^Mirror step stopped on UnknownError: \[redacted\] \[redacted\]/);
  assert(odd.detail.length < 300);
  assert.equal(unexpectedMirrorFailure('thrown string').detail, 'Mirror step stopped on UnknownError.');
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

// Incident 708b6943: a narrowed contents-only token stopped the mirror on the
// first workflow-file landing. Every path class the mirror pushes is replayed.
for (const [name, source, workflows] of [
  [
    'adds a workflow',
    { before: { 'a.md': 'a' }, after: { 'a.md': 'a', '.github/workflows/sign.yml': 'on: push' } },
    true,
  ],
  [
    'changes a workflow',
    { before: { '.github/workflows/sign.yml': 'v1' }, after: { '.github/workflows/sign.yml': 'v2' } },
    true,
  ],
  [
    'removes a workflow',
    { before: { 'a.md': 'a', '.github/workflows/sign.yml': 'v1' }, after: { 'a.md': 'a' } },
    true,
  ],
  [
    'changes docs only',
    {
      before: { 'docs/a.md': 'a', '.github/workflows/sign.yml': 'v1' },
      after: { 'docs/a.md': 'b', '.github/workflows/sign.yml': 'v1' },
    },
    false,
  ],
  [
    'changes .github outside workflows',
    { before: {}, after: { '.github/CODEOWNERS': '* @x', 'src/a.ts': '1' } },
    false,
  ],
])
  test(`real action: a mirror job that ${name} ${workflows ? 'asks for' : 'does not ask for'} workflows write`, async t => {
    const f = await fixture(t, () => false, source);
    await f.step();
    assert.equal(f.job().status, 'done', f.job().error);
    assert.deepEqual(f.tokenPermissions, [
      workflows ? { contents: 'write', workflows: 'write' } : { contents: 'write' },
    ]);
    assert.equal(f.github.commits.size, 2);
  });

test('friction 28e84c06: a terminal stop records one stop row; a pause hides it and resume clears it', async t => {
  const f = await fixture(
    t,
    () => false,
    undefined,
    url =>
      url.endsWith('/git/trees')
        ? Response.json({ message: 'GitRPC::BadObjectState' }, { status: 422 })
        : undefined,
  );
  const stops = () => [...(f.tables.projectGithubMirrorStops?.values() ?? [])];
  const stopped = () => f.run({ _handler: ctx => stoppedMirror(ctx, f.projectId) });
  assert.equal(await stopped(), null, 'a healthy mirror has no stop row');
  await f.step();
  assert.equal(f.job().status, 'failed');
  assert.deepEqual(
    stops().map(row => row.jobId),
    [f.input.jobId],
  );
  assert.deepEqual(await stopped(), {
    repository: 'synthetic/mirror',
    error: f.job().error,
    state: f.job().state,
    receiptId: f.job().receiptId,
  });
  // A paused mirror says paused elsewhere; a landing does not claim it is stopped.
  const project = f.tables.hostedProjects.get(f.projectId);
  const policy = project.autonomyPolicy;
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policy, githubMirror: { ...policy.githubMirror, autoPush: false } },
  });
  assert.equal(await stopped(), null);
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policy });
  assert.equal((await f.run(store.resume, { jobId: f.input.jobId })).status, 'scheduled');
  assert.deepEqual(stops(), [], 'resume deletes the stop row');
  assert.equal(await stopped(), null);
});

test('friction 28e84c06: a retarget, a bring-in, a moved active job or client authority never report an old stop', async t => {
  const failing = async () => {
    const f = await fixture(
      t,
      () => false,
      undefined,
      url =>
        url.endsWith('/git/trees')
          ? Response.json({ message: 'GitRPC::BadObjectState' }, { status: 422 })
          : undefined,
    );
    await f.step();
    assert.equal(f.job().status, 'failed');
    return f;
  };
  const stops = f => [...(f.tables.projectGithubMirrorStops?.values() ?? [])];
  const stopped = f => f.run({ _handler: ctx => stoppedMirror(ctx, f.projectId) });
  const f = await failing();
  assert.notEqual(await stopped(f), null);
  // A native-owner project is not mirrored from Forge.
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    sourceAuthority: { ...project.sourceAuthority, mode: 'native-owner' },
  });
  assert.equal(await stopped(f), null, 'native-owner authority');
  f.patch('hostedProjects', f.projectId, { sourceAuthority: project.sourceAuthority });
  // The queue moved past the stopped job without clearing the row: still not reported.
  const row = [...f.tables.projectGithubMirrors.values()].find(r => r.projectId === f.projectId);
  f.patch('projectGithubMirrors', row._id, { activeId: null });
  assert.equal(await stopped(f), null, 'a moved active job');
  f.patch('projectGithubMirrors', row._id, { activeId: row.activeId });
  assert.notEqual(await stopped(f), null);
  await f.run({ _handler: ctx => retargetGithubMirror(ctx, f.projectId, 'synthetic/other') });
  assert.deepEqual(stops(f), [], 'a retarget clears the stop');
  // Bringing GitHub in requeues the failed publish and clears its stop.
  const g = await failing();
  assert.equal(stops(g).length, 1);
  await g.run({
    _handler: async ctx =>
      yieldToInbound(
        ctx,
        await ctx.db.get(g.projectId),
        await mirrorRow(ctx, g.projectId),
        await ctx.db.get(g.input.jobId),
      ),
  });
  assert.equal(g.job().status, 'queued');
  assert.deepEqual(stops(g), [], 'a bring-in clears the stop');
});

test('replay 2026-11-23: a change touching every file lands in bounded tree pieces and survives two GitHub 502s', async t => {
  const before = {},
    after = {};
  for (let i = 0; i < 1200; i++) {
    before[`src/f${i}.txt`] = `// old\n${i}`;
    after[`src/f${i}.txt`] = `// new header\n${i}`;
  }
  let bad = 2;
  const f = await fixture(
    t,
    () => false,
    { before, after },
    (url, init) => {
      if (url.endsWith('/git/trees') && init?.method === 'POST' && bad-- > 0)
        return new Response('{"message":"Server Error"}', { status: 502 });
    },
  );
  let guard = 0;
  while (f.job().status !== 'done' && guard++ < 60) {
    await f.step();
    if (f.job().status === 'failed') assert.fail(`stopped: ${f.job().detail}`);
  }
  assert.equal(f.job().status, 'done');
  const posts = f.github.calls.filter(c => c.path.endsWith('/git/trees') && c.method === 'POST');
  assert.equal(bad, -3, 'both 502s were served');
  assert.equal(posts.length, 3, '1200 entries land as 500 + 500 + 200');
  assert(posts.every(c => (c.body?.tree?.length ?? 0) <= 500));
  assert.equal(f.github.remote(), JSON.parse(f.job().mapping).commit);
});

// GitHub's real reply when the work behind one base_tree call is too big (State 6f14cecd).
const treeTimeout = () =>
  Response.json(
    {
      message:
        "Sorry, your request timed out.  It's likely that your input was too large to process.  Consider building the tree incrementally, or building the commits you need in a local clone, pushing them to GitHub, and then using the API.",
      documentation_url: 'https://docs.github.com/rest/git/trees#create-a-tree',
    },
    { status: 422 },
  );

test('replay State 6f14cecd: GitHub 422 timeouts on large tree pieces split them, a 502 resumes from the tree cursor, no owner action', async t => {
  const before = {},
    after = {};
  for (let i = 0; i < 3000; i++) {
    const path = `src/d${i % 30}/sub${i % 7}/f${i}.ts`;
    before[path] = `// MIT\n${i}`;
    after[path] = `// SPDX-License-Identifier: AGPL-3.0-only\n${i}`;
  }
  let timeouts = 0,
    accepted = 0,
    gateway = 0;
  const f = await fixture(
    t,
    () => false,
    { before, after },
    (url, init) => {
      if (!url.endsWith('/git/trees') || init?.method !== 'POST') return;
      // Synthetic GitHub budget for the work behind one call: more than 60 entries times out.
      if (JSON.parse(init.body).tree.length > 60) return (timeouts++, treeTimeout());
      if (++accepted === 10 && !gateway++) return new Response('{"message":"Server Error"}', { status: 502 });
    },
  );
  let guard = 0;
  while (f.job().status !== 'done' && guard++ < 200) {
    await f.step();
    if (f.job().status === 'failed') assert.fail(`stopped: ${f.job().detail}`);
  }
  assert.equal(f.job().status, 'done');
  assert.equal(timeouts, 4, '500, 250, 125 and 62 time out once each; the learned size is kept');
  assert.equal(gateway, 1);
  const posts = f.github.calls.filter(c => c.path.endsWith('/git/trees') && c.method === 'POST');
  assert(posts.every(c => c.body.tree.length <= 31));
  const firsts = new Set(posts.map(c => c.body.tree[0].path));
  assert.equal(firsts.size, posts.length, 'no piece is posted twice: the 502 resumed from the cursor');
  assert.equal(
    posts.reduce((n, c) => n + c.body.tree.length, 0),
    3000,
  );
  assert.equal(f.github.commits.get(f.github.remote()).tree, f.github.expected());
  assert.equal(f.github.remote(), JSON.parse(f.job().mapping).commit);
});

test('a tree timeout at the smallest piece retries on the transient budget instead of stopping', async t => {
  const before = {},
    after = {};
  for (let i = 0; i < 100; i++) {
    before[`a/f${i}`] = `old ${i}`;
    after[`a/f${i}`] = `new ${i}`;
  }
  const f = await fixture(
    t,
    () => false,
    { before, after },
    (url, init) => (url.endsWith('/git/trees') && init?.method === 'POST' ? treeTimeout() : undefined),
  );
  await f.step();
  assert.equal(f.job().status, 'retrying');
  assert.equal(f.job().httpStatus, 422);
  assert.match(f.job().detail, /request timed out/);
  assert(f.scheduled.at(-1).delay >= 48_000 && f.scheduled.at(-1).delay <= 72_000);
  await f.step();
  assert.equal(f.job().status, 'retrying');
  assert.equal(f.job().failures, 2, 'a timeout at the floor makes no progress, so it spends the budget');
});

test('replay State 6f14cecd at the floor: when even small base_tree pieces time out, the tree is built per directory, children first', async t => {
  const before = { notes: 'a file that becomes a directory', 'src/gone/x.ts': 'removed directory' },
    after = { 'notes/a.md': 'now a directory', 'docs/new/y.md': 'new directory' };
  for (let i = 0; i < 300; i++) {
    const path = `src/d${i % 5}/sub${i % 3}/f${i}.ts`;
    before[path] = `// MIT\n${i}`;
    after[path] = `// SPDX-License-Identifier: AGPL-3.0-only\n${i}`;
  }
  let timeouts = 0;
  const f = await fixture(
    t,
    () => false,
    { before, after },
    (url, init) => {
      if (url.endsWith('/git/trees') && init?.method === 'POST' && JSON.parse(init.body).base_tree)
        return (timeouts++, treeTimeout());
    },
  );
  let guard = 0;
  while (f.job().status !== 'done' && guard++ < 40) {
    await f.step();
    if (f.job().status === 'failed') assert.fail(`stopped: ${f.job().detail}`);
  }
  assert.equal(f.job().status, 'done');
  assert.equal(
    timeouts,
    5,
    'the 304-entry piece, then 152, 76, 38 and the 25-entry floor time out once each',
  );
  const posts = f.github.calls.filter(c => c.path.endsWith('/git/trees') && c.method === 'POST');
  // src/d0..d4/sub0..2 (15), src/d0..d4 (5), src, notes, docs/new, docs and the root: 25 directories.
  assert.equal(posts.length, 25, 'one POST per changed directory; the emptied src/gone needs none');
  assert(posts.every(c => !c.body.base_tree && c.body.tree.every(e => !e.path.includes('/'))));
  assert.equal(
    f.github.calls.filter(c => c.method === 'GET' && c.path.includes('/git/trees/')).length,
    1,
    'one recursive read lists the old entries',
  );
  assert.equal(f.github.commits.get(f.github.remote()).tree, f.github.expected());
});

test('a GitHub 403 secondary or primary rate limit waits on the transient budget; a permission 403 and other 422s still stop', () => {
  const secondary =
    'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';
  assert.equal(isRetryable4xx(403, 'POST git/trees', secondary), true);
  assert.equal(
    isRetryable4xx(403, 'POST git/blobs', 'API rate limit exceeded for installation ID 42.'),
    true,
  );
  assert.equal(isRetryable4xx(403, 'PATCH git/refs', 'Resource not accessible by integration'), false);
  assert.equal(isRetryable4xx(422, 'POST git/trees', 'Sorry, your request timed out.'), true);
  assert.equal(isRetryable4xx(422, 'POST git/commits', 'Sorry, your request timed out.'), false);
  assert.equal(isRetryable4xx(422, 'POST git/trees', 'GitRPC::BadObjectState'), false);
});

test('tree chunks are bounded by UTF-8 request bytes as well as entries', () => {
  const entries = Array.from({ length: 3000 }, (_, i) => ({
    path: `${'目录'.repeat(60)}/${i}`,
    sha: 'a'.repeat(40),
  }));
  const chunks = treeChunks(entries);
  assert.deepEqual(chunks.flat(), entries);
  for (const chunk of chunks) {
    assert(chunk.length <= 500);
    assert(Buffer.byteLength(JSON.stringify({ base_tree: 'a'.repeat(40), tree: chunk })) <= treeChunkBytes);
  }
  assert(chunks.length > 6, 'bytes, not entries, set the split');
});
