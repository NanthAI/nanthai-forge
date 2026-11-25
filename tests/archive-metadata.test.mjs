// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workArchiveMetadata } from '../dist/work-archive-metadata.js';
import { digest } from '../dist/hash.js';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { backupRow, projectRow, state } from './hosted-fixture.mjs';
const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
const backups = await import(moduleUrl('../convex/projectBackups.ts'));
const { projectArchiveMetadata } = await import(moduleUrl('../convex/projectArchiveMetadata.ts'));
const { derivedArtifact } = await import(moduleUrl('../convex/derivedArtifactActions.ts'));
const { encodeWorkMetadataSidecar } = await import(moduleUrl('../convex/workMetadataSidecar.ts'));
function header(name, size, type = 48) {
  const h = Buffer.alloc(512);
  h.write(name);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h[156] = type;
  h.fill(32, 148, 156);
  h.write(
    h
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  );
  return h;
}
const entry = (name, bytes) =>
  Buffer.concat([header(name, bytes.length), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
function archive(manifest = Buffer.from('{}'), work = Buffer.from('{}')) {
  return gzipSync(
    Buffer.concat([
      entry('manifest.json', manifest),
      entry('work.json', work),
      entry('objects/tail', randomBytes(2 * 1024 * 1024)),
      Buffer.alloc(1024),
    ]),
  );
}
function fragment(bytes, sizes) {
  let offset = 0,
    index = 0,
    canceled = false;
  return {
    stream: new ReadableStream(
      {
        pull(c) {
          const end = Math.min(offset + sizes[index++ % sizes.length], bytes.length);
          if (offset === end) {
            c.close();
            return;
          }
          c.enqueue(new Uint8Array(bytes.subarray(offset, end)));
          offset = end;
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    stats: () => ({ offset, canceled }),
  };
}
test('metadata is exact across nonlinear and single huge chunks; early cancellation leaves source/evidence unread', async () => {
  const manifest = Buffer.from('{"source":"exact"}'),
    work = randomBytes(100007),
    bytes = archive(manifest, work);
  for (const sizes of [[1, 7, 503, 8191, 65537], [bytes.length]]) {
    const input = fragment(bytes, sizes),
      output = await workArchiveMetadata(input.stream);
    assert.deepEqual(Buffer.from(output.manifest), manifest);
    assert.deepEqual(Buffer.from(output.work), work);
    assert.equal(input.stats().canceled, true);
    if (sizes.length > 1) assert.ok(input.stats().offset < bytes.length / 2);
  }
  class SlicedBlob extends Blob {
    stream() {
      throw Error('Whole Blob stream must not be read');
    }
  }
  const output = await workArchiveMetadata(new SlicedBlob([bytes]));
  assert.deepEqual(Buffer.from(output.work), work);
});
test('existing metadata bound, exact entry order/path/type/checksum and truncated gzip checks remain enforced', async () => {
  const badChecksum = header('manifest.json', 0);
  badChecksum[0] ^= 1;
  for (const bytes of [
    badChecksum,
    header('../manifest.json', 0),
    header('manifest.json', 0, 50),
    header('manifest.json', 4 * 1024 * 1024 + 1),
    Buffer.concat([entry('manifest.json', Buffer.from('{}')), entry('manifest.json', Buffer.from('{}'))]),
    Buffer.concat([entry('manifest.json', Buffer.from('{}')), header('work.json', 80), Buffer.from('{}')]),
    Buffer.concat([entry('manifest.json', Buffer.from('{}')), header('work.json', 4 * 1024 * 1024 + 1)]),
  ]) {
    await assert.rejects(workArchiveMetadata(new Blob([gzipSync(bytes)])));
  }
  const bytes = archive();
  await assert.rejects(workArchiveMetadata(new Blob([bytes.subarray(0, 10)])));
});
test('demand-driven decoding propagates source errors and cancels invalid metadata before reading source artifacts', async () => {
  const broken = new ReadableStream(
    {
      pull() {
        throw Error('source disconnected');
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(workArchiveMetadata(broken), /source disconnected/);
  const bytes = archive();
  bytes[0] = 0;
  const input = fragment(bytes, [3, 65536]);
  await assert.rejects(workArchiveMetadata(input.stream));
  assert.equal(input.stats().canceled, true);
  assert.ok(input.stats().offset < bytes.length / 2);
});
async function nativeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-streamed-metadata-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
  initNative(root);
  const w = new WorkService(root),
    exported = (await w.dispatch({ action: 'export-work', archive: true }, w.status().revision)).result,
    bytes = readFileSync(exported.archive.path);
  const md = await workArchiveMetadata(new Blob([bytes])),
    manifest = JSON.parse(Buffer.from(md.manifest)),
    data = JSON.parse(Buffer.from(md.work));
  const s = state([]);
  s.tables.projectContributors = new Map();
  s.tables.hostedProjects = new Map([
    [
      'project',
      projectRow({
        _id: 'project',
        owner: 'owner',
        key: randomUUID(),
        name: 'Streamed fixture',
        revision: 1,
        currentBackup: 'backup',
      }),
    ],
  ]);
  s.tables.projectBackups = new Map([
    [
      'backup',
      backupRow({
        _id: 'backup',
        projectId: 'project',
        digest: digest(bytes),
        size: bytes.length,
        storageId: 'storage',
        preview: { manifestDigest: digest(md.manifest) },
      }),
    ],
  ]);
  const previous = s.ctx.runQuery;
  s.ctx.runQuery = (ref, args) =>
    getFunctionName(ref) === 'projectBackups:get' ? backups.get._handler(s.ctx, args) : previous(ref, args);
  s.files.set('storage', { blob: new Blob([bytes]) });
  s.ctx.storage.get = () => {
    throw Error('Hosted metadata must not buffer the complete archive');
  };
  return { s, bytes, manifest, data };
}
