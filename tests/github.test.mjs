import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureGithub, githubInput, githubRepository, githubJson } from '../dist/github.js';
import { ForgeError } from '../dist/errors.js';
import { moduleUrl } from './convex-module.mjs';
import { setup as r2Setup } from './r2-harness.mjs';
import { GraphQuery } from '../dist/graph-query.js';
import { hostedQuery } from '../dist/hosted-query.js';
import { validateArtifact } from '../dist/artifact-validation.js';

test('GitHub response reset deadlines survive hosted errors while ordinary denials stay unchanged', async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  const { report } = await import(moduleUrl('../convex/errors.ts'));
  const { hostedRetryAt, hostedFailure } = await import(moduleUrl('../web/src/snapshot.ts'));
  const cases = [
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060' }, 1_060_000],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060', 'retry-after': '120' }, 1_120_000],
    [403, { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '4600', 'retry-after': '2' }, 1_002_000],
    [429, { 'retry-after': '5' }, 1_005_000],
    [429, { 'retry-after': '0' }, 1_000_000],
    [429, { 'retry-after': '' }, 1_060_000],
    [429, {}, 1_060_000],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '900', 'retry-after': '-5' }, 1_060_000],
    [
      429,
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060.1', 'retry-after': 'invalid' },
      1_060_000,
    ],
    [
      429,
      {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '9007199254740991',
        'retry-after': '9007199254740991',
      },
      1_060_000,
    ],
  ];
  for (const [status, headers, retryAt] of cases) {
    let requests = 0;
    await assert.rejects(
      githubJson('/repos/example/project', undefined, async () => {
        requests++;
        return new Response('{}', { status, headers });
      }),
      error => {
        assert.equal(error.code, 'GITHUB_RATE_LIMIT');
        assert.equal(error.retryAt, retryAt);
        assert.throws(
          () => report(error),
          hosted => {
            const failure = hostedFailure(hosted);
            assert.equal(failure.message, error.message);
            assert.equal(hostedRetryAt(hosted), retryAt);
            assert.equal(hostedRetryAt(failure), retryAt);
            return true;
          },
        );
        return true;
      },
    );
    assert.equal(requests, 1);
  }
  await assert.rejects(
    githubJson('/repos/example/private', undefined, async () => new Response('{}', { status: 403 })),
    error => {
      assert.equal(error.code, 'GITHUB_UNAVAILABLE');
      assert.equal(error.retryAt, undefined);
      return true;
    },
  );
  assert.throws(
    () => report(new ForgeError('GITHUB_UNAVAILABLE', 'Current access failed.')),
    error => {
      assert.deepEqual(error.data, { code: 'GITHUB_UNAVAILABLE', message: 'Current access failed.' });
      assert.equal(hostedRetryAt(hostedFailure(error)), undefined);
      return true;
    },
  );
  for (const retryAt of [NaN, -1, '1060000', Number.MAX_SAFE_INTEGER + 1])
    assert.equal(hostedRetryAt({ retryAt }), undefined);
});

const sha = 'a'.repeat(40),
  treeSha = 'b'.repeat(40);
function fixture(files, { truncated = false, corrupt = false } = {}) {
  const blobs = new Map();
  const tree = Object.entries(files).map(([path, text]) => {
    const bytes = Buffer.from(text);
    const id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    blobs.set(id, { content: bytes.toString('base64'), encoding: 'base64', sha: id });
    return {
      path,
      sha: id,
      type: 'blob',
      mode: path.endsWith('link.ts') ? '120000' : '100644',
      size: bytes.length,
    };
  });
  const repository = {
    full_name: 'example/project',
    private: false,
    default_branch: 'main',
    html_url: 'https://github.com/example/project',
    license: { spdx_id: 'MIT', name: 'MIT License' },
  };
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    const blob = blobs.get(path.split('/').at(-1));
    const body = path.endsWith('/project')
      ? repository
      : path.includes('/commits/')
        ? { sha, commit: { tree: { sha: treeSha } } }
        : path.includes('/git/trees/')
          ? { tree, truncated }
          : {
              ...blob,
              ...(corrupt
                ? {
                    content: Buffer.from(
                      'x'.repeat(blob.content ? Buffer.from(blob.content, 'base64').length : 0),
                    ).toString('base64'),
                  }
                : {}),
            };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return { repository, request, requests };
}

test('GitHub URL capture pins bytes, reuses graph queries, respects ignores and preserves license documents', async () => {
  const f = fixture({
    '.gitignore': '*.ignored.ts\nblocked/\n',
    'nested/.gitignore': 'hidden.ts\n!keep.ignored.ts\n',
    'main.ts': 'import { greet } from "./greeting"; export const result = greet();',
    'greeting.ts': 'export function greet() { return "hello"; }',
    'nested/hidden.ts': 'export const hidden = 1;',
    'nested/keep.ignored.ts': 'export const kept = 1;',
    'blocked/.gitignore': '!visible.ts\n',
    'blocked/visible.ts': 'export const invisible = 1;',
    '.env.ts': 'secret',
    'node_modules/ignored.ts': 'ignored',
    'link.ts': 'linked',
    '.nforge/home.md': '# Optional home\n```forge\n{"component":"coverage"}\n```',
    '.nforge/.gitignore': 'ignored/\n',
    '.nforge/ignored/home.md': 'DO_NOT_RETURN',
    'README.md': '# Project',
    LICENSE: 'Original MIT license',
    'COMMERCIAL_LICENSE.md': 'Original commercial terms',
    'nested/NOTICE.md': 'Attribution',
  });
  assert.deepEqual(githubInput('https://github.com/example/project.git'), {
    repository: 'example/project',
    ref: undefined,
  });
  assert.deepEqual(githubInput('https://github.com/example/project/tree/feature/foo'), {
    repository: 'example/project',
    ref: 'feature/foo',
  });
  assert.throws(() => githubInput('https://github.com.evil/example/project'), { code: 'BAD_REPOSITORY' });
  const repo = await githubRepository('example/project', undefined, f.request);
  const artifact = await captureGithub(repo, undefined, undefined, async () => {}, f.request);
  validateArtifact(artifact.pack);
  assert.equal(artifact.pack.source.gitHead, sha);
  assert.equal(artifact.pack.source.scope, 'included-language-git-revision');
  assert.equal(artifact.pack.source.excluded.gitignored, 4);
  assert.equal(artifact.pack.source.excluded['sensitive-name'], 1);
  assert.deepEqual(Object.keys(artifact.content), ['greeting.ts', 'main.ts', 'nested/keep.ignored.ts']);
  const home = hostedQuery(artifact, 'home', sha);
  assert.equal(home.file, '.nforge/home.md');
  assert.match(home.text, /Optional home/);
  assert.equal(home.scope, 'git-revision');
  assert.equal(home.digest, createHash('sha256').update(home.text).digest('hex'));
  assert.ok(!artifact.documents['.nforge/ignored/home.md']);
  assert.ok(!hostedQuery(artifact, 'readme', sha).text.includes('Optional home'));
  assert.throws(() => hostedQuery(artifact, 'home', 'c'.repeat(40)), { code: 'SOURCE_STALE' });
  assert.throws(() => hostedQuery(artifact, 'home?state=other', sha), { code: 'STATE_MISMATCH' });
  assert.equal(hostedQuery({ ...artifact, documents: {} }, 'home', sha).file, null);
  assert.equal(artifact.documents.LICENSE, 'Original MIT license');
  assert.equal(artifact.documents['COMMERCIAL_LICENSE.md'], 'Original commercial terms');
  const status = hostedQuery(artifact, 'status', sha);
  assert.equal(status.hosted.license, 'MIT');
  assert.equal(status.freshness, 'current');
  assert.equal(hostedQuery(artifact, 'status', 'c'.repeat(40)).freshness, 'stale');
  assert.match(hostedQuery(artifact, 'readme', sha).text, /Original MIT license/);
  assert.match(hostedQuery(artifact, 'readme', sha).text, /Original commercial terms/);
  const notice = 'Verbatim ~~~~ attribution ~~~~~';
  assert.ok(
    hostedQuery({ ...artifact, documents: { LICENSE: notice } }, 'readme', sha).text.includes(notice),
  );
  assert.throws(() => hostedQuery(artifact, 'source?file=main.ts', 'c'.repeat(40)), { code: 'SOURCE_STALE' });
  assert.throws(() => hostedQuery(artifact, 'files?state=other', sha), { code: 'STATE_MISMATCH' });
  assert.throws(() => hostedQuery(artifact, 'files?offset=1.5', sha), { code: 'BAD_ARGUMENT' });
  assert.throws(
    () => hostedQuery({ ...artifact, content: { ...artifact.content, 'main.ts': 'changed' } }, 'status', sha),
    { code: 'ARTIFACT_INTEGRITY' },
  );
  assert.equal(artifact.documents['nested/NOTICE.md'], 'Attribution');
  assert.ok(!f.requests.some(r => /\.env|node_modules/.test(r.url)));
  const query = new GraphQuery(artifact.pack, {
    root: '',
    source: artifact.pack.source,
    content: new Map(Object.entries(artifact.content)),
  });
  assert.equal(query.inspect('greet').total, 1);
  assert.equal(query.imports('main.ts').results[0].target, 'greeting.ts');
  assert.equal(query.references('greet').total, 2);
  assert.match(query.source('main.ts').results[0].text, /greet/);
});

test('GitHub acquisition refuses truncated trees, corrupt blobs and upstream denials without publishing partial data', async () => {
  const truncated = fixture({ 'a.ts': 'export const a = 1;' }, { truncated: true });
  await assert.rejects(
    captureGithub(truncated.repository, undefined, undefined, undefined, truncated.request),
    { code: 'PATH_LIMIT' },
  );
  const corrupt = fixture({ 'a.ts': 'export const a = 1;' }, { corrupt: true });
  await assert.rejects(captureGithub(corrupt.repository, undefined, undefined, undefined, corrupt.request), {
    code: 'ARTIFACT_INTEGRITY',
  });
  await assert.rejects(
    githubRepository('example/private', undefined, async () => new Response('{}', { status: 404 })),
    { code: 'GITHUB_UNAVAILABLE' },
  );
  await assert.rejects(
    githubRepository(
      'example/project',
      undefined,
      async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    ),
    { code: 'GITHUB_RATE_LIMIT' },
  );
});

test('hosted linked documents retain exact revision bytes, nested ignores and old-snapshot unavailability', async () => {
  const text = '# Retained guide\n\n| Key | Value |\n| --- | --- |\n| Original | bytes |\n';
  const f = fixture({
    'a.ts': 'export const a=1;',
    'README.md': '# Start\n[Guide](docs/guide.md)',
    'docs/guide.md': text,
    'docs/.gitignore': 'hidden.md\n',
    'docs/hidden.md': 'IGNORED_DOCUMENT',
    '.env.md': 'SECRET_DOCUMENT',
    '.git/private.md': 'GIT_DOCUMENT',
  });
  const artifact = await captureGithub(f.repository, undefined, undefined, async () => {}, f.request);
  assert.equal(artifact.documents['docs/guide.md'], text);
  assert.equal(artifact.documents['docs/hidden.md'], undefined);
  assert.equal(artifact.documents['.env.md'], undefined);
  assert.equal(artifact.documents['.git/private.md'], undefined);
  const endpoint = 'readme?file=docs%2Fguide.md&state=' + artifact.pack.source.id;
  const doc = hostedQuery(artifact, endpoint, sha);
  assert.equal(doc.text, text);
  assert.equal(doc.scope, 'git-revision');
  assert.equal(doc.digest, createHash('sha256').update(text).digest('hex'));
  assert.ok(!hostedQuery(artifact, 'readme', sha).text.includes('Retained guide'));
  for (const file of [
    '../README.md',
    '/README.md',
    'docs/../README.md',
    'docs/hidden.md',
    '.env.md',
    '.git/private.md',
    'a.ts',
  ])
    assert.throws(() => hostedQuery(artifact, 'readme?file=' + encodeURIComponent(file), sha), {
      code: 'NOT_FOUND',
    });
  assert.throws(() => hostedQuery(artifact, endpoint, 'c'.repeat(40)), { code: 'SOURCE_STALE' });
  assert.throws(() => hostedQuery(artifact, 'readme?file=docs%2Fguide.md&state=wrong', sha), {
    code: 'STATE_MISMATCH',
  });
  const old = { ...artifact, documents: { 'README.md': artifact.documents['README.md'] } },
    before = JSON.stringify(old);
  assert.throws(
    () => hostedQuery(old, endpoint, sha),
    error => error.code === 'NOT_FOUND' && /explicit re-index/.test(error.message),
  );
  assert.equal(JSON.stringify(old), before);
  assert.match(hostedQuery(old, 'readme', sha).text, /Guide/);
});

test('Hosted reads retain imported attribution while checking current provider metadata and access', async t => {
  const f = fixture({ 'main.ts': 'export const value = 1;', LICENSE: 'Original MIT license' });
  const artifact = await captureGithub(f.repository, undefined, undefined, async () => {}, f.request);
  const original = structuredClone(artifact);
  const current = {
    ...f.repository,
    full_name: 'example/renamed',
    html_url: 'https://github.com/example/renamed',
    private: true,
    license: { spdx_id: 'Apache-2.0', name: 'Apache License' },
  };
  const status = hostedQuery(artifact, 'status', 'c'.repeat(40), current);
  assert.equal(status.hosted.license, 'MIT');
  assert.equal(status.hosted.currentLicense, 'Apache-2.0');
  assert.equal(status.hosted.attributionScope, 'import-metadata');
  assert.equal(status.hosted.visibility, 'private');
  assert.equal(status.name, current.full_name);
  assert.equal(status.hosted.upstream, current.html_url);
  assert.equal(status.currentGitHead, 'c'.repeat(40));
  assert.equal(status.gitHead, sha);
  assert.deepEqual(artifact, original);
  assert.throws(() => hostedQuery(artifact, 'readme', 'c'.repeat(40), current), { code: 'SOURCE_STALE' });
  assert.match(hostedQuery(artifact, 'readme', sha, current).text, /Original MIT license/);

  const { job, providers } = await import('./hosted-fixture.mjs');
  const { encodeHostedArtifact } = await import('../dist/hosted-artifact.js');
  const { readSource } = await import(moduleUrl('../convex/hosted.ts'));
  const { s } = await r2Setup(t);
  s.tables.imports.set('own', { ...job(), scope: 'public', visibility: 'public' });
  s.caller(null);
  const blob = await encodeHostedArtifact(artifact);
  s.file('saved', blob);
  const cleanup = providers(() => false, false, 'c'.repeat(40));
  const providerFetch = globalThis.fetch;
  let privateNow = false,
    observedHead = 'c'.repeat(40);
  globalThis.fetch = async (input, init) => {
    const response = await providerFetch(input, init);
    if (new URL(input).pathname.includes('/commits/')) return Response.json({ sha: observedHead });
    if (new URL(input).pathname === '/repos/example/project')
      return Response.json({ ...(await response.json()), private: privateNow, license: current.license });
    return response;
  };
  try {
    const result = JSON.parse(await readSource(s.ctx, { id: 'own', endpoint: 'status' }));
    assert.equal(result.hosted.license, 'MIT');
    assert.equal(result.hosted.currentLicense, 'Apache-2.0');
    assert.equal(result.hosted.visibility, 'public');
    assert.equal(result.gitHead, sha);
    assert.equal(result.currentGitHead, 'c'.repeat(40));
    assert.equal(s.files.get('saved').blob, blob);
    observedHead = sha;
    const readme = JSON.parse(await readSource(s.ctx, { id: 'own', endpoint: 'readme' }));
    assert.match(readme.text, /Original MIT license/);
    const reads = s.reads();
    privateNow = true;
    await assert.rejects(
      readSource(s.ctx, { id: 'own', endpoint: 'status' }),
      error => error.data?.code === 'GITHUB_UNAVAILABLE',
    );
    assert.equal(s.reads(), reads);
  } finally {
    cleanup();
  }
});
