// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { startFakeR2, fakeR2Config } from './fake-r2.mjs';
import { streamGithubSourceBlob } from '../dist/github-project-source.js';
import { importPageBytes } from '../dist/github-import-pages.js';
const { ImportUpload } = await import(moduleUrl('../convex/projectGithubImportUpload.ts'));
const { stageFallbackBlobs } = await import(moduleUrl('../convex/projectGithubImportArchive.ts'));

const gitSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, count, size) {
  const keys = {
    R2_ACCOUNT_ID: fakeR2Config.accountId,
    R2_BUCKET: fakeR2Config.bucket,
    R2_ACCESS_KEY_ID: fakeR2Config.accessKeyId,
    R2_SECRET_ACCESS_KEY: fakeR2Config.secretAccessKey,
  };
  const saved = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  Object.assign(process.env, keys);
  const bucket = await startFakeR2();
  const restore = bucket.install();
  t.after(async () => {
    restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await bucket.close();
  });
  const s = state([]);
  const projectId = await s.ctx.db.insert('hostedProjects', {
    owner: 'owner',
    key: randomUUID(),
    name: 'fallback fixture',
    revision: 0,
    currentBackup: null,
    visibility: 'private',
  });
  const stored = new Map(),
    receipts = [],
    upload = new ImportUpload(s.ctx, projectId, 'owner', 8, {
      stored,
      record: async objects => receipts.push(objects),
    });
  // Distinct omitted/rewritten members, as the archive path would leave them.
  const bodies = new Map(),
    entries = [];
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.alloc(size, i % 251);
    bytes.writeUInt32BE(i, 0);
    const sha = gitSha(bytes);
    bodies.set(sha, bytes);
    entries.push({ path: `omitted/${i}.bin`, sha, size, mode: '100644' });
  }
  let stagedPeak = 0,
    drains = 0;
  const io = {
    upload: {
      put: bytes => {
        const pin = upload.put(bytes);
        stagedPeak = Math.max(stagedPeak, upload.stagedBytes);
        return pin;
      },
      get stagedBytes() {
        return upload.stagedBytes;
      },
    },
    fetchBlob: (entry, consume, tamper) =>
      streamGithubSourceBlob(
        'fixture/repo',
        entry,
        consume,
        undefined,
        async () => new Response(tamper ?? bodies.get(entry.sha)),
      ),
    drain: async () => {
      if (await upload.drain()) {
        drains++;
        receipts.push(upload.catalogReceipt());
      }
    },
    over: () => false,
  };
  return {
    upload,
    stored,
    receipts,
    entries,
    bodies,
    io,
    peak: () => stagedPeak,
    drains: () => drains,
  };
}

test('fallback staging is bounded by bytes: one 8 MiB window, every file kept, no extra PUTs per window', async t => {
  const size = 300_000,
    f = await fixture(t, 60, size);
  const recorded = new Map();
  await stageFallbackBlobs(f.entries, {
    ...f.io,
    record: (entry, pin) => recorded.set(entry.path, pin),
  });
  await f.io.drain();
  await f.upload.drain(true);
  f.receipts.push(f.upload.catalogReceipt());
  // Every supported file is retained and bound to its own content.
  assert.equal(recorded.size, 60);
  for (const entry of f.entries) {
    const bytes = f.bodies.get(entry.sha);
    assert.deepEqual(recorded.get(entry.path), { blob: sha256(bytes), size });
    assert.ok(f.stored.has(sha256(bytes)), entry.path);
  }
  // Staging never exceeds the normal source threshold plus one blob
  // (the unbounded page staged all 60 blobs: 18,000,000 bytes).
  assert.ok(f.peak() <= importPageBytes + size, `staged ${f.peak()}`);
  assert.ok(f.peak() < (60 * size) / 2, 'staging is a window, not the page');
  // PUTs are one pack per 8 MiB window, the normal archive pack size.
  const total = 60 * size;
  assert.ok(f.upload.putAttempts <= Math.ceil(total / importPageBytes) + 1, String(f.upload.putAttempts));
  assert.equal(f.upload.putAttempts, 3, '18 MB of members pack into three PUTs');
  assert.ok(f.upload.peakBufferedBytes <= 2 * (importPageBytes + size), 'window plus its pack copy');
  assert.equal(f.drains() + 1, f.receipts.length, 'one bounded receipt per window');
});

test("small fallback pages keep today's single window and single PUT", async t => {
  const f = await fixture(t, 100, 1000);
  await stageFallbackBlobs(f.entries, { ...f.io, record: () => {} });
  await f.upload.drain(true);
  assert.equal(f.upload.putAttempts, 1);
  assert.equal(f.stored.size, 101, 'one pack row plus 100 members');
});

test('a changed fallback blob is rejected before it can be staged', async t => {
  const f = await fixture(t, 3, 1000);
  const bad = Buffer.alloc(1000, 7);
  await assert.rejects(
    stageFallbackBlobs(f.entries, {
      ...f.io,
      fetchBlob: entry => f.io.fetchBlob(entry, async () => {}, bad),
      record: () => assert.fail('nothing recorded'),
    }),
    /differs|ARTIFACT_INTEGRITY|exceeds|pinned/i,
  );
  assert.equal(f.upload.stagedBytes, 0);
});
