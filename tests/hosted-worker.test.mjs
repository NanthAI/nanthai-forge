import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { workerAuthorized } from '../dist/worker-auth.js';
import { decodeHostedArtifact } from '../dist/hosted-artifact.js';
import { validateArtifact } from '../dist/artifact-validation.js';

const indexer = await import(moduleUrl('../convex/indexer.ts'));
const imports = await import(moduleUrl('../convex/imports.ts'));
const remote = await import(moduleUrl('../convex/remote.ts'));
const hosted = await import(moduleUrl('../convex/hosted.ts'));
const { default: http } = await import(moduleUrl('../convex/http.ts'));
const { default: worker } = await import(moduleUrl('../netlify/functions/analyze-background.mts'));
const repository = {
  full_name: 'example/project',
  private: false,
  default_branch: 'main',
  html_url: 'https://github.com/example/project',
  license: null,
};
const original = () => ({
  _id: 'import',
  visibility: 'public',
  repository: repository.full_name,
  ref: 'main',
  scope: 'public',
  owner: '',
  phase: 'fetching',
  generation: 2,
  artifactKey: 'old-object',
  task: 'dispatch',
  processed: 0,
  total: 0,
});

function context(initial = original()) {
  const job = { ...initial },
    deleted = [],
    scheduled = [];
  const db = {
    get: async () => job,
    system: { get: async () => ({ state: { kind: 'pending' } }) },
    patch: async (_, fields) => {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete job[key];
        else job[key] = value;
      }
    },
    query: table => ({ withIndex: () => ({ unique: async () => (table === 'imports' ? job : null) }) }),
    insert: async () => 'tracked',
  };
  const ctx = {
    db,
    scheduler: {
      runAfter: async (delay, fn, args) => {
        scheduled.push({ delay, args });
        return 'watchdog';
      },
    },
    storage: {
      generateUploadUrl: async () => 'https://storage.example/upload',
      delete: async id => deleted.push(id),
    },
  };
  ctx.runQuery = (fn, args) => imports[getFunctionName(fn).split(':')[1]]._handler(ctx, args);
  ctx.runMutation = ctx.runQuery;
  return { ctx, job, deleted, scheduled };
}

test('worker headers reject missing/wrong credentials before parsing or running an operation', async () => {
  assert.equal(await workerAuthorized('Bearer right', 'right'), true);
  for (const provided of [null, 'right', 'Bearer wrong', 'Bearer right-extra'])
    assert.equal(await workerAuthorized(provided, 'right'), false);
  assert.equal(await workerAuthorized('Bearer right', undefined), false);
  const before = process.env.FORGE_WORKER_KEY;
  process.env.FORGE_WORKER_KEY = 'right';
  try {
    const routes = http.getRoutes().filter(([path]) => path.startsWith('/worker/'));
    assert.equal(routes.length, 2);
    for (const [path, , action] of routes) {
      const ctx = { runAction: () => assert.fail('Unauthorized calls must not touch jobs or storage.') };
      const response = await action._handler(
        ctx,
        new Request(`https://forge.example${path}`, {
          method: 'POST',
          body: 'invalid json',
          headers: { Authorization: 'Bearer wrong' },
        }),
      );
      assert.equal(response.status, 401);
    }
  } finally {
    if (before === undefined) delete process.env.FORGE_WORKER_KEY;
    else process.env.FORGE_WORKER_KEY = before;
  }
});

test('Convex owns one remote claim, stale publication, private denial, timeout and retained-object reconciliation', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => Response.json(repository);
  try {
    const { ctx, job, deleted, scheduled } = context();
    assert.equal(await imports.handoff._handler(ctx, { id: job._id, generation: 2 }), true);
    assert.equal(scheduled[0].delay, 900_000);
    assert.equal(await imports.handoff._handler(ctx, { id: job._id, generation: 2 }), false);
    assert.equal(
      (await imports.begin._handler(ctx, job)).run,
      false,
      'The pending watchdog coalesces active remote imports.',
    );
    assert.ok((await remote.prepare._handler(ctx, { id: job._id, generation: 2 })).uploadUrl);
    assert.equal(
      await remote.prepare._handler(ctx, { id: job._id, generation: 2 }),
      null,
      'Redelivery cannot run analysis twice.',
    );
    assert.equal(
      await remote.update._handler(ctx, {
        id: job._id,
        generation: 1,
        phase: 'ready',
        artifactKey: 'stale-object',
      }),
      false,
    );
    assert.deepEqual(deleted, ['stale-object']);
    assert.equal(job.artifactKey, 'old-object');
    await imports.expire._handler(ctx, { id: job._id, generation: 2 });
    assert.equal(job.phase, 'error');
    assert.equal(job.artifactKey, 'old-object');
    assert.equal(
      await remote.update._handler(ctx, {
        id: job._id,
        generation: 2,
        phase: 'ready',
        artifactKey: 'late-object',
      }),
      false,
    );
    const retry = await imports.begin._handler(ctx, job);
    assert.equal(retry.generation, 3);
    assert.equal(job.artifactKey, 'old-object');
    assert.equal(job.remote, undefined);
    await imports.handoff._handler(ctx, { id: job._id, generation: 3 });
    await remote.prepare._handler(ctx, { id: job._id, generation: 3 });
    assert.equal(
      await remote.update._handler(ctx, {
        id: job._id,
        generation: 3,
        phase: 'ready',
        artifactKey: 'new-object',
        head: 'a'.repeat(40),
        analysisVersion: '5.9.3:1:github-3',
      }),
      true,
    );
    assert.equal(job.phase, 'ready');
    assert.equal(job.artifactKey, 'new-object');
    assert.equal(
      await remote.update._handler(ctx, {
        id: job._id,
        generation: 3,
        phase: 'error',
        artifactKey: 'new-object',
      }),
      true,
      'Lost successful callback must reconcile, not delete or mark failed.',
    );
    await imports.expire._handler(ctx, { id: job._id, generation: 3 });
    assert.equal(job.phase, 'ready');
    const privateJob = context({ ...original(), visibility: 'private', remote: true, workerClaimed: true });
    assert.equal(await remote.prepare._handler(privateJob.ctx, { id: 'import', generation: 2 }), null);
    assert.equal(
      await remote.update._handler(privateJob.ctx, {
        id: 'import',
        generation: 2,
        phase: 'ready',
        artifactKey: 'private-object',
      }),
      false,
    );
    assert.deepEqual(privateJob.deleted, []);
    const revoked = context({ ...original(), remote: true, workerClaimed: true });
    globalThis.fetch = async () => Response.json({ ...repository, private: true });
    await assert.rejects(
      remote.update._handler(revoked.ctx, {
        id: 'import',
        generation: 2,
        phase: 'ready',
        artifactKey: 'revoked-object',
        head: 'a'.repeat(40),
        analysisVersion: '5.9.3:1:github-3',
      }),
      { code: 'GITHUB_UNAVAILABLE' },
    );
    assert.equal(revoked.job.artifactKey, 'old-object');
    assert.deepEqual(revoked.deleted, ['revoked-object']);
  } finally {
    globalThis.fetch = before;
  }
});

test('Netlify handler captures exact synthetic Git blobs, reports progress, uploads gzip and reconciles a lost publication reply', async () => {
  const files = {
    'a.ts': 'import { greet } from "./b"; export const result = greet();',
    'b.ts': '\uFEFFexport function greet() { return "こんにちは"; }',
    'README.md': '# Fixture',
    'docs/guide.md': '# Retained guide at unchanged revision',
    LICENSE: 'Original terms',
    'COMMERCIAL_LICENSE.md': 'Companion terms',
  };
  const blobs = new Map();
  const tree = Object.entries(files).map(([path, text]) => {
    const bytes = Buffer.from(text);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    blobs.set(sha, { content: bytes.toString('base64'), encoding: 'base64', sha });
    return { path, sha, size: bytes.length, type: 'blob', mode: '100644' };
  });
  const previousFetch = globalThis.fetch;
  const variables = ['FORGE_WORKER_KEY', 'FORGE_CONVEX_SITE_URL', 'GITHUB_PUBLIC_TOKEN'],
    previous = variables.map(name => process.env[name]);
  process.env.FORGE_WORKER_KEY = 'right';
  process.env.FORGE_CONVEX_SITE_URL = 'https://forge.example';
  delete process.env.GITHUB_PUBLIC_TOKEN;
  let uploaded,
    ready,
    calls = 0,
    claimed = false,
    reconciled = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    calls++;
    if (url.hostname === 'forge.example') {
      assert.equal(init.headers.Authorization, 'Bearer right');
      const body = JSON.parse(init.body);
      assert.equal(body.id, 'import');
      assert.equal(body.generation, 2);
      if (url.pathname.endsWith('/prepare')) {
        if (claimed) return Response.json(null);
        claimed = true;
        return Response.json({
          repository: repository.full_name,
          ref: 'main',
          uploadUrl: 'https://storage.example/upload',
        });
      }
      if (body.phase === 'ready') {
        ready = body;
        throw new Error('Publication committed, connection lost.');
      }
      if (body.phase === 'error') {
        assert.equal(body.artifactKey, ready.artifactKey);
        reconciled = true;
      }
      return Response.json(true);
    }
    if (url.hostname === 'storage.example') {
      uploaded = await decodeHostedArtifact(init.body);
      return Response.json({ storageId: 'new-object' });
    }
    assert.equal(url.hostname, 'api.github.com');
    return Response.json(
      url.pathname.endsWith('/project')
        ? repository
        : url.pathname.includes('/commits/')
          ? { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } }
          : url.pathname.includes('/git/trees/')
            ? { tree, truncated: false }
            : blobs.get(url.pathname.split('/').at(-1)),
    );
  };
  const request = key =>
    new Request('https://worker.example', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({ id: 'import', generation: 2 }),
    });
  try {
    assert.equal((await worker(request('wrong'))).status, 401);
    assert.equal(calls, 0);
    assert.equal((await worker(request('right'))).status, 204);
    validateArtifact(uploaded.pack);
    assert.equal(uploaded.content['b.ts'], files['b.ts']);
    assert.equal(uploaded.documents['docs/guide.md'], files['docs/guide.md']);
    assert.equal(
      ready.analysisVersion,
      `${uploaded.pack.analysis.version}:${uploaded.pack.analysis.configVersion}:github-4`,
    );
    assert.equal(uploaded.documents['COMMERCIAL_LICENSE.md'], files['COMMERCIAL_LICENSE.md']);
    assert.ok(reconciled);
    const before = calls;
    await worker(request('right'));
    assert.equal(calls, before + 1, 'Duplicate delivery only checks its claim.');
  } finally {
    globalThis.fetch = previousFetch;
    variables.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test('registered private status/read actions authorize the current importer before exposing jobs or opening storage', async () => {
  const originalFetch = globalThis.fetch;
  const variables = [
    'CLERK_SECRET_KEY',
    'GITHUB_APP_CLIENT_ID',
    'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_PUBLIC_TOKEN',
  ];
  const before = variables.map(name => process.env[name]);
  const privateJob = {
    ...original(),
    owner: 'owner',
    visibility: 'private',
    artifactKey: 'private-object',
    sync: { checkedAt: 1, result: 'checked', head: 'a'.repeat(40) },
  };
  let caller,
    revoked = false,
    providerReads = 0;
  const ctx = {
    auth: { getUserIdentity: async () => (caller ? { subject: caller } : null) },
    runQuery: async () => privateJob,
    storage: { get: () => assert.fail('Denied access must never open private storage.') },
  };
  try {
    globalThis.fetch = () => assert.fail('Other callers must be denied before provider source access.');
    for (caller of [undefined, 'other-user']) {
      await assert.rejects(
        hosted.status._handler(ctx, { id: 'import' }),
        error => error.data.code === 'GITHUB_UNAVAILABLE',
      );
      for (const endpoint of ['status', 'files', 'source?file=a.ts']) {
        await assert.rejects(
          hosted.read._handler(ctx, { id: 'import', endpoint }),
          error => error.data.code === 'GITHUB_UNAVAILABLE',
        );
      }
    }
    process.env.CLERK_SECRET_KEY = 'test-clerk';
    process.env.GITHUB_APP_CLIENT_ID = 'test-app';
    process.env.GITHUB_APP_CLIENT_SECRET = 'test-secret';
    delete process.env.GITHUB_PUBLIC_TOKEN;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input);
      providerReads++;
      if (url.hostname === 'api.clerk.com') return Response.json([{ token: 'ghu_test' }]);
      if (url.pathname.startsWith('/applications/'))
        return Response.json({}, { status: revoked ? 404 : 200 });
      return Response.json(
        { ...repository, private: true },
        { status: init.headers.Authorization ? 200 : 404 },
      );
    };
    caller = 'owner';
    const status = JSON.parse(await hosted.status._handler(ctx, { id: 'import' }));
    assert.equal(status.visibility, 'private');
    assert.equal(status.phase, 'fetching');
    assert.deepEqual(status.sync, privateJob.sync);
    assert.ok(providerReads > 0);
    assert.ok(!('artifactKey' in status));
    assert.ok(!('owner' in status));
    revoked = true;
    await assert.rejects(
      hosted.status._handler(ctx, { id: 'import' }),
      error => error.data.code === 'GITHUB_UNAVAILABLE',
    );
    await assert.rejects(
      hosted.read._handler(ctx, { id: 'import', endpoint: 'source?file=a.ts' }),
      error => error.data.code === 'GITHUB_UNAVAILABLE',
    );
  } finally {
    globalThis.fetch = originalFetch;
    variables.forEach((name, i) => {
      if (before[i] === undefined) delete process.env[name];
      else process.env[name] = before[i];
    });
  }
});

const sync = await import(moduleUrl('../convex/sync.ts'));
const syncActions = await import(moduleUrl('../convex/syncActions.ts'));

function syncContext(jobs) {
  const rows = new Map(jobs.map(job => [job._id, { ...job }])),
    deliveries = new Map(),
    scheduled = [],
    tasks = new Map();
  const modules = { imports, sync, syncActions };
  const ctx = {
    db: {
      get: async id => rows.get(id) ?? deliveries.get(id) ?? null,
      system: { get: async id => tasks.get(id) ?? null },
      insert: async (table, value) => {
        assert.equal(table, 'githubDeliveries');
        const id = `delivery-${deliveries.size}`;
        deliveries.set(id, { ...value, _id: id });
        return id;
      },
      patch: async (id, changes) => {
        const row = rows.get(id) ?? deliveries.get(id);
        for (const [key, value] of Object.entries(changes)) {
          if (value === undefined) delete row[key];
          else row[key] = value;
        }
      },
      query: table => {
        const matches = new Map();
        const query = {
          withIndex: (_, build) => {
            const q = {
              eq: (key, value) => {
                matches.set(key, value);
                return q;
              },
            };
            build(q);
            return query;
          },
          unique: async () =>
            [...deliveries.values()].find(row => [...matches].every(([key, value]) => row[key] === value)) ??
            null,
          paginate: async opts => {
            assert.equal(table, 'imports');
            const all = [...rows.values()].filter(row =>
              [...matches].every(([key, value]) => row[key] === value),
            );
            const start = Number(opts.cursor ?? 0),
              end = start + opts.numItems;
            return {
              page: all.slice(start, end).map(row => ({ ...row })),
              isDone: end >= all.length,
              continueCursor: String(end),
            };
          },
        };
        return query;
      },
    },
    scheduler: {
      runAfter: async (delay, fn, args) => {
        const task = `task-${scheduled.length}`;
        scheduled.push({ fn, args, task });
        tasks.set(task, { state: { kind: 'pending' } });
        return task;
      },
    },
    storage: { get: () => assert.fail('Synchronization must never load or rewrite source artifacts.') },
  };
  ctx.runQuery = ctx.runMutation = async (fn, args) => {
    const [module, name] = getFunctionName(fn).split(':');
    return modules[module][name]._handler(ctx, args);
  };
  return { ctx, rows, deliveries, scheduled, tasks };
}

test('signed GitHub HTTP delivery authenticates raw bytes and stores only a minimal reconciliation trigger', async () => {
  const { createHmac } = await import('node:crypto');
  const before = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
  const route = http.getRoutes().find(([path]) => path === '/github/webhook')[2];
  const received = [];
  const ctx = { runMutation: async (_, args) => received.push(args) };
  const body = JSON.stringify({
    repository: { full_name: 'example/project' },
    after: 'a'.repeat(40),
    commits: [{ message: 'untrusted private text' }],
  });
  const signature = text => `sha256=${createHmac('sha256', 'test-secret').update(text).digest('hex')}`;
  const request = (text, headers = {}) =>
    new Request('https://forge.example/github/webhook', {
      method: 'POST',
      body: text,
      headers: {
        'x-github-event': 'push',
        'x-github-delivery': 'one',
        'x-hub-signature-256': signature(text),
        ...headers,
      },
    });
  try {
    for (const mac of ['', 'sha256=broken', `sha256=${'0'.repeat(64)}`])
      assert.equal(
        (await route._handler(ctx, request('invalid json', { 'x-hub-signature-256': mac }))).status,
        401,
      );
    assert.equal(
      (await route._handler(ctx, request(`${body} `, { 'x-hub-signature-256': signature(body) }))).status,
      401,
    );
    assert.equal((await route._handler(ctx, request('invalid json'))).status, 400);
    assert.equal((await route._handler(ctx, request('{}'))).status, 400);
    assert.equal((await route._handler(ctx, request(body, { 'x-github-delivery': '' }))).status, 400);
    assert.deepEqual(received, []);
    assert.equal((await route._handler(ctx, request(body))).status, 204);
    assert.deepEqual(received, [{ delivery: 'one', event: 'push', repository: 'example/project' }]);
    for (const event of ['installation', 'installation_repositories', 'github_app_authorization']) {
      assert.equal(
        (
          await route._handler(
            ctx,
            request('{"action":"deleted","sender":{"id":1}}', { 'x-github-event': event }),
          )
        ).status,
        204,
      );
      assert.deepEqual(received.at(-1), { delivery: 'one', event });
    }
    assert.equal((await route._handler(ctx, request('{}', { 'x-github-event': 'ping' }))).status, 204);
    delete process.env.GITHUB_WEBHOOK_SECRET;
    assert.equal((await route._handler(ctx, request(body))).status, 401);
  } finally {
    if (before === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = before;
  }
});

test('delivery deduplication, paginated current-ref reconciliation, access revocation and restoration retain indexed source', async () => {
  const beforeFetch = globalThis.fetch;
  const env = ['CLERK_SECRET_KEY', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET'];
  const before = env.map(name => process.env[name]);
  env.forEach(name => {
    process.env[name] = 'test';
  });
  let head = 'b'.repeat(40),
    revoked = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'api.clerk.com') return Response.json([{ token: 'ghu_test' }]);
    if (url.pathname.startsWith('/applications/')) return Response.json({}, { status: revoked ? 404 : 200 });
    if (url.pathname.includes('/commits/')) return Response.json({ sha: head });
    return Response.json(
      { ...repository, private: true },
      { status: init.headers.Authorization ? 200 : 404 },
    );
  };
  const state = syncContext(
    Array.from({ length: 5 }, (_, index) => ({
      ...original(),
      _id: `job-${index}`,
      owner: 'owner',
      visibility: 'private',
      head: 'a'.repeat(40),
      phase: 'ready',
    })),
  );
  const receive = (delivery, event = 'push') =>
    sync.receive._handler(state.ctx, {
      delivery,
      event,
      ...(event === 'push' ? { repository: repository.full_name } : {}),
    });
  let next = 0;
  const drain = async () => {
    while (next < state.scheduled.length) {
      const task = state.scheduled[next++];
      await syncActions.run._handler(state.ctx, task.args);
      state.tasks.set(task.task, { state: { kind: 'success' } });
    }
  };
  try {
    await receive('push-one');
    await receive('push-one');
    assert.equal(state.scheduled.length, 1);
    await drain();
    assert.equal(state.scheduled.length, 3, 'All five jobs are reconciled across pages.');
    await receive('push-one');
    assert.equal(state.scheduled.length, 3);
    for (const job of state.rows.values()) {
      assert.equal(job.sync.head, head);
      assert.equal(job.head, 'a'.repeat(40));
      assert.equal(job.artifactKey, 'old-object');
      assert.equal(job.generation, 2);
    }
    head = 'c'.repeat(40);
    await receive('older-push-redelivered-late');
    await drain();
    for (const job of state.rows.values())
      assert.equal(job.sync.head, head, 'Event payload order cannot roll back current GitHub facts.');
    revoked = true;
    await receive('revoked', 'github_app_authorization');
    await drain();
    for (const job of state.rows.values()) {
      assert.equal(job.sync.result, 'unavailable');
      assert.equal(job.artifactKey, 'old-object');
    }
    revoked = false;
    await receive('restored', 'installation');
    await drain();
    for (const job of state.rows.values()) {
      assert.equal(job.sync.result, 'checked');
      assert.equal(job.sync.head, head);
      assert.equal(job.generation, 2);
    }
    await receive('interrupted');
    const interrupted = state.scheduled.at(-1);
    state.tasks.set(interrupted.task, { state: { kind: 'failed' } });
    next++;
    await receive('interrupted');
    assert.equal(state.scheduled.length, next + 1);
    await drain();
    assert.ok([...state.deliveries.values()].every(delivery => delivery.complete));
  } finally {
    globalThis.fetch = beforeFetch;
    env.forEach((name, index) => {
      if (before[index] === undefined) delete process.env[name];
      else process.env[name] = before[index];
    });
  }
});

test('a delayed observation cannot overwrite a later completed current-access check', async () => {
  const { ctx, rows } = syncContext([original()]);
  const first = await sync.begin._handler(ctx, { id: 'import' });
  const second = await sync.begin._handler(ctx, { id: 'import' });
  const observation = { checkedAt: 2, result: 'checked', head: 'b'.repeat(40) };
  assert.equal(await sync.finish._handler(ctx, { id: 'import', revision: second, observation }), true);
  assert.equal(
    await sync.finish._handler(ctx, {
      id: 'import',
      revision: first,
      observation: { checkedAt: 1, result: 'unavailable' },
    }),
    false,
  );
  assert.deepEqual(rows.get('import').sync, observation);
  assert.equal(rows.get('import').artifactKey, 'old-object');
});

test('explicit refresh reacquires old acquisition artifacts at the same Git head, then reuses current document captures', async () => {
  const head = 'a'.repeat(40),
    text = '# Guide retained by the new acquisition version';
  const bytes = Buffer.from(text),
    blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const old = { ...original(), phase: 'ready', head, analysisVersion: '5.9.3:1:github-2' };
  const local = context(old),
    previousFetch = globalThis.fetch;
  const variables = ['NETLIFY_WORKER_URL', 'FORGE_WORKER_KEY'],
    before = variables.map(name => process.env[name]);
  let uploaded,
    stores = 0,
    trees = 0,
    handoffs = 0;
  local.ctx.storage.store = async blob => {
    stores++;
    uploaded = await decodeHostedArtifact(blob);
    return 'new-document-object';
  };
  delete process.env.NETLIFY_WORKER_URL;
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === 'worker.example') {
      handoffs++;
      return new Response(null, { status: 202 });
    }
    if (url.pathname.endsWith('/project')) return Response.json(repository);
    if (url.pathname.includes('/commits/'))
      return Response.json({ sha: head, commit: { tree: { sha: 'b'.repeat(40) } } });
    if (url.pathname.includes('/git/trees/')) {
      trees++;
      return Response.json({
        tree: [{ path: 'docs/guide.md', sha: blobSha, size: bytes.length, type: 'blob', mode: '100644' }],
        truncated: false,
      });
    }
    return Response.json({ sha: blobSha, encoding: 'base64', content: bytes.toString('base64') });
  };
  try {
    assert.equal(local.job.artifactKey, 'old-object');
    assert.equal(stores, 0);
    const refresh = await imports.begin._handler(local.ctx, local.job);
    assert.equal(refresh.run, true);
    await indexer.run._handler(local.ctx, { id: 'import', generation: refresh.generation });
    assert.equal(local.job.phase, 'ready');
    assert.equal(local.job.head, head);
    assert.equal(local.job.artifactKey, 'new-document-object');
    assert.equal(uploaded.documents['docs/guide.md'], text);
    assert.equal(stores, 1);
    assert.equal(trees, 1);
    assert.equal(
      local.job.analysisVersion,
      `${uploaded.pack.analysis.version}:${uploaded.pack.analysis.configVersion}:github-4`,
    );
    assert.deepEqual(local.deleted, []);
    const repeat = await imports.begin._handler(local.ctx, local.job);
    await indexer.run._handler(local.ctx, { id: 'import', generation: repeat.generation });
    assert.equal(local.job.phase, 'ready');
    assert.equal(stores, 1);
    assert.equal(trees, 1, 'The current-version exact-head artifact remains reusable.');
    process.env.NETLIFY_WORKER_URL = 'https://worker.example';
    process.env.FORGE_WORKER_KEY = 'fixture-key';
    const remoteOld = context(old),
      remoteRefresh = await imports.begin._handler(remoteOld.ctx, remoteOld.job);
    await indexer.run._handler(remoteOld.ctx, { id: 'import', generation: remoteRefresh.generation });
    assert.equal(handoffs, 1);
    assert.equal(remoteOld.job.remote, true);
    assert.equal(
      remoteOld.job.artifactKey,
      'old-object',
      'Explicit worker refresh retains the previous artifact while acquisition runs.',
    );
  } finally {
    globalThis.fetch = previousFetch;
    variables.forEach((name, i) => {
      if (before[i] === undefined) delete process.env[name];
      else process.env[name] = before[i];
    });
  }
});
