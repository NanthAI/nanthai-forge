// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Contract: both R2 fakes share storage cases with the real test bucket. Upload validation
// and signature checks exercise the HTTP fake and the real bucket. The real cases run when
// CONTRACT_R2_* settings are present (the nightly contract workflow). Production signing and
// request code runs on both sides: convex/r2.ts and convex/r2Operations.ts.
// Real cost per run: about 115 class A and 15 class B operations on a bucket that expires
// objects after one day (docs/operations/contract-suites.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { moduleUrl } from '../convex-module.mjs';
import { defaultR2Config, installDefaultR2Fetch } from '../default-r2.mjs';
import { startFakeR2, fakeR2Config } from '../fake-r2.mjs';
import { contractTargets } from './targets.mjs';

const { presignPut, presignGet, presignDelete, headObject, checksumOf } = await import(
  moduleUrl('../convex/r2.ts')
);
const { listR2Prefix, deleteR2Object } = await import(moduleUrl('../convex/r2Operations.ts'));
const { presign } = await import(moduleUrl('../convex/presign.ts'));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const object = text => {
  const bytes = Buffer.from(text);
  return { bytes, digest: sha256(bytes), size: bytes.length };
};
const put = async (config, key, value, signed = value) => {
  const target = await presignPut(config, key, { digest: signed.digest, size: signed.size });
  return fetch(target.url, { method: 'PUT', headers: target.headers, body: value.bytes });
};
const status = async response => {
  await response.body?.cancel();
  return response.status;
};

const targets = contractTargets(
  'r2',
  [
    'CONTRACT_R2_ACCOUNT_ID',
    'CONTRACT_R2_BUCKET',
    'CONTRACT_R2_ACCESS_KEY_ID',
    'CONTRACT_R2_SECRET_ACCESS_KEY',
  ],
  {
    async fake() {
      const fake = await startFakeR2(fakeR2Config, { local: true });
      return {
        config: { ...fakeR2Config, endpoint: { scheme: 'http', host: fake.host } },
        close: () => fake.close(),
      };
    },
    async real(env) {
      return {
        config: {
          accountId: env.CONTRACT_R2_ACCOUNT_ID,
          bucket: env.CONTRACT_R2_BUCKET,
          accessKeyId: env.CONTRACT_R2_ACCESS_KEY_ID,
          secretAccessKey: env.CONTRACT_R2_SECRET_ACCESS_KEY,
        },
      };
    },
  },
);
targets.push({
  name: 'default fake',
  open: () => ({ config: defaultR2Config, close: installDefaultR2Fetch() }),
  validatesRequests: false,
});

for (const target of targets) {
  test(`R2 contract (${target.name})`, { skip: target.skip }, async t => {
    const { config, close } = await target.open();
    // One prefix per run: nightly runs never see each other's keys, and the bucket's
    // one-day lifecycle rule removes anything a crashed run leaves behind.
    const prefix = `contract/${randomUUID()}/`,
      written = new Set();
    const key = name => {
      written.add(prefix + name);
      return prefix + name;
    };
    t.after(async () => {
      for (const name of written) await deleteR2Object(config, name).catch(() => {});
      await close?.();
    });

    await t.test(
      'create-only PUT stores the bytes once; a second PUT of the key is refused with 412',
      async () => {
        const value = object('contract object one'),
          name = key('create-only');
        assert.equal(await status(await put(config, name, value)), 200);
        assert.equal(await status(await put(config, name, value)), 412);
      },
    );

    if (target.validatesRequests !== false)
      await t.test(
        'a body that does not match the signed sha256 is refused with 400 and stores nothing',
        async () => {
          const value = object('contract bytes A'),
            other = object('contract bytes B'),
            name = key('bad-digest');
          assert.equal(await status(await put(config, name, value, other)), 400);
          assert.deepEqual(await headObject(config, name), { status: 'missing' });
        },
      );

    await t.test('HEAD reports the stored length and the sha256 checksum the PUT signed', async () => {
      const value = object('contract head bytes'),
        name = key('head');
      assert.equal(await status(await put(config, name, value)), 200);
      assert.deepEqual(await headObject(config, name), {
        status: 'ok',
        size: value.size,
        checksum: checksumOf(value.digest),
      });
      assert.deepEqual(await headObject(config, key('never-written')), { status: 'missing' });
    });

    await t.test('presigned GET returns the bytes; a Range header returns 206 with that slice', async () => {
      const value = object('0123456789'),
        name = key('get');
      assert.equal(await status(await put(config, name, value)), 200);
      const whole = await fetch(await presignGet(config, name));
      assert.equal(whole.status, 200);
      assert.equal(Buffer.from(await whole.arrayBuffer()).toString(), '0123456789');
      const slice = await fetch(await presignGet(config, name), { headers: { range: 'bytes=2-4' } });
      assert.equal(slice.status, 206);
      assert.equal(slice.headers.get('content-range'), 'bytes 2-4/10');
      assert.equal(Buffer.from(await slice.arrayBuffer()).toString(), '234');
      assert.equal(await status(await fetch(await presignGet(config, key('missing-get')))), 404);
    });

    if (target.validatesRequests !== false)
      await t.test(
        'an expired presigned URL and a tampered signature are both refused with 403',
        async () => {
          const value = object('contract signature bytes'),
            name = key('signature');
          assert.equal(await status(await put(config, name, value)), 200);
          const { endpoint = { scheme: 'https', host: `${config.accountId}.r2.cloudflarestorage.com` } } =
            config;
          const expired = await presign({
            method: 'GET',
            ...endpoint,
            path: `/${config.bucket}/${name}`,
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            expires: 60,
            now: new Date(Date.now() - 10 * 60_000),
          });
          assert.equal(await status(await fetch(expired)), 403);
          const url = new URL(await presignGet(config, name)),
            signature = url.searchParams.get('X-Amz-Signature');
          url.searchParams.set(
            'X-Amz-Signature',
            (signature.startsWith('0') ? '1' : '0') + signature.slice(1),
          );
          assert.equal(await status(await fetch(url)), 403);
        },
      );

    await t.test(
      'listing pages 100 keys at a time and its continuation cursor reaches every key once',
      async () => {
        const names = Array.from({ length: 101 }, (_, i) => key(`list/${String(i).padStart(3, '0')}`));
        for (let i = 0; i < names.length; i += 20)
          await Promise.all(
            names
              .slice(i, i + 20)
              .map(async (name, j) =>
                assert.equal(await status(await put(config, name, object(`n${i + j}`))), 200),
              ),
          );
        const first = await listR2Prefix(config, `${prefix}list/`, null);
        assert.equal(first.keys.length, 100);
        assert.equal(first.bytes, 290); // 10 two-byte objects, followed by 90 three-byte objects.
        assert.equal(first.isDone, false);
        assert.ok(first.cursor);
        const second = await listR2Prefix(config, `${prefix}list/`, first.cursor);
        assert.equal(second.isDone, true);
        assert.equal(second.bytes, 4);
        assert.deepEqual([...first.keys, ...second.keys].sort(), names.sort());
      },
    );

    await t.test('DELETE removes the object and deleting a missing key still succeeds', async () => {
      const value = object('contract delete bytes'),
        name = key('delete');
      assert.equal(await status(await put(config, name, value)), 200);
      assert.equal(await status(await fetch(await presignDelete(config, name), { method: 'DELETE' })), 204);
      assert.deepEqual(await headObject(config, name), { status: 'missing' });
      assert.equal(await status(await fetch(await presignDelete(config, name), { method: 'DELETE' })), 204);
    });
  });
}
