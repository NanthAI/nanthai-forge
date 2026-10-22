// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { r2Client } from '../scripts/lib/hosted-backup-r2.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fakeEnv = {
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'fake',
  R2_ACCESS_KEY_ID: 'SYNTHETIC_ACCESS',
  R2_SECRET_ACCESS_KEY: 'SYNTHETIC_SECRET',
};
test('S3 adapter signs multipart POST/parts, handles pagination, and sends checksums', async () => {
  const requests = [];
  const client = r2Client(fakeEnv, async (url, init) => {
    const u = new URL(url);
    requests.push({ u, ...init });
    if (u.searchParams.has('uploads'))
      return new Response(
        init.method === 'GET'
          ? '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>'
          : '<UploadId>upload&amp;id</UploadId>',
      );
    if (u.searchParams.has('partNumber')) return new Response('', { headers: { etag: '"etag"' } });
    if (init.method === 'POST')
      return new Response('<CompleteMultipartUploadResult><ETag>ok</ETag></CompleteMultipartUploadResult>');
    if (u.searchParams.has('list-type'))
      return new Response(
        u.searchParams.has('continuation-token')
          ? '<IsTruncated>false</IsTruncated><Contents><Key>backup%2Fb</Key></Contents>'
          : '<IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;page</NextContinuationToken><Contents><Key>backup%2Fa</Key></Contents>',
      );
    return new Response('');
  });
  const uploadId = await client.create('backup/a', hash('data'));
  assert.equal(uploadId, 'upload&id');
  const part = await client.part('backup/a', uploadId, 1, Buffer.from('data'));
  await client.complete('backup/a', uploadId, [part]);
  await client.put('backup/manifest.json', Buffer.from('data'), hash('data'));
  assert.deepEqual(await client.list('backup/'), ['backup/a', 'backup/b']);
  assert.equal(requests[2].headers['content-md5'], createHash('md5').update('data').digest('base64'));
  assert.match(requests[3].body, /&quot;etag&quot;/);
  assert.equal(requests[4].headers['if-none-match'], '*');
  assert.equal(
    requests[4].headers['x-amz-checksum-sha256'],
    Buffer.from(hash('data'), 'hex').toString('base64'),
  );
});

test('S3 failures never return credentials, signed URLs or provider bodies', async () => {
  for (const fetcher of [
    async () => {
      throw new Error('SYNTHETIC_SECRET');
    },
    async () => new Response('SYNTHETIC_ACCESS', { status: 403 }),
  ]) {
    await assert.rejects(
      r2Client(fakeEnv, fetcher).head('backup/a'),
      error => error.code === 'BACKUP_R2_FAILED' && !String(error).includes('SYNTHETIC_'),
    );
  }
  const result = spawnSync(
    process.execPath,
    ['scripts/hosted-durability.mjs', 'backup', '--secret', 'SYNTHETIC_SECRET'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, ...fakeEnv } },
  );
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_'), false);
});

test('a lost initiation response discovers the original multipart upload before retrying', async () => {
  let uploadId,
    creates = 0;
  const client = r2Client(fakeEnv, async (url, init) => {
    const u = new URL(url);
    if (init.method === 'GET') {
      assert.equal(u.searchParams.get('prefix'), 'backup/exact/snapshot.zip');
      return new Response(
        '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>' +
          (uploadId
            ? `<Upload><Key>backup/exact/snapshot.zip</Key><UploadId>${uploadId}</UploadId></Upload>`
            : '') +
          '</ListMultipartUploadsResult>',
      );
    }
    creates++;
    uploadId = 'original-id';
    throw new Error('response lost');
  });
  await assert.rejects(client.create('backup/exact/snapshot.zip', hash('data')), {
    code: 'BACKUP_R2_FAILED',
  });
  assert.equal(await client.create('backup/exact/snapshot.zip', hash('data')), 'original-id');
  assert.equal(creates, 1);
});

test('multipart completion with a 200 Error body fails; readback hashes actual bytes and HEAD preserves absence', async () => {
  const client = r2Client(fakeEnv, async (_, init) => {
    if (init.method === 'POST')
      return new Response('<Error><Code>InvalidPart</Code><Message>SYNTHETIC_SECRET</Message></Error>');
    if (init.method === 'HEAD') return new Response(null, { status: 404 });
    return new Response('stored bytes');
  });
  await assert.rejects(client.complete('backup/a', 'id', ['etag']), { code: 'BACKUP_R2_FAILED' });
  assert.equal(await client.head('backup/missing'), null);
  assert.deepEqual(await client.digest('backup/a'), { size: 12, sha256: hash('stored bytes') });
});

test('backup HEAD and digest request unsigned identity; missing HEAD length is an error', async () => {
  let length = null;
  const client = r2Client(fakeEnv, async (url, init) => {
    assert.equal(init.headers['accept-encoding'], 'identity');
    assert(!new URL(url).searchParams.get('X-Amz-SignedHeaders').includes('accept-encoding'));
    if (init.method === 'HEAD')
      return new Response(null, {
        headers: length === null ? { 'content-encoding': 'gzip' } : { 'content-length': length },
      });
    return new Response('data');
  });
  await assert.rejects(client.head('key'), e => e.code === 'BACKUP_R2_FAILED');
  length = '4';
  assert.equal((await client.head('key')).size, 4);
  assert.deepEqual(await client.digest('key'), { size: 4, sha256: hash('data') });
});
