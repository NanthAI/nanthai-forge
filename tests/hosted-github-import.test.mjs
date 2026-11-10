// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultR2Config, defaultR2Objects, storedBytes } from './default-r2.mjs';
import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { githubHostedProject } from '../dist/hosted-github-bootstrap.js';
import { setup as r2Setup } from './r2-harness.mjs';
import { digest } from '../dist/hash.js';
const modules = {};
for (const name of [
  'projectGithubImportInventory',
  'projectGithubImportBatch',
  'projectGithubImportPublication',
  'projectGithubImportStore',
  'projectGithubImportObjects',
  'projectGithubImportWorker',
  'projectGithubImport',
  'projectGithubImportProgress',
  'projectObjectRecipeStore',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const gitSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function fixture(
  t,
  {
    privateRepository = false,
    rejectedPublicCredential = false,
    tooLarge = false,
    submodules = false,
    app = false,
    userLimit = null,
    lfs = null,
  } = {},
) {
  const s = state([]);
  s.tables.projectGithubImports = new Map();
  const original = s.ctx.runQuery;
  s.ctx.runAction =
    s.ctx.runMutation =
    s.ctx.runQuery =
      async (ref, args) => {
        const [name, fn] = getFunctionName(ref).split(':');
        if (modules[name]) return modules[name][fn]._handler(s.ctx, args);
        return original(ref, args);
      };
  const envKeys = [
    'CLERK_SECRET_KEY',
    'GITHUB_APP_CLIENT_ID',
    'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_PUBLIC_TOKEN',
  ];
  const priorEnv = envKeys.map(key => process.env[key]);
  if (privateRepository) for (const key of envKeys.slice(0, 3)) process.env[key] = 'synthetic-fixture';
  if (app) {
    process.env.GITHUB_APP_ID = '123';
    process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
  } else for (const key of envKeys.slice(3)) delete process.env[key];
  if (rejectedPublicCredential) process.env.GITHUB_PUBLIC_TOKEN = 'synthetic-rejected-public';
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
    envKeys.forEach((key, index) => {
      if (priorEnv[index] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[index];
    });
  });
  const bytes = Buffer.from([0, 255, 128, 10]);
  const modulesBytes = Buffer.from(
    '[submodule "a"]\npath=vendor-a\nurl=../a.git\n[submodule "b"]\npath=vendor-b\nurl=git@example.invalid:org/b.git\n',
  );
  let denied = false,
    limited = null,
    splitProbe = false,
    blobs = 0;
  const window = { reset: Math.ceil(Date.now() / 1000) + 3600 };
  const github = [];
  const reply = (body, options, init = {}) => {
    const user = /ghu_/.test(options?.headers?.Authorization ?? '');
    const headers = new Headers(init.headers);
    if (user && userLimit) {
      headers.set('x-ratelimit-limit', String(userLimit));
      headers.set('x-ratelimit-reset', String(window.reset));
    }
    return body instanceof Response
      ? new Response(body.body, { status: body.status, headers })
      : new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), {
          status: init.status ?? 200,
          headers,
        });
  };
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname.endsWith('.r2.cloudflarestorage.com')) return previous(url, options);
    const p = new URL(url).pathname;
    if (new URL(url).hostname === 'api.github.com')
      github.push({ path: p, method: options?.method ?? 'GET', auth: options?.headers?.Authorization });
    if (rejectedPublicCredential && options?.headers?.Authorization === 'Bearer synthetic-rejected-public')
      return new Response('{}', { status: 403 });
    if (p.includes('/oauth_access_tokens/oauth_github')) return Response.json([{ token: 'ghu_synthetic' }]);
    if (p.startsWith('/applications/')) return new Response('{}');
    if (app && p === '/repos/example/repo/installation') return Response.json({ id: 7 });
    if (app && p === '/app/installations/7/access_tokens') return Response.json({ token: 'ghs_synthetic' });
    if (denied) return new Response('', { status: 404 });
    if (p === '/repos/example/repo')
      return reply(
        {
          id: 42,
          full_name: 'example/repo',
          private: privateRepository,
          default_branch: 'main',
          html_url: 'https://github.com/example/repo',
          license: null,
        },
        options,
      );
    if (p.includes('/commits/'))
      return reply({ sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } }, options);
    // A root GitHub truncates even without recursion cannot be split (Issue c6426ee9), which keeps
    // these cases on directory-by-directory discovery; the paged reads after the split probe pass.
    if (p.includes('/git/trees/') && new URL(url).searchParams.has('recursive') && (splitProbe = true))
      return reply({ sha: 'b'.repeat(40), truncated: true, tree: [] }, options);
    if (p.includes('/git/trees/') && splitProbe && !(splitProbe = false))
      return reply({ sha: 'b'.repeat(40), truncated: true, tree: [] }, options);
    if (p.includes('/git/trees/'))
      return reply(
        {
          sha: 'b'.repeat(40),
          truncated: false,
          tree: [
            ...(submodules
              ? [
                  { path: 'vendor-a', mode: '160000', type: 'commit', sha: 'c'.repeat(40) },
                  { path: 'vendor-b', mode: '160000', type: 'commit', sha: 'd'.repeat(40) },
                  {
                    path: '.gitmodules',
                    mode: '100644',
                    type: 'blob',
                    sha: gitSha(modulesBytes),
                    size: modulesBytes.length,
                  },
                ]
              : []),
            ...(lfs
              ? lfs.files.map(([path, content]) => ({
                  path,
                  mode: '100644',
                  type: 'blob',
                  sha: gitSha(content),
                  size: content.length,
                }))
              : []),
            {
              path: 'data.bin',
              mode: '100755',
              type: 'blob',
              sha: gitSha(bytes),
              size: tooLarge ? 100 * 1024 * 1024 + 1 : bytes.length,
            },
          ],
        },
        options,
      );
    if (new URL(url).hostname === 'github.com' && p === '/example/repo.git/info/lfs/objects/batch') {
      lfs.counts.batch++;
      const body = JSON.parse(options.body);
      return Response.json({
        objects: body.objects.map(({ oid, size }) => ({
          oid,
          size,
          actions: { download: { href: `https://lfs.example.test/${oid}`, header: {} } },
        })),
      });
    }
    if (new URL(url).hostname === 'lfs.example.test') {
      lfs.counts.download++;
      return new Response(lfs.objects.get(p.slice(1)));
    }
    if (p.includes('/git/blobs/')) {
      if (limited)
        return reply('{}', options, {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(limited) },
        });
      blobs++;
      assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
      if (app) assert.equal(options.headers.Authorization, 'Bearer ghs_synthetic');
      else if (privateRepository) assert.equal(options.headers.Authorization, 'Bearer ghu_synthetic');
      if (submodules && p.endsWith(gitSha(modulesBytes))) return reply(modulesBytes, options);
      const listed = lfs?.files.find(([, content]) => p.endsWith(gitSha(content)));
      if (listed) return reply(listed[1], options);
      assert(p.endsWith(gitSha(bytes)), 'never fetch a submodule commit as blob');
      return reply(bytes, options);
    }
    throw Error(url);
  };
  const start = async (operationId = randomUUID()) =>
    modules.projectGithubImport.start._handler(s.ctx, { operationId, url: 'example/repo' });
  const advance = async id => modules.projectGithubImportWorker.run._handler(s.ctx, { id, actor: 'owner' });
  return {
    ...s,
    start,
    advance,
    bytes,
    deny: () => {
      denied = true;
    },
    limit: reset => {
      limited = reset;
    },
    window,
    github,
    blobs: () => blobs,
  };
}

test('retry-safe personal mirror publishes complete source/Work atomically and deduplicates across projects', async t => {
  const s = fixture(t),
    op = randomUUID(),
    id = await s.start(op),
    job = s.tables.projectGithubImports.get(id);
  assert.equal(await s.start(op), id);
  assert.equal(s.tables.hostedProjects.size, 1);
  assert.equal(s.tables.hostedProjects.get(job.projectId).currentBackup, null);
  await s.advance(id);
  assert.equal(s.tables.projectGithubImports.get(id).total, 1);
  await s.advance(id);
  assert.equal(s.tables.hostedProjects.get(job.projectId).currentBackup, null, 'stored file is not main');
  await s.advance(id);
  assert.equal(s.tables.projectGithubImports.get(id).phase, 'ready');
  const project = s.tables.hostedProjects.get(job.projectId),
    backup = s.tables.projectBackups.get(project.currentBackup);
  const row = [...s.tables.projectObjects.values()].find(
    row => row.projectId === job.projectId && row.digest === digest(s.bytes),
  );
  assert.deepEqual(await storedBytes(s, row), s.bytes);
  assert.equal(backup.preview.channels[0].name, 'main');
  // Git history follows publication in its own scheduled run (Issue e103bacf).
  const history = [...s.tables.projectHistory.values()].find(row => row.projectId === job.projectId);
  assert.equal(history?.importCommit, job.commit);
  assert.equal(history.importState, backup.preview.head);
  assert.equal(history.status, 'pending');
  assert.ok(s.scheduled.some(task => getFunctionName(task.fn) === 'projectHistoryImport:run'));
  const count = s.tables.projectBackups.size;
  await s.advance(id);
  assert.equal(s.tables.projectBackups.size, count);
  const second = await s.start();
  for (let i = 0; i < 3; i++) await s.advance(second);
  const bindings = [...s.tables.projectObjects.values()].filter(row => row.digest === digest(s.bytes));
  assert.equal(bindings.length, 2);
  assert.equal(bindings[0].storageId, bindings[1].storageId);
  assert.equal(s.tables.hostedProjects.get(bindings[1].projectId).owner, 'owner');
  await assert.rejects(
    modules.projectGithubImport.start._handler(s.ctx, { operationId: op, url: 'example/different' }),
    e => e.data?.code === 'WORK_OPERATION_CHANGED',
  );
});

test('a crash after storing a blob resumes from the durable cursor with the same operation', async t => {
  const s = fixture(t),
    op = randomUUID(),
    id = await s.start(op);
  await s.advance(id);
  const real = s.ctx.runMutation;
  let crash = true;
  s.ctx.runMutation = async (ref, args) => {
    if (crash && getFunctionName(ref) === 'projectGithubImportStore:advance') {
      crash = false;
      throw Error('mid-import crash');
    }
    return real(ref, args);
  };
  await s.advance(id);
  let job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'error');
  assert.equal(job.completed, 0);
  assert.equal(s.tables.hostedProjects.get(job.projectId).currentBackup, null);
  assert.equal(await s.start(op), id);
  await s.advance(id);
  await s.advance(id);
  job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'ready');
  assert.equal(job.completed, 1);
  assert.equal([...s.tables.projectObjects.values()].filter(row => row.digest === digest(s.bytes)).length, 1);
});

test('provider revocation and foreign callers cannot publish or read a partial main', async t => {
  const s = fixture(t),
    id = await s.start();
  await s.advance(id);
  s.deny();
  await s.advance(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'error');
  assert.equal(s.tables.hostedProjects.get(job.projectId).currentBackup, null);
  s.caller('outsider');
  await assert.rejects(
    modules.projectGithubImport.status._handler(s.ctx, { id }),
    e => e.data?.code === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    modules.projectGithubImportStore.resume._handler(s.ctx, { id, actor: 'outsider' }),
    e => e.code === 'PROJECT_UNAVAILABLE',
  );
});

test('import bootstrap keeps the current Work format and source pins while retaining symlink modes', () => {
  const files = [{ path: 'link', blob: digest('target'), size: 6, mode: 'symlink' }];
  const result = githubHostedProject(randomUUID(), '2026-01-01T00:00:00Z', 'a'.repeat(40), files);
  const source = JSON.parse(result.objects[0].text),
    work = JSON.parse(result.objects[1].text);
  assert.equal(source.files[0].mode, 'symlink');
  assert.equal(work.nativeHead, result.head);
  assert.equal(work.channelMoves[0].head, result.head);
  assert.ok(result.projection.entries.some(row => row.collection === 'sourceTrees'));
});

test('private repositories use existing GitHub App user credentials and remain private', async t => {
  const s = fixture(t, { privateRepository: true }),
    id = await s.start();
  for (let i = 0; i < 3; i++) await s.advance(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'ready');
  assert.equal(s.tables.hostedProjects.get(job.projectId).visibility, 'private');
  assert.ok(!JSON.stringify([...s.tables.projectGithubImports.values()]).includes('ghu_'));
});

test('truncated-tree fallback reads through the App installation token; the importer token only re-proves access', async t => {
  const s = fixture(t, { privateRepository: true, app: true }),
    id = await s.start();
  for (let i = 0; i < 3; i++) await s.advance(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'ready');
  const user = s.github.filter(request => request.auth === 'Bearer ghu_synthetic');
  assert.ok(user.length > 0);
  assert.deepEqual(
    [...new Set(user.map(request => request.path))],
    ['/repos/example/repo'],
    'the user credential never lists trees, resolves refs or fetches blobs',
  );
  for (const read of s.github.filter(request => /\/(git|commits)\//.test(request.path)))
    assert.equal(read.auth, 'Bearer ghs_synthetic', read.path);
  const counts = test => s.github.filter(request => test(request.auth ?? '')).length;
  assert.deepEqual(
    { user: job.githubRequests.user, app: job.githubRequests.app, anonymous: job.githubRequests.anonymous },
    {
      user: user.length,
      app: counts(auth => /ghs_|^Bearer eyJ|^Basic /.test(auth)),
      anonymous: counts(auth => !auth),
    },
  );
  const status = await modules.projectGithubImport.status._handler(s.ctx, { id });
  assert.equal(status.githubRequests.user, user.length);
  assert.ok(!JSON.stringify([...s.tables.projectGithubImports.values()]).includes('ghs_'));
});

test('an import stops at 10 percent of the importer limit with a retryable error naming the reset, then resumes', async t => {
  // 60 requests per hour: this import may spend 6 with the importer's credential (one is the
  // tree-split probe, Issue c6426ee9).
  const s = fixture(t, { privateRepository: true, userLimit: 60 }),
    op = randomUUID(),
    id = await s.start(op);
  for (let i = 0; i < 3 && s.tables.projectGithubImports.get(id).phase !== 'error'; i++) await s.advance(id);
  let job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'error');
  assert.equal(job.error.code, 'GITHUB_RATE_LIMIT');
  assert.equal(job.error.retryAt, s.window.reset * 1000);
  assert.ok(job.error.message.includes(new Date(s.window.reset * 1000).toISOString()));
  assert.equal(job.githubRequests.userWindow.used, 6);
  assert.equal(s.github.filter(request => request.auth === 'Bearer ghu_synthetic').length, 6);
  assert.equal(s.tables.hostedProjects.get(job.projectId).currentBackup, null);
  const progress = await modules.projectGithubImportProgress.current._handler(s.ctx, { id });
  assert.equal(progress.error.retryAt, s.window.reset * 1000);
  // GitHub's window ends: the retained window expires and the same operation resumes.
  job.githubRequests.userWindow.reset = Math.floor(Date.now() / 1000) - 1;
  s.window.reset = Math.ceil(Date.now() / 1000) + 3600;
  assert.equal(await s.start(op), id);
  for (let i = 0; i < 4 && s.tables.projectGithubImports.get(id).phase !== 'ready'; i++) await s.advance(id);
  job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'ready', JSON.stringify(job.error));
  assert.equal(job.githubRequests.userWindow.reset, s.window.reset);
});

test('a GitHub rate-limit response fails the import with its reset time instead of stalling, and resumes', async t => {
  const s = fixture(t),
    op = randomUUID(),
    id = await s.start(op),
    reset = Math.ceil(Date.now() / 1000) + 1800;
  await s.advance(id);
  s.limit(reset);
  await s.advance(id);
  let job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'error');
  assert.deepEqual(job.error, {
    code: 'GITHUB_RATE_LIMIT',
    message: `GitHub has reached its API rate limit. Retry after ${new Date(reset * 1000).toISOString()}.`,
    retryAt: reset * 1000,
  });
  const status = await modules.projectGithubImport.status._handler(s.ctx, { id });
  assert.equal(status.error.retryAt, reset * 1000);
  s.limit(null);
  assert.equal(await s.start(op), id);
  for (let i = 0; i < 3 && s.tables.projectGithubImports.get(id).phase !== 'ready'; i++) await s.advance(id);
  job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'ready');
});

test('a provider-oversized repository fails before any blob or main is published', async t => {
  const s = fixture(t, { tooLarge: true }),
    id = await s.start();
  await s.advance(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'error');
  assert.equal(job.error.code, 'GITHUB_BLOB_LIMIT');
  assert.equal(s.blobs(), 0);
  assert.equal(s.tables.hostedProjects.get(job.projectId).currentBackup, null);
  assert.equal(s.tables.projectBackups.size, 0);
});

test('hard worker interruption is observable and original-operation retry schedules durable resumption', async t => {
  const s = fixture(t),
    op = randomUUID(),
    id = await s.start(op),
    job = s.tables.projectGithubImports.get(id);
  s.tasks.set(job.task, { state: { kind: 'failed' } });
  const status = await modules.projectGithubImport.status._handler(s.ctx, { id });
  assert.equal(status.phase, 'error');
  assert.equal(status.error.code, 'GITHUB_IMPORT_INTERRUPTED');
  assert.equal(s.tables.projectGithubImports.get(id).phase, 'discovering', 'status is an observation');
  const scheduled = s.scheduled.length;
  assert.equal(await s.start(op), id);
  assert.equal(s.scheduled.length, scheduled + 1);
});

test('unknown reply after a committed cursor step cannot mark newer progress failed', async t => {
  const s = fixture(t),
    id = await s.start(),
    real = s.ctx.runMutation;
  let loseReply = true;
  s.ctx.runMutation = async (ref, args) => {
    const result = await real(ref, args);
    if (loseReply && getFunctionName(ref) === 'projectGithubImportStore:advance') {
      loseReply = false;
      throw Error('lost committed reply');
    }
    return result;
  };
  await s.advance(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.step, 1);
  assert.equal(job.phase, 'importing');
  assert.equal(job.error, undefined);
  await s.advance(id);
  await s.advance(id);
  assert.equal(s.tables.projectGithubImports.get(id).phase, 'ready');
});

test('repository denial before start leaves no project, job or selected source', async t => {
  const s = fixture(t);
  s.deny();
  await assert.rejects(s.start(), error =>
    ['GITHUB_UNAVAILABLE', 'GITHUB_SETUP_REQUIRED'].includes(error.data?.code),
  );
  assert.equal(s.tables.hostedProjects.size, 0);
  assert.equal(s.tables.projectGithubImports.size, 0);
  assert.equal(s.tables.projectBackups.size, 0);
});

test('existing explicit project deletion removes import progress and preserves another mirror shared bytes', async t => {
  const s = fixture(t),
    first = await s.start();
  for (let i = 0; i < 3; i++) await s.advance(first);
  const second = await s.start();
  for (let i = 0; i < 3; i++) await s.advance(second);
  const a = s.tables.projectGithubImports.get(first),
    b = s.tables.projectGithubImports.get(second);
  const shared = [...s.tables.projectObjects.values()].find(
    row => row.projectId === b.projectId && row.digest === digest(s.bytes),
  ).r2Key;
  const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
  await s.ctx.db.patch(a.projectId, { removal: 'deleting' });
  for (let i = 0; i < 100 && s.tables.hostedProjects.get(a.projectId).removal !== 'deleted'; i++) {
    const project = s.tables.hostedProjects.get(a.projectId);
    // The scheduled R2 prefix purge is an action; its effect is the purged mark.
    if (project.r2Purge && !project.r2PrefixPurged) project.r2PrefixPurged = true;
    await lifecycle.purge._handler(s.ctx, { projectId: a.projectId });
  }
  assert.equal(s.tables.hostedProjects.get(a.projectId).removal, 'deleted');
  assert.equal(s.tables.projectGithubImports.has(first), false);
  assert.equal(
    [...s.tables.projectGithubImportInventory.values()].some(row => row.projectId === a.projectId),
    false,
  );
  assert.equal(s.files.has(a.cursor), false);
  assert.equal(defaultR2Objects.has(`${defaultR2Config.bucket}/${shared}`), true);
  assert.equal(s.tables.hostedProjects.get(b.projectId).currentBackup !== null, true);
});

test('supported new import writes source and metadata to R2 and retries an interrupted page', async t => {
  const { fake } = await r2Setup(t);
  const s = fixture(t),
    id = await s.start();
  const job = s.tables.projectGithubImports.get(id);
  s.ctx.storage.store = () => assert.fail('imports never store Convex bytes');
  s.ctx.storage.generateUploadUrl = () => assert.fail('imports never generate Convex upload URLs');
  await s.advance(id);
  assert.equal(JSON.parse(s.tables.projectGithubImports.get(id).cursor).schema, 2);
  const run = s.ctx.runMutation;
  let lost = false;
  s.ctx.runMutation = async (ref, args) => {
    if (!lost && getFunctionName(ref) === 'projectGithubImportStore:advance' && args.completed === 1) {
      lost = true;
      throw Error('interrupted R2 page before progress');
    }
    return run(ref, args);
  };
  await s.advance(id);
  assert.equal(s.tables.projectGithubImports.get(id).phase, 'error');
  const objects = fake.objects.size;
  await s.start(job.operationId);
  await s.advance(id);
  await s.advance(id);
  assert.equal(s.tables.projectGithubImports.get(id).phase, 'ready');
  assert.ok(fake.objects.size >= objects);
  const bindings = [...s.tables.projectObjects.values()];
  assert.ok(
    bindings.length > 0 &&
      bindings.every(row => (row.recipe || (row.location === 'r2' && row.r2Committed)) && !row.storageId),
  );
  const source = bindings.find(row => row.digest === digest(s.bytes));
  assert.deepEqual(fake.objects.get(fake.key(source.r2Key)), s.bytes);
  assert.equal(bindings.filter(row => row.digest === digest(s.bytes)).length, 1);
  t.diagnostic(
    JSON.stringify({
      r2RetainedBytes: [...fake.objects.values()].reduce((sum, bytes) => sum + bytes.length, 0),
      r2Objects: fake.objects.size,
      putRequests: fake.requests.filter(row => row.method === 'PUT').length,
      headRequests: fake.requests.filter(row => row.method === 'HEAD').length,
      cursorTransferBytes: 0,
    }),
  );
});

test('legacy in-flight cursor stops clearly with a pinned-commit restart request', async t => {
  const s = fixture(t),
    id = await s.start();
  await s.ctx.db.patch(id, { protocol: undefined });
  await s.advance(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'error');
  assert.equal(job.error.code, 'IMPORT_RESTART_REQUIRED');
  assert.match(job.error.message, /projectGithubImport.start/);
  assert.ok(job.error.message.includes(job.commit));
  assert.equal(s.tables.hostedProjects.get(job.projectId).currentBackup, null);
});

test('lost staged-publication reply replays the exact projection page without duplicates', async t => {
  const s = fixture(t),
    id = await s.start();
  await s.advance(id);
  await s.advance(id);
  const mutation = s.ctx.runMutation;
  let lost = false;
  s.ctx.runMutation = async (ref, input) => {
    const result = await mutation(ref, input);
    if (!lost && getFunctionName(ref) === 'projectGithubImportPublication:stage') {
      lost = true;
      throw Error('unknown stage outcome');
    }
    return result;
  };
  await s.advance(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'error');
  assert.equal(s.tables.hostedProjects.get(job.projectId).currentBackup, null);
  await s.start(job.operationId);
  await s.advance(id);
  assert.equal(s.tables.projectGithubImports.get(id).phase, 'ready');
  const records = [...s.tables.projectWorkRecords.values()];
  assert.equal(new Set(records.map(row => `${row.collection}:${row.key}`)).size, records.length);
});

test('new import selected for R2 fails explicitly on missing configuration without Convex fallback', async t => {
  await r2Setup(t, { credentials: false });
  const s = fixture(t),
    id = await s.start();
  s.ctx.storage.store = () => assert.fail('selected R2 placement cannot fall back to Convex bytes');
  await s.advance(id);
  await s.advance(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.error.code, 'R2_NOT_CONFIGURED');
  assert.equal(s.tables.hostedProjects.get(job.projectId).currentBackup, null);
});

test('hosted import retains both gitlinks and gitmodules and reports pointer coverage', async t => {
  const s = fixture(t, { submodules: true }),
    id = await s.start();
  for (let tick = 0; tick < 10 && s.tables.projectGithubImports.get(id).phase !== 'ready'; tick++)
    await s.advance(id);
  const status = await modules.projectGithubImport.status._handler(s.ctx, { id });
  assert.equal(status.phase, 'ready');
  assert.equal(status.submodules, 2);
  assert.equal(status.report, '2 submodules kept as pointers');
  assert.equal(status.bytes, status.totalBytes, 'pointer metadata is not counted as repository file bytes');
  assert.equal(s.blobs(), 2, 'only the regular file and gitmodules are fetched');
  const job = s.tables.projectGithubImports.get(id),
    project = s.tables.hostedProjects.get(job.projectId),
    backup = s.tables.projectBackups.get(project.currentBackup);
  const row = [...s.tables.projectObjects.values()].find(
    row => row.projectId === job.projectId && row.digest === backup.preview.head,
  );
  const state = JSON.parse((await storedBytes(s, row)).toString());
  assert.deepEqual(
    state.files.filter(f => f.mode === 'gitlink').map(f => f.path),
    ['vendor-a', 'vendor-b'],
  );
  assert.equal(state.files.find(f => f.path === '.gitmodules').mode, 'file');
});

const lfsPointer = bytes =>
  Buffer.from(
    `version https://git-lfs.github.com/spec/v1\noid sha256:${digest(bytes)}\nsize ${bytes.length}\n`,
  );
/** A paged-import repository whose root holds LFS-tracked pointers beside an untracked one. */
function lfsRepo() {
  const small = Buffer.alloc(4096, 5),
    big = Buffer.alloc(2 * 1024 * 1024 + 5, 9),
    untracked = Buffer.from('a pointer nobody tracks\n');
  return {
    small,
    big,
    untracked,
    counts: { batch: 0, download: 0 },
    objects: new Map([small, big].map(bytes => [digest(bytes), bytes])),
    files: [
      ['.gitattributes', Buffer.from('*.bin filter=lfs diff=lfs merge=lfs -text\n*.dat filter=lfs\n')],
      ['asset.bin', lfsPointer(small)],
      ['copy.bin', lfsPointer(small)],
      ['big.dat', lfsPointer(big)],
      ['notes.txt', lfsPointer(untracked)],
    ],
  };
}
async function finish(s, id) {
  for (
    let tick = 0;
    tick < 12 && !['ready', 'error'].includes(s.tables.projectGithubImports.get(id).phase);
    tick++
  )
    await s.advance(id);
  return s.tables.projectGithubImports.get(id);
}
test('a paged import binds Git LFS paths to their objects, once per oid, and keeps other pointers', async t => {
  const lfs = lfsRepo(),
    s = fixture(t, { lfs }),
    id = await s.start();
  const job = await finish(s, id);
  assert.equal(job.phase, 'ready', JSON.stringify(job.error));
  assert.deepEqual(lfs.counts, { batch: 1, download: 2 }, 'one batch; the shared oid is fetched once');
  const project = s.tables.hostedProjects.get(job.projectId),
    backup = s.tables.projectBackups.get(project.currentBackup);
  const row = digestValue =>
    [...s.tables.projectObjects.values()].find(
      row => row.projectId === job.projectId && row.digest === digestValue,
    );
  const files = new Map(
    JSON.parse((await storedBytes(s, row(backup.preview.head))).toString()).files.map(file => [
      file.path,
      file,
    ]),
  );
  assert.equal(files.get('asset.bin').blob, digest(lfs.small), 'a pointer-only import fails here');
  assert.equal(files.get('copy.bin').blob, digest(lfs.small));
  assert.deepEqual(await storedBytes(s, row(digest(lfs.small))), lfs.small);
  assert.equal(files.get('big.dat').blob, digest(lfs.big));
  assert.ok(row(digest(lfs.big)).recipe, 'a large object is a chunk recipe under its oid');
  assert.equal(
    files.get('notes.txt').blob,
    digest(lfsPointer(lfs.untracked)),
    'untracked pointer text stays',
  );
  const { lfsCoverage } = await import(moduleUrl('../convex/projectGithubImportPublish.ts'));
  assert.match(lfsCoverage(job), /hold their LFS object bytes/);
});

test('a paged import over the LFS limit fails with GITHUB_LFS_LIMIT and fetches nothing; 0 keeps pointers', async t => {
  const lfs = lfsRepo(),
    s = fixture(t, { lfs });
  const refused = await finish(
    s,
    await modules.projectGithubImport.start._handler(s.ctx, {
      operationId: randomUUID(),
      url: 'example/repo',
      lfsLimitBytes: 1024 * 1024,
    }),
  );
  assert.equal(refused.phase, 'error');
  assert.equal(refused.error.code, 'GITHUB_LFS_LIMIT');
  assert.match(refused.error.message, /over this import's 1\.00 MiB LFS limit/);
  assert.deepEqual(lfs.counts, { batch: 0, download: 0 });
  const kept = await finish(
    s,
    await modules.projectGithubImport.start._handler(s.ctx, {
      operationId: randomUUID(),
      url: 'example/repo',
      lfsLimitBytes: 0,
    }),
  );
  assert.equal(kept.phase, 'ready');
  assert.deepEqual(lfs.counts, { batch: 0, download: 0 });
  const { lfsCoverage } = await import(moduleUrl('../convex/projectGithubImportPublish.ts'));
  assert.match(lfsCoverage(kept), /pointers remain/);
});

test('a rejected public credential still imports and publishes complete hosted main without a user token', async t => {
  const s = fixture(t, { rejectedPublicCredential: true });
  const id = await s.start();
  await s.advance(id);
  await s.advance(id);
  await s.advance(id);
  const job = s.tables.projectGithubImports.get(id);
  assert.equal(job.phase, 'ready');
  assert(s.tables.hostedProjects.get(job.projectId).currentBackup);
  const sourceReads = s.github.filter(call => call.path !== '/repos/example/repo');
  assert(sourceReads.length > 0);
  assert(
    sourceReads.every(call => call.auth === undefined),
    'ref, tree, blob and publication reads keep anonymous access',
  );
  const row = [...s.tables.projectObjects.values()].find(
    row => row.projectId === job.projectId && row.digest === digest(s.bytes),
  );
  assert.deepEqual(await storedBytes(s, row), s.bytes);
});
