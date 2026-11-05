// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hashResponse,
  verifyFile,
  storageClass,
  metadataSource,
} from '../scripts/lib/legacy-storage-verify.mjs';
import { parseVerification, verify } from '../scripts/legacy-storage-verify.mjs';
const body = 'verified',
  sha256 = createHash('sha256').update(body).digest('hex');
const file = {
  storageId: 'file',
  bytes: 8,
  sha256,
  references: [],
  matchingCopies: [{ key: 'v1/p/p/o/' + sha256, size: 8 }],
};
const current = { _id: 'file', size: 8, sha256, url: 'private-url' };
const io = { hashConvex: async () => sha256, hashR2: async () => sha256 };
test('hashes every byte with bounded chunks, rejects missing/truncated/oversize streams', async () => {
  let chunks = 0;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('veri'));
        c.enqueue(new TextEncoder().encode('fied'));
        c.close();
      },
    }),
  );
  assert.equal(await hashResponse(response, 8, () => chunks++), sha256);
  assert.equal(chunks, 2);
  await assert.rejects(hashResponse(new Response(null, { status: 404 }), 8), /VERIFY_MISSING/);
  await assert.rejects(hashResponse(new Response('short'), 8), /VERIFY_SIZE_MISMATCH/);
  await assert.rejects(hashResponse(new Response('too-long'), 1), /VERIFY_SIZE_MISMATCH/);
});
test('checks current Convex bytes and every R2 alias; mismatches cannot qualify', async () => {
  let gets = 0;
  const shared = {
    ...file,
    references: ['projectObjects', 'projectBackups'].map((table, i) => ({
      table,
      field: 'storageId',
      location: 'r2',
      committed: true,
      key: `v1/p/p${i}/o/${sha256}`,
    })),
  };
  assert.equal(storageClass(shared), 1);
  const result = await verifyFile(shared, current, {
    ...io,
    hashR2: async () => {
      gets++;
      return sha256;
    },
  });
  assert.equal(gets, 3);
  assert.equal(result.fullDigest, true);
  assert.equal(JSON.stringify(result).includes('private-url'), false);
  await assert.rejects(
    verifyFile(file, current, { ...io, hashR2: async () => 'b'.repeat(64) }),
    /VERIFY_DIGEST_MISMATCH/,
  );
  await assert.rejects(verifyFile(file, { ...current, size: 9 }, io), /VERIFY_STORAGE_CHANGED/);
  await assert.rejects(verifyFile(file, null, io), /VERIFY_STORAGE_CHANGED/);
  assert.equal(storageClass({ ...file, matchingCopies: [] }), 4);
});
test('one Convex metadata RPC per 100 files, 32 streams maximum, resumable pinned evidence, class 4 untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-legacy-verify-'));
  try {
    const files = Array.from({ length: 201 }, (_, i) => ({ ...file, storageId: `f${i}` }));
    files.push({ ...file, storageId: 'keep', matchingCopies: [] });
    const audit = join(dir, 'audit.json'),
      out = join(dir, 'verify.json');
    await writeFile(
      audit,
      JSON.stringify({
        deployment: 'dev:test',
        coverage: { fullyPaged: true, r2: 'key-and-size-list' },
        files,
      }),
    );
    let calls = 0,
      active = 0,
      peak = 0;
    const reader = {
      page: async source => {
        calls++;
        const ids = JSON.parse(/Promise.all\((\[[^\]]*\])/.exec(source)[1]);
        return ids.map(id => ({ ...current, _id: id }));
      },
    };
    const testIo = {
      ...io,
      hashConvex: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setImmediate(r));
        active--;
        return sha256;
      },
    };
    const command = { audit, out, deployment: 'dev:test' };
    const state = await verify(command, reader, { io: testIo });
    assert.equal(calls, 3);
    assert.equal(peak, 32);
    assert.equal(state.results.length, 201);
    assert.equal(
      state.results.some(r => r.storageId === 'keep'),
      false,
    );
    assert.equal(JSON.stringify(state).includes('private-url'), false);
    await verify({ ...command, resume: true }, reader, { io: testIo });
    assert.equal(calls, 3);
    await assert.rejects(verify(command, reader, { io: testIo }), /VERIFY_USE_RESUME/);
    const report = JSON.parse(await readFile(audit));
    report.files.pop();
    await writeFile(audit, JSON.stringify(report));
    await assert.rejects(
      verify({ ...command, resume: true }, reader, { io: testIo }),
      /VERIFY_STATE_INVALID/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('metadata windows and dev scope reject invalid input, apply/prod unavailable', () => {
  assert.throws(() => metadataSource([]));
  assert.throws(() => metadataSource(Array(101).fill(file)));
  for (const args of [
    ['--deployment', 'prod:x'],
    ['--deployment', 'dev:x', '--apply'],
  ])
    assert.throws(() => parseVerification([...args, '--audit', '/tmp/a', '--out', '/tmp/b']));
});
test('current R2 HEAD requires size and checksum, with no downloaded body', async () => {
  const { verificationIo } = await import('../scripts/lib/legacy-storage-verify.mjs');
  const metrics = {};
  let good = true;
  const head = verificationIo(
    {
      R2_ACCOUNT_ID: 'synthetic',
      R2_BUCKET: 'bucket',
      R2_ACCESS_KEY_ID: 'synthetic',
      R2_SECRET_ACCESS_KEY: 'synthetic',
    },
    metrics,
    async (_, args) => {
      assert.equal(args.method, 'HEAD');
      assert.equal(new Headers(args.headers).get('accept-encoding'), 'identity');
      return new Response(null, {
        headers: {
          'content-length': '8',
          'x-amz-checksum-sha256': Buffer.from(good ? sha256 : 'b'.repeat(64), 'hex').toString('base64'),
        },
      });
    },
  );
  await head.headR2('v1/p/p/o/' + sha256, 8, sha256);
  good = false;
  await assert.rejects(head.headR2('v1/p/p/o/' + sha256, 8, sha256), /VERIFY_HEAD_CHECKSUM_MISMATCH/);
  assert.equal(metrics.r2Heads, 2);
});
test('dev-labelled inputs cannot reuse a production deployment credential', async () => {
  const { deploymentReader } = await import('../scripts/lib/legacy-storage-reader.mjs');
  assert.throws(
    () => deploymentReader('dev:fixture', '/synthetic', { CONVEX_DEPLOY_KEY: 'prod:fixture|synthetic' }),
    /AUDIT_DEV_DEPLOYMENT_REQUIRED/,
  );
});
test('a stalled readonly CLI child is terminated within its bound without disclosing provider output', async () => {
  const { deploymentReader } = await import('../scripts/lib/legacy-storage-reader.mjs');
  const root = await mkdtemp(join(tmpdir(), 'forge-reader-timeout-'));
  try {
    const bin = join(root, 'node_modules/convex/bin');
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, 'main.js'),
      'process.stdout.write("synthetic-private-output"); setInterval(() => {}, 1000);',
    );
    const reader = deploymentReader('dev:fixture', root, {}, 100);
    await assert.rejects(reader.page('return null;'), { message: 'AUDIT_READ_FAILED' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
