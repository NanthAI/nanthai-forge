// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const queries = await import(moduleUrl('../convex/projectBackups.ts'));
const actions = await import(moduleUrl('../convex/projectBackupActions.ts'));
const partSize = 2 * 1024 * 1024,
  blockSize = 251 * 256;
function bytes(offset, length) {
  return Uint8Array.from({ length }, (_, index) => (offset + index) % 251);
}
function sha(size) {
  const hash = createHash('sha256'),
    block = bytes(0, blockSize);
  for (let at = 0; at < size; at += blockSize) hash.update(block.subarray(0, Math.min(blockSize, size - at)));
  return hash.digest('hex');
}
function fixture(size = partSize + 17) {
  const s = state([]),
    digest = sha(size),
    native = s.ctx.runQuery;
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    currentBackup: 'backup',
    revision: 1,
    key: 'key',
    name: 'Synthetic',
  });
  s.tables.projectBackups.set('backup', {
    _id: 'backup',
    _creationTime: 1,
    projectId: 'project',
    operationId: 'original-operation',
    status: 'stored',
    storageId: 'object',
    size,
    digest,
    previous: null,
    preview: {},
  });
  const calls = { query: 0, metadata: 0, url: 0, fetch: 0, produced: 0, canceled: 0 };
  s.ctx.runQuery = async (ref, input) => {
    if (getFunctionName(ref) !== 'projectBackups:get') return native(ref, input);
    calls.query++;
    return queries.get._handler(s.ctx, input);
  };
  s.ctx.storage.get = async () => {
    throw Error('Eager full-Blob storage reads are forbidden by this regression fixture');
  };
  s.ctx.storage.getMetadata = async () => {
    calls.metadata++;
    return { size, sha256: Buffer.from(digest, 'hex').toString('base64') };
  };
  s.ctx.storage.getUrl = async () => {
    calls.url++;
    return 'https://storage.invalid/private-capability';
  };
  const args = { id: 'backup', offset: 0, digest };
  const invoke = change => actions.downloadPart._handler(s.ctx, { ...args, ...change });
  return { ...s, size, digest, calls, invoke };
}
const fetchRestorations = new WeakMap();
function transfer(
  t,
  s,
  { ranges = true, headers, status, stop, errorAt, extra = 0, throwFetch = false, onPull } = {},
) {
  if (!fetchRestorations.has(t)) {
    const previous = globalThis.fetch;
    fetchRestorations.set(t, previous);
    t.after(() => {
      globalThis.fetch = previous;
    });
  }
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://storage.invalid/private-capability');
    s.calls.fetch++;
    if (throwFetch) throw Error('transport failure https://storage.invalid/private-capability');
    const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    assert.ok(match);
    const begin = ranges ? Number(match[1]) : 0,
      end = ranges ? Number(match[2]) + 1 : s.size;
    let position = begin;
    const body = new ReadableStream({
      pull(controller) {
        onPull?.();
        if (errorAt !== undefined && position >= errorAt) {
          controller.error(Error('storage failure https://storage.invalid/private-capability'));
          return;
        }
        if (position >= Math.min(stop ?? end + extra, end + extra)) {
          controller.close();
          return;
        }
        const length = Math.min(blockSize, Math.min(stop ?? end + extra, end + extra) - position);
        controller.enqueue(bytes(position, length));
        position += length;
        s.calls.produced += length;
      },
      cancel() {
        s.calls.canceled++;
      },
    });
    s.calls.body = body;
    return new Response(body, {
      status: status ?? (ranges ? 206 : 200),
      headers: headers ?? {
        'content-length': String(end - begin),
        ...(ranges ? { 'content-range': `bytes ${begin}-${end - 1}/${s.size}` } : {}),
      },
    });
  };
}

test('149575298-byte storage object returns exact original 2MiB parts through bounded range streams, not eager Blobs', async t => {
  const s = fixture(149575298);
  transfer(t, s);
  for (const offset of [0, 60 * 1024 * 1024 + 3, s.size - 11]) {
    const result = await s.invoke({ offset });
    assert.deepEqual(
      Buffer.from(result.data),
      Buffer.from(bytes(offset, Math.min(partSize, s.size - offset))),
    );
    assert.equal(result.size, s.size);
    assert.equal(result.digest, s.digest);
    assert.equal(result.filename, 'forge-backup-original-operation.tar.gz');
    assert.doesNotMatch(JSON.stringify(result), /storage.invalid|private-capability/);
  }
  assert.equal(s.calls.query, 9);
  assert.equal(s.calls.fetch, 3);
  assert.equal(s.calls.produced, partSize * 2 + 11);
});

test('range-unsupported full responses stream the prefix and cancel unused suffix while preserving exact offsets and final bytes', async t => {
  const s = fixture(149575298);
  transfer(t, s, { ranges: false });
  const first = await s.invoke();
  assert.deepEqual(Buffer.from(first.data), Buffer.from(bytes(0, partSize)));
  assert.ok(s.calls.produced <= partSize + 2 * blockSize, 'Full storage body was not materialized');
  assert.equal(s.calls.canceled, 1);
  const small = fixture(partSize + 17);
  transfer(t, small, { ranges: false });
  assert.deepEqual(
    Buffer.from((await small.invoke({ offset: partSize })).data),
    Buffer.from(bytes(partSize, 17)),
  );
  assert.equal(small.calls.produced, small.size);
});

test('current authority is checked before any storage read, again before fetch, and after transfer; original backups survive newer current pointers', async t => {
  const s = fixture();
  transfer(t, s);
  s.caller('foreign');
  await assert.rejects(s.invoke(), e => e.data.code === 'PROJECT_UNAVAILABLE');
  assert.equal(s.calls.metadata, 0);
  assert.equal(s.calls.fetch, 0);
  s.caller('contributor');
  s.tables.projectContributors.set('grant', {
    _id: 'grant',
    projectId: 'project',
    contributor: 'contributor',
  });
  const getUrl = s.ctx.storage.getUrl;
  s.ctx.storage.getUrl = async () => {
    const url = await getUrl();
    s.tables.projectContributors.delete('grant');
    return url;
  };
  await assert.rejects(s.invoke(), e => e.data.code === 'PROJECT_UNAVAILABLE');
  assert.equal(s.calls.fetch, 0);
  s.ctx.storage.getUrl = getUrl;
  s.tables.projectContributors.set('grant', {
    _id: 'grant',
    projectId: 'project',
    contributor: 'contributor',
  });
  transfer(t, s, { onPull: () => s.tables.projectContributors.delete('grant') });
  await assert.rejects(s.invoke(), e => e.data.code === 'PROJECT_UNAVAILABLE');
  assert.equal(s.calls.fetch, 1);
  s.caller('owner');
  s.tables.hostedProjects.get('project').currentBackup = 'newer-backup';
  transfer(t, s);
  const original = await s.invoke();
  assert.equal(original.digest, s.digest);
  assert.equal(original.size, s.size);
  assert.equal(original.filename, 'forge-backup-original-operation.tar.gz');
});

test('wrong digest/size/offset and missing storage cannot yield a transfer or change original metadata', async t => {
  const s = fixture();
  transfer(t, s);
  const original = structuredClone(s.tables.projectBackups.get('backup'));
  for (const offset of [-1, 0.5, s.size, Infinity])
    await assert.rejects(s.invoke({ offset }), e => e.data.code === 'BAD_ARGUMENT');
  await assert.rejects(s.invoke({ digest: 'old' }), e => e.data.code === 'PROJECT_CHANGED');
  assert.equal(s.calls.metadata, 0);
  for (const metadata of [
    null,
    { size: s.size + 1, sha256: s.digest },
    { size: s.size, sha256: 'b'.repeat(64) },
  ]) {
    s.ctx.storage.getMetadata = async () => metadata;
    await assert.rejects(s.invoke(), e => e.data.code === 'INVALID_WORK_BACKUP');
  }
  s.ctx.storage.getMetadata = async () => ({ size: s.size, sha256: s.digest });
  s.ctx.storage.getUrl = async () => null;
  await assert.rejects(s.invoke(), e => e.data.code === 'INVALID_WORK_BACKUP');
  assert.equal(s.calls.fetch, 0);
  assert.deepEqual(s.tables.projectBackups.get('backup'), original);
});

test('malformed range/length, unavailable, truncated and failed streams return no bytes and cancel/release the transfer', async t => {
  const options = [
    { headers: { 'content-range': 'bytes 1-2097152/2097169' } },
    { headers: { 'content-range': 'bytes 0-2097151/99' } },
    { headers: { 'content-range': 'bytes 0-2097151/2097169', 'content-length': '1' } },
    { status: 404 },
    { stop: 73 },
    { errorAt: blockSize },
    { extra: 1 },
    { ranges: false, extra: 1 },
    { ranges: false, headers: { 'content-length': '1' } },
    { throwFetch: true },
  ];
  for (const option of options) {
    const s = fixture();
    transfer(t, s, option);
    const original = structuredClone(s.tables.projectBackups.get('backup'));
    await assert.rejects(s.invoke(), e => {
      assert.doesNotMatch(JSON.stringify(e.data), /storage.invalid|private-capability/);
      const networkFailure = option.throwFetch || option.errorAt !== undefined;
      assert.equal(e.data.code, networkFailure ? 'EXCHANGE_REQUEST_FAILED' : 'INVALID_WORK_BACKUP');
      if (networkFailure) assert.match(e.data.message, /Convex archive range download/);
      return true;
    });
    if (s.calls.body) assert.equal(s.calls.body.locked, false, 'Failed response releases its reader');
    assert.deepEqual(s.tables.projectBackups.get('backup'), original);
    assert.equal(s.calls.query, 2, 'No success/final authorization is reported for a failed transfer');
  }
});
