// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { moduleUrl } from './convex-module.mjs';
import { githubBlobPack } from '../dist/github-blob-pack.js';
import { streamGithubBlobPack } from '../dist/github-blob-pack-stream.js';
import { blobPackResponse, wantedBlobResponse } from './github-blob-pack-fixture.mjs';
const { authorizeImportGithub } = await import(moduleUrl('../convex/githubImportAccess.ts'));
const sha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const entry = (bytes, path = 'source') => ({ path, sha: sha(bytes), size: bytes.length, mode: '100644' });

function accessFixture(t, { privateRepo = false, denied = false, installed = true, exhausted = true } = {}) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const settings = {
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    GITHUB_PUBLIC_TOKEN: 'deployment-fixture',
    CLERK_SECRET_KEY: 'clerk-fixture',
    GITHUB_APP_CLIENT_ID: 'client-fixture',
    GITHUB_APP_CLIENT_SECRET: 'client-secret-fixture',
  };
  const prior = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const paths = [],
    tokens = [];
  const request = async (url, init) => {
    const path = new URL(url).pathname,
      auth = init.headers.Authorization;
    paths.push(path);
    if (path === '/repos/fixture/source/installation')
      return Response.json({ id: 42 }, { status: installed ? 200 : 404 });
    if (path === '/app/installations/42/access_tokens') {
      tokens.push(JSON.parse(init.body));
      return Response.json({ token: 'ghs_metadata_fixture' });
    }
    if (path.startsWith('/v1/users/')) return Response.json([{ token: 'ghu_importer_fixture' }]);
    if (path === '/applications/client-fixture/token') return Response.json({});
    if (path === '/repos/fixture/source') {
      if (exhausted && (!auth || auth === 'Bearer deployment-fixture'))
        return Response.json(
          {},
          {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 300),
            },
          },
        );
      if (auth === 'Bearer ghu_importer_fixture' && denied) return Response.json({}, { status: 404 });
      return Response.json({
        id: 17,
        full_name: 'fixture/source',
        private: privateRepo,
        default_branch: 'main',
        html_url: 'https://github.com/fixture/source',
        license: null,
      });
    }
    if (path === '/user/installations') return Response.json({ installations: [] });
    throw Error(`unexpected fixture endpoint ${path}`);
  };
  return { request, paths, tokens };
}

test('shared metadata exhaustion reaches the App quota with a metadata-only repository probe', async t => {
  const f = accessFixture(t);
  const access = await authorizeImportGithub('fixture/source', 'importer', f.request);
  assert.equal(access.repository.private, false);
  assert.equal(access.token, 'ghs_metadata_fixture');
  assert.deepEqual(f.tokens, [{ repositories: ['source'], permissions: { metadata: 'read' } }]);
  assert.equal(f.paths.length, 4, 'one failed metadata read, installation, scoped mint, metadata read');
});

test('healthy import access adds no GitHub or Convex calls', async t => {
  const f = accessFixture(t, { exhausted: false });
  const access = await authorizeImportGithub('fixture/source', 'importer', f.request);
  assert.equal(access.token, 'deployment-fixture');
  assert.deepEqual(f.paths, ['/repos/fixture/source']);
  assert.deepEqual(f.tokens, []);
});

test('App metadata cannot authorize private import: current importer access still decides', async t => {
  for (const denied of [false, true])
    await t.test(denied ? 'revoked importer' : 'authorized importer', async t => {
      const f = accessFixture(t, { privateRepo: true, denied });
      if (denied)
        await assert.rejects(authorizeImportGithub('fixture/source', 'importer', f.request), {
          code: 'GITHUB_UNAVAILABLE',
        });
      else
        assert.equal(
          (await authorizeImportGithub('fixture/source', 'importer', f.request)).token,
          'ghu_importer_fixture',
        );
      assert.ok(f.paths.some(path => path.startsWith('/v1/users/')));
      assert.deepEqual(f.tokens[0].permissions, { metadata: 'read' });
    });
});

test('an unavailable optional App preserves the original provider reset', async t => {
  const f = accessFixture(t, { installed: false });
  await assert.rejects(
    authorizeImportGithub('fixture/source', 'importer', f.request),
    e => e.code === 'GITHUB_RATE_LIMIT' && e.retryAt > Date.now(),
  );
  assert.deepEqual(f.tokens, []);
});

test('a blob page uses one Git fetch, coalesces duplicate objects and verifies every result', async () => {
  const bytes = [Buffer.alloc(0), Buffer.from('hello'), Buffer.from('target')];
  const bodies = new Map(bytes.map(value => [sha(value), value]));
  const entries = bytes.map(value => entry(value));
  entries.push({ ...entries[1], path: 'copy' });
  let calls = 0;
  const result = await githubBlobPack('fixture/source', entries, 'ghs_fixture', async (url, init) => {
    calls++;
    assert.equal(url, 'https://github.com/fixture/source.git/git-upload-pack');
    assert.equal(init.redirect, 'error');
    assert.equal(
      init.headers.authorization,
      'Basic ' + Buffer.from('x-access-token:ghs_fixture').toString('base64'),
    );
    return wantedBlobResponse(init, bodies);
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, bodies);
  assert.equal(
    (
      await githubBlobPack('fixture/source', [{ ...entries[0], mode: '160000' }], undefined, async () =>
        assert.fail('gitlinks make no request'),
      )
    ).size,
    0,
  );
});

const object = (type, bytes, base = Buffer.alloc(0)) => {
  let size = bytes.length,
    byte = (type << 4) | (size & 15),
    head = [];
  for (size = Math.floor(size / 16); size; size = Math.floor(size / 128)) {
    head.push(byte | 128);
    byte = size & 127;
  }
  head.push(byte);
  return Buffer.concat([Buffer.from(head), base, deflateSync(bytes)]);
};
const packOf = objects => {
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const body = Buffer.concat([header, ...objects]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
};
const delta = (base, value) => Buffer.concat([Buffer.from([base.length, value.length, value.length]), value]);

test('blob pages resolve forward ref deltas and dependent offset deltas without losing pinned bytes', async () => {
  const a = Buffer.from('base'),
    b = Buffer.from('changed'),
    c = Buffer.from('third');
  const ref = object(7, delta(a, b), Buffer.from(sha(a), 'hex'));
  const whole = object(3, a),
    back = ref.length + whole.length;
  assert.ok(back < 128);
  const pack = packOf([ref, whole, object(6, delta(b, c), Buffer.from([back]))]);
  const result = await githubBlobPack(
    'fixture/source',
    [a, b, c].map(value => entry(value)),
    undefined,
    async () => blobPackResponse(pack),
  );
  for (const value of [a, b, c]) assert.deepEqual(result.get(sha(value)), value);
});

for (const damage of ['changed', 'missing', 'trailer', 'delta-size'])
  test(`a ${damage} blob page never returns unverified source`, async () => {
    const value = Buffer.from('pinned');
    let pack;
    if (damage === 'changed') pack = packOf([object(3, Buffer.from('wrong!'))]);
    if (damage === 'missing') pack = packOf([]);
    if (damage === 'trailer') {
      pack = packOf([object(3, value)]);
      pack[pack.length - 1] ^= 1;
    }
    if (damage === 'delta-size')
      pack = packOf([object(3, value), object(7, Buffer.from([6, 127]), Buffer.from(sha(value), 'hex'))]);
    await assert.rejects(
      githubBlobPack(
        'fixture/source',
        damage === 'delta-size' ? [entry(value), entry(Buffer.from('other'))] : [entry(value)],
        undefined,
        async () => blobPackResponse(pack),
      ),
      /pack|pinned|delta|trailer/i,
    );
  });

test('large blob pages stream exact bytes and cancel on a changed member or failing sink', async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 7),
    e = entry(bytes);
  let consumed = 0;
  const pin = await streamGithubBlobPack(
    'fixture/source',
    e,
    async part => {
      consumed += part.length;
    },
    undefined,
    async () => blobPackResponse([bytes]),
  );
  assert.equal(consumed, bytes.length);
  assert.equal(pin.blob, createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(
    streamGithubBlobPack(
      'fixture/source',
      { ...e, sha: 'a'.repeat(40) },
      async () => {},
      undefined,
      async () => blobPackResponse([bytes]),
    ),
    /differs/,
  );
  await assert.rejects(
    streamGithubBlobPack(
      'fixture/source',
      e,
      async () => {
        throw Error('sink failed');
      },
      undefined,
      async () => blobPackResponse([bytes]),
    ),
    /sink failed|closed|aborted/i,
  );
});

test('Git source failures stay structured and never trigger per-blob REST retries', async () => {
  const e = entry(Buffer.from('source'));
  for (const status of [403, 500]) {
    let calls = 0;
    const request = async () => {
      calls++;
      return new Response('private provider details', { status });
    };
    await assert.rejects(
      githubBlobPack('fixture/source', [e], undefined, request),
      error =>
        error.code === (status === 403 ? 'GIT_FETCH_UNAUTHORIZED' : 'GIT_FETCH_FAILED') &&
        !error.message.includes('private provider'),
    );
    assert.equal(calls, 1);
  }
});
