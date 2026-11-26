// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { state, projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const names = [
  'gitServeStore',
  'gitServe',
  'projectSourcePackClient',
  'projectStateSourceSelection',
  'projectStateSourceApi',
  'projectMain',
  'projectSourceReview',
  'projectHostedChannels',
  'projectObjectDownloads',
  'projectExchangeActions',
  'projectBackups',
  'backupTransfer',
  'lifecycleActions',
  'projectBackupActions',
  'projectProposalActions',
  'projectWorkActions',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
function fixture() {
  const s = state([]);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project', visibility: 'public' }));
  s.tables.projectGithubMirrors.set('mirror', {
    _id: 'mirror',
    projectId: 'project',
    repository: 'example/repo',
    mapping: '{}',
  });
  s.caller(null);
  const query = s.ctx.db.query;
  const reads = [];
  s.ctx.db.query = table => {
    reads.push(table);
    assert(['projectGithubMirrors'].includes(table), `anonymous request must not read ${table}`);
    return query(table);
  };
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) => {
    const [name, fn] = getFunctionName(ref).split(':');
    return modules[name][fn]._handler(s.ctx, args);
  };
  s.ctx.storage.get = s.ctx.storage.getUrl = () => assert.fail('anonymous object IO');
  return { s, reads };
}
const signin = error =>
  (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE' &&
  /sign in/i.test(error.data?.message ?? error.message);
for (const version of [0, 2])
  for (const service of ['info/refs', 'git-upload-pack'])
    test(`anonymous Git v${version} ${service} refuses before history, pack, counters or body IO and names its mirror`, async () => {
      const { s, reads } = fixture();
      const request = {
        url: `https://forge.example/git/project.git/${service}?service=git-upload-pack`,
        method: service === 'info/refs' ? 'GET' : 'POST',
        headers: new Headers(version === 2 ? { 'git-protocol': 'version=2' } : {}),
        arrayBuffer: () => assert.fail('anonymous body read'),
      };
      const reply = await modules.gitServe.serve._handler(s.ctx, request);
      assert.equal(reply.status, 401);
      assert.match(reply.headers.get('www-authenticate'), /^Basic /);
      assert.match(await reply.text(), /Sign in.*https:\/\/github.com\/example\/repo.git/s);
      assert.deepEqual(reads, ['projectGithubMirrors']);
    });
for (const [name, fn, args] of [
  ['projectObjectDownloads', 'signDownloads', { projectId: 'project', digests: [] }],
  ['projectObjectDownloads', 'describe', { projectId: 'project', digests: [] }],
  ['projectObjectDownloads', 'source', { projectId: 'project', backupId: 'missing' }],
  ['projectSourcePackClient', 'latest', { projectId: 'project' }],
  ['projectStateSourceSelection', 'client', { projectId: 'project', state: 'a'.repeat(64) }],
  ['projectStateSourceApi', 'read', { projectId: 'project', state: 'a'.repeat(64), digests: [] }],
  [
    'projectSourceReview',
    'read',
    { projectId: 'project', backupId: 'missing', base: 'a'.repeat(64), head: 'a'.repeat(64) },
  ],
  ['projectMain', 'current', { projectId: 'project' }],
  ['projectMain', 'objects', { projectId: 'project', digests: [] }],
  ['projectHostedChannels', 'current', { projectId: 'project' }],
  ['projectObjectDownloads', 'lanePage', { projectId: 'project', digests: [], signed: true }],
  ['projectExchangeActions', 'downloadBatch', { projectId: 'project', digests: [] }],
  ['projectExchangeActions', 'downloadPart', { projectId: 'project', digest: 'a'.repeat(64), offset: 0 }],
  ['projectExchangeActions', 'checkpoint', { backupId: 'missing' }],
  ['projectExchangeActions', 'manifest', { backupId: 'missing' }],
  ['projectBackups', 'history', { projectId: 'project', paginationOpts: { cursor: null, numItems: 10 } }],
  ['projectBackupActions', 'downloadPart', { id: 'missing', offset: 0 }],
  ['projectProposalActions', 'downloadPart', { id: 'missing', offset: 0, digest: 'a'.repeat(64) }],
  ['projectWorkActions', 'exportJournal', { projectId: 'project' }],
  ['projectWorkActions', 'exportPlanning', { projectId: 'project' }],
  ['backupTransfer', 'sign', { id: 'missing', digest: 'a'.repeat(64) }],
])
  test(`anonymous ${name}:${fn} refuses before source or archive IO`, async () => {
    const { s } = fixture();
    await assert.rejects(modules[name][fn]._handler(s.ctx, args), signin);
  });

test('anonymous legacy web snapshot download refuses before provider or object IO', async () => {
  const { s } = fixture();
  await assert.rejects(
    modules.lifecycleActions.downloadPart._handler(s.ctx, { id: 'missing', offset: 0 }),
    error => error.data?.code === 'GITHUB_UNAVAILABLE' && /Sign in/.test(error.data.message),
  );
});

test('Worker direct and legacy anonymous sessions refuse refs and fetches with zero bucket or request-body IO', async t => {
  const { fakeSourceR2 } = await import('./convex-source-r2-fixture.mjs');
  fakeSourceR2(t);
  const { s } = fixture();
  const { default: worker } = await import('../dist/git-byte-worker.js');
  const { signWorkerToken, workerTokenKey } = await import('../dist/git-worker-plan.js');
  const previous = process.env.FORGE_GIT_WORKER_URL;
  process.env.FORGE_GIT_WORKER_URL = 'https://worker.example';
  const priorFetch = globalThis.fetch;
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_GIT_WORKER_URL;
    else process.env.FORGE_GIT_WORKER_URL = previous;
    globalThis.fetch = priorFetch;
  });
  let forwarded = 0;
  globalThis.fetch = (url, init) => {
    forwarded++;
    return modules.gitServe.serve._handler(s.ctx, new Request(url, init));
  };
  const session = signWorkerToken(
    { p: 'project', c: '', e: Date.now() + 60000 },
    workerTokenKey('synthetic'),
  );
  for (const prefix of ['/git/project.git', `/gitw/${session}/project.git`]) {
    for (const service of ['info/refs', 'git-upload-pack']) {
      const reply = await worker.fetch(
        {
          url: `https://worker.example${prefix}/${service}?service=git-upload-pack`,
          method: service === 'info/refs' ? 'GET' : 'POST',
          headers: new Headers({ 'git-protocol': 'version=2' }),
          arrayBuffer: () => assert.fail('anonymous Worker body read'),
        },
        {
          FORGE_CONVEX_SITE: 'https://forge.example',
          FORGE_R2: { get: () => assert.fail('anonymous Worker bucket IO') },
        },
        { waitUntil: () => assert.fail('anonymous byte pump') },
      );
      assert.equal(reply.status, 401);
      assert.match(await reply.text(), /Sign in.*github.com\/example\/repo.git/s);
    }
  }
  assert.equal(forwarded, 4, 'one backend auth check per refused Worker request');
});

test('a signed-in public reader can download the bulk source pack with the existing single mutation', async t => {
  const { fakeSourceR2 } = await import('./convex-source-r2-fixture.mjs');
  const r2 = fakeSourceR2(t),
    s = state([]);
  s.tables.hostedProjects.set('project', projectRow({ _id: 'project', visibility: 'public' }));
  const latest = {
    stateRef: 'a'.repeat(64),
    sha256: 'b'.repeat(64),
    objectKey: 'v1/p/project/source-pack/synthetic.gz',
    size: 10,
    fileCount: 1,
    createdAt: 1,
  };
  s.tables.projectSourcePacks.set('pack', { _id: 'pack', projectId: 'project', latest });
  s.caller('public-reader');
  const pack = await modules.projectSourcePackClient.latest._handler(s.ctx, { projectId: 'project' });
  assert.equal(pack.sha256, latest.sha256);
  assert.match(pack.url, /X-Amz-Signature=/);
  assert.deepEqual(r2.requests, [], 'the mutation signs without fetching pack bytes');
});

test('CLI clone without a login refuses before network or local checkout IO', async t => {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { hostedCloneCli } = await import('../dist/hosted-clone-cli.js');
  const { describeFailure } = await import('../dist/system-errors.js');
  const directory = mkdtempSync(join(tmpdir(), 'forge-signedout-clone-'));
  const keys = ['XDG_CONFIG_HOME', 'FORGE_AUTH_TOKEN', 'FORGE_DEPLOYMENT_URL'];
  const prior = keys.map(key => process.env[key]);
  process.env.XDG_CONFIG_HOME = directory;
  delete process.env.FORGE_AUTH_TOKEN;
  delete process.env.FORGE_DEPLOYMENT_URL;
  const fetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('anonymous CLI clone network IO');
  t.after(() => {
    keys.forEach((key, i) =>
      prior[i] === undefined ? delete process.env[key] : (process.env[key] = prior[i]),
    );
    globalThis.fetch = fetch;
    rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    hostedCloneCli(
      ['public-project', join(directory, 'clone'), '--deployment', 'https://forge.example'],
      undefined,
      () => assert.fail('anonymous clone reached CLI preparation'),
    ),
    error => {
      const refusal = describeFailure(error, { topLevel: true });
      assert.equal(refusal.code, 'SIGN_IN_REQUIRED');
      assert.match(refusal.message, /Nothing was copied/);
      assert.equal(refusal.recovery?.nothingChanged, true);
      assert.equal(refusal.next, "nforge login --deployment 'https://forge.example'");
      return true;
    },
  );
  assert.equal(existsSync(join(directory, 'clone')), false);
});
