// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMirror, stepMirror } from '../dist/hosted-github-mirror.js';
import { githubRequest } from '../dist/hosted-github-api.js';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';

for (const [size, requestBytes] of [
  [341451, 455302],
  [274047, 365430],
  [322949, 430634],
]) {
  test(`mirror sends ${size} invalid-UTF-8 bytes as one exact ${requestBytes}-byte base64 JSON body`, async () => {
    const bytes = Buffer.from(Uint8Array.from({ length: size }, (_, i) => (i * 131 + 17) & 255));
    assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const f = mirrorFixture({ before: {}, after: { binary: { mode: 'file', text: bytes } } });
    let blobPosts = 0;
    const api = githubRequest('synthetic-token', async (url, init) => {
      if (url.endsWith('/blobs')) {
        blobPosts++;
        assert.equal(init.method, 'POST');
        assert.equal(Buffer.byteLength(init.body), requestBytes);
        assert.equal(init.headers['Content-Type'], 'application/json');
        assert.equal(init.headers['Content-Encoding'], undefined);
        assert.equal(init.headers['Content-Length'], undefined);
        const body = JSON.parse(init.body);
        assert.equal(body.encoding, 'base64');
        assert.deepEqual(Buffer.from(body.content, 'base64'), bytes);
        assert.deepEqual(Object.keys(body), ['content', 'encoding']);
      }
      return Response.json(
        await f.io.api(new URL(url).pathname, init.method, init.body && JSON.parse(init.body)),
      );
    });
    const io = { ...f.io, api };
    const plan = await stepMirror(await prepareMirror(f.seed, io), io);
    assert.equal(plan.phase, 'done');
    assert.equal(plan.entry.tree, f.expected());
    assert.equal(blobPosts, 1, 'one whole blob, with no per-chunk GitHub calls');
  });
}

test('API failure retains only validated GitHub request and numeric rate diagnostics', async () => {
  await assert.rejects(
    githubRequest(
      'private-token',
      async () =>
        new Response('private-body', {
          status: 500,
          headers: {
            'x-github-request-id': 'CE4F:36AEE:F6B3:16EB9:6AE442C3',
            'x-ratelimit-remaining': '42',
            'x-ratelimit-reset': '1793346778',
            'retry-after': '60',
            authorization: 'private-token',
          },
        }),
    )('/repos/private-repository/git/blobs', 'POST', { content: 'private-content' }),
    e => {
      assert.equal(e.code, 'GITHUB_SYNC_API');
      assert.match(e.message, /request ID CE4F:36AEE:F6B3:16EB9:6AE442C3/);
      assert.match(e.message, /rate limit remaining 42; rate limit reset 1793346778; retry after seconds 60/);
      assert(!/private-token|private-body|private-repository|private-content/.test(e.message));
      return true;
    },
  );
  await assert.rejects(
    githubRequest(
      'private-token',
      async () =>
        new Response('private-body', {
          status: 500,
          headers: {
            'x-github-request-id': 'private-token',
            'x-ratelimit-remaining': 'private-token',
            'x-ratelimit-reset': '1234567890123',
            'retry-after': 'private-token',
          },
        }),
    )('/repos/synthetic/mirror/git/blobs'),
    e => {
      assert(!/private|GitHub response/.test(e.message));
      return true;
    },
  );
});
