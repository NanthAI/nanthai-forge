import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { githubHostedProject } from '../dist/hosted-github-bootstrap.js';
import { digest } from '../dist/hash.js';
const modules = {};
for (const name of [
  'projectGithubImportStore',
  'projectGithubImportObjects',
  'projectGithubImportWorker',
  'projectGithubImport',
  'projectObjectRecipeStore',
])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const gitSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function fixture(t, { privateRepository = false, tooLarge = false } = {}) {
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
  const envKeys = ['CLERK_SECRET_KEY', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET'];
  const priorEnv = envKeys.map(key => process.env[key]);
  if (privateRepository) for (const key of envKeys) process.env[key] = 'synthetic-fixture';
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
    envKeys.forEach((key, index) => {
      if (priorEnv[index] === undefined) delete process.env[key];
      else process.env[key] = priorEnv[index];
    });
  });
  const bytes = Buffer.from([0, 255, 128, 10]);
  let denied = false,
    blobs = 0;
  globalThis.fetch = async (url, options) => {
    const p = new URL(url).pathname;
    if (p.includes('/oauth_access_tokens/oauth_github')) return Response.json([{ token: 'ghu_synthetic' }]);
    if (p.startsWith('/applications/')) return new Response('{}');
    if (denied) return new Response('', { status: 404 });
    if (p === '/repos/example/repo')
      return Response.json({
        full_name: 'example/repo',
        private: privateRepository,
        default_branch: 'main',
        html_url: 'https://github.com/example/repo',
        license: null,
      });
    if (p.includes('/commits/'))
      return Response.json({ sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } });
    if (p.includes('/git/trees/'))
      return Response.json({
        sha: 'b'.repeat(40),
        truncated: false,
        tree: [
          {
            path: 'data.bin',
            mode: '100755',
            type: 'blob',
            sha: gitSha(bytes),
            size: tooLarge ? 100 * 1024 * 1024 + 1 : bytes.length,
          },
        ],
      });
    if (p.includes('/git/blobs/')) {
      blobs++;
      assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
      if (privateRepository) assert.equal(options.headers.Authorization, 'Bearer ghu_synthetic');
      return new Response(bytes);
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
  assert.deepEqual(Buffer.from(await s.files.get(row.storageId).blob.arrayBuffer()), s.bytes);
  assert.equal(backup.preview.channels[0].name, 'main');
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
  ).storageId;
  const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
  await s.ctx.db.patch(a.projectId, { removal: 'deleting' });
  for (let i = 0; i < 100 && s.tables.hostedProjects.get(a.projectId).removal !== 'deleted'; i++)
    await lifecycle.purge._handler(s.ctx, { projectId: a.projectId });
  assert.equal(s.tables.hostedProjects.get(a.projectId).removal, 'deleted');
  assert.equal(s.tables.projectGithubImports.has(first), false);
  assert.equal(s.files.has(a.cursor), false);
  assert.equal(s.files.has(shared), true);
  assert.equal(s.tables.hostedProjects.get(b.projectId).currentBackup !== null, true);
});
