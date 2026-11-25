// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { setup as r2Setup } from './r2-harness.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { getFunctionName } from 'convex/server';
import { fixture, git } from './helpers.mjs';
import { capture } from '../dist/snapshot.js';
import { analyze } from '../dist/analyze.js';
import { digest } from '../dist/hash.js';
import { encodeHostedArtifact } from '../dist/hosted-artifact.js';
import { hostedQuery } from '../dist/hosted-query.js';
import { state, job, providers } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const hosted = await import(moduleUrl('../convex/hosted.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycleActions.ts'));
const cache = await import(moduleUrl('../convex/derivedArtifacts.ts'));
const { derivedArtifact } = await import(moduleUrl('../convex/derivedArtifactActions.ts'));
const { projectArchiveMetadata } = await import(moduleUrl('../convex/projectArchiveMetadata.ts'));
const buckets = new WeakMap();
test.beforeEach(async t => {
  buckets.set(t, (await r2Setup(t)).fake);
});
const { blobStore } = await import(moduleUrl('../convex/blobStore.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
/** An original stored the only way it can be: an R2 artifact. */
const r2Ref = (s, blob, namespace) => blobStore(s.ctx).store(blob, { r2Namespace: namespace });
/** Reads of that original's R2 object, counted at the bucket. */
const originalReads = (t, s, ref) =>
  buckets
    .get(t)
    .requests.filter(
      r => r.method === 'GET' && r.path.includes(s.tables.artifactBlobs.get(ref.slice(7)).r2Key),
    ).length;
async function original(t) {
  const root = fixture(t, { 'a.ts': 'export const value = 1;\n', 'README.md': '# Original attribution\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Synthetic cost fixture']);
  const snapshot = capture(root),
    repository = {
      full_name: 'example/project',
      private: true,
      html_url: 'https://github.com/example/project',
      default_branch: 'main',
      license: null,
    };
  const artifact = {
    pack: analyze(snapshot),
    content: Object.fromEntries(snapshot.content),
    documents: {},
    repository,
  };
  const s = state([{ ...job(), head: snapshot.source.gitHead }]),
    blob = await encodeHostedArtifact(artifact),
    ref = await r2Ref(s, blob, 'v1/i/own/g/1');
  s.tables.imports.get('own').artifactKey = ref;
  let revoked = false;
  t.after(providers(() => revoked, true, snapshot.source.gitHead));
  const read = async endpoint => JSON.parse(await hosted.read._handler(s.ctx, { id: 'own', endpoint }));
  return {
    s,
    ref,
    artifact,
    read,
    revoke: () => {
      revoked = true;
    },
  };
}
test('warm status transfers zero artifact bytes, preserving complete status, parameters and current attribution/freshness', async t => {
  const { s, ref, artifact, read, revoke } = await original(t);
  const bodies = () => originalReads(t, s, ref);
  const first = await read('status');
  assert.deepEqual(
    Object.fromEntries(Object.entries(first).filter(([k]) => k !== 'sync')),
    hostedQuery(artifact, 'status', artifact.pack.source.gitHead),
  );
  assert.equal(bodies(), 1);
  const cold = bodies();
  for (let i = 0; i < 4; i++)
    assert.deepEqual(
      Object.fromEntries(Object.entries(await read('status')).filter(([k]) => k !== 'sync')),
      hostedQuery(artifact, 'status', artifact.pack.source.gitHead),
    );
  assert.equal(bodies(), cold);
  assert.ok(cold > 0);
  await assert.rejects(read('status?state=wrong'), code('STATE_MISMATCH'));
  await assert.rejects(read('status?limit=1.5'), code('BAD_ARGUMENT'));
  const prior = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.includes('/commits/')) return Response.json({ sha: 'b'.repeat(40) });
    if (url.hostname === 'api.github.com' && url.pathname === '/repos/example/project')
      return Response.json({
        ...artifact.repository,
        full_name: 'example/renamed',
        html_url: 'https://github.com/example/renamed',
        license: { spdx_id: 'MIT' },
      });
    return prior(input, init);
  };
  t.after(() => {
    globalThis.fetch = prior;
  });
  const changed = await read('status');
  assert.equal(changed.freshness, 'stale');
  assert.equal(changed.name, 'example/renamed');
  assert.equal(changed.hosted.license, 'Not specified');
  assert.equal(changed.hosted.currentLicense, 'MIT');
  assert.equal(bodies(), cold);
  globalThis.fetch = prior;
  revoke();
  await assert.rejects(read('status'), code('GITHUB_UNAVAILABLE'));
  assert.equal(bodies(), cold);
});
test('missing/corrupt summaries rebuild from the same original bytes; refreshing retains previous status until new artifact publication', async t => {
  const { s, artifact, read } = await original(t);
  await read('status');
  s.tables.imports.get('own').phase = 'indexing';
  s.tables.imports.get('own').generation++;
  const row = [...s.tables.derivedArtifacts.values()].find(row => row.kind === 'hosted-status-v1');
  row.inline = '{corrupt';
  assert.equal((await read('status')).sourceId, artifact.pack.source.id);
  assert.equal(JSON.parse(s.tables.derivedArtifacts.get(row._id).inline).sourceId, artifact.pack.source.id);
  s.tables.derivedArtifacts.clear();
  assert.equal((await read('status')).analysisId, artifact.pack.id);
  s.caller('other');
  const before = s.reads();
  await assert.rejects(read('status'), code('GITHUB_UNAVAILABLE'));
  assert.equal(s.reads(), before);
});
function entry(name, bytes) {
  const h = Buffer.alloc(512);
  h.write(name);
  h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  h[156] = 48;
  h.fill(32, 148, 156);
  h.write(
    h
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  );
  return Buffer.concat([h, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
test('warm Work metadata reads only a sidecar, preserving original bytes, unknown fields and existing 4MiB members', async t => {
  const manifest = Buffer.from('  {"unknown":{"order":2,"future":true}}\n'),
    work = Buffer.concat([
      Buffer.from('{"future":"'),
      Buffer.alloc(4 * 1024 * 1024 - 15, 97),
      Buffer.from('"}\n'),
    ]);
  const bytes = gzipSync(
    Buffer.concat([
      entry('manifest.json', manifest),
      entry('work.json', work),
      entry('objects/tail', randomBytes(1024 * 1024)),
      Buffer.alloc(1024),
    ]),
  );
  const s = state([]),
    sha = digest(bytes),
    archive = await r2Ref(s, new Blob([bytes]), 'v1/p/synthetic/archives/a');
  let access = 0;
  const originals = () => originalReads(t, s, archive);
  const read = () =>
    projectArchiveMetadata(s.ctx, archive, bytes.length, sha, async () => {
      access++;
    });
  for (let i = 0; i < 2; i++) {
    const value = await read();
    assert.deepEqual(Buffer.from(value.manifest), manifest);
    assert.deepEqual(Buffer.from(value.work), work);
  }
  assert.equal(originals(), 1);
  // The second read is the one sidecar read; the original is not read again.
  assert.equal(buckets.get(t).requests.filter(r => r.method === 'GET').length, 2);
  assert.ok(access >= 4);
  const row = [...s.tables.derivedArtifacts.values()][0];
  assert.equal(row.kind, 'work-metadata-v3');
  assert.ok(
    row.storageId && row.inline === undefined,
    'Full metadata bytes retained outside database documents',
  );
  assert.ok(row.size < work.length, 'Sidecar compressed without changing metadata bytes');
  // A sidecar whose stored bytes disappeared is rebuilt into R2.
  row.storageId = 'missing-legacy';
  const rebuilt = await read();
  assert.deepEqual(Buffer.from(rebuilt.work), work);
  assert.equal(originals(), 2);
});
test('durable derived upload reservation reconciles lost store/attach replies and concurrent builders', async t => {
  const s = state([]),
    original = await r2Ref(s, new Blob(['original']), 'v1/i/own/g/1');
  let builds = 0;
  const build = async () => {
    builds++;
    return new Blob(['exact derived bytes'], { type: 'application/gzip' });
  };
  const runAction = s.ctx.runAction;
  let lost = true;
  s.ctx.runAction = async (ref, args) => {
    assert.equal(
      [...s.tables.derivedArtifacts.values()].filter(
        row =>
          `r2blob:${[...s.tables.artifactBlobs.values()].find(blob => blob.namespace === `v1/d/${row._id}`)?._id}` ===
          args.ref,
      ).length,
      1,
      'Reservation precedes storage',
    );
    const result = await runAction(ref, args);
    if (lost) {
      lost = false;
      throw Error('lost committed storage reply');
    }
    return result;
  };
  await assert.rejects(
    derivedArtifact(s.ctx, original, 'zone-export-v1', 'pin', build, async () => {}),
    /lost committed storage reply/,
  );
  const a = await derivedArtifact(s.ctx, original, 'zone-export-v1', 'pin', build, async () => {});
  assert.ok(a.storageId);
  assert.equal(a.contentType, 'application/gzip');
  const b = await derivedArtifact(s.ctx, original, 'zone-export-v1', 'pin', build, async () => {});
  assert.equal(a.storageId, b.storageId);
  assert.equal(builds, 2);
  const mutation = s.ctx.runMutation;
  let lostAttach = true,
    transactions = Promise.resolve();
  s.ctx.runMutation = (ref, args) => {
    const result = transactions.then(async t => {
      const value = await mutation(ref, args);
      if (getFunctionName(ref) === 'derivedArtifacts:attach' && lostAttach) {
        lostAttach = false;
        throw Error('lost committed attach reply');
      }
      return value;
    });
    transactions = result.catch(() => {});
    return result;
  };
  const [c, d] = await Promise.all([
    derivedArtifact(s.ctx, original, 'zone-export-v1', 'other', build, async () => {}),
    derivedArtifact(s.ctx, original, 'zone-export-v1', 'other', build, async () => {}),
  ]);
  assert.equal(c.storageId, d.storageId);
  assert.equal(buckets.get(t).objects.size, 3, 'Concurrent losers cleaned safely');
});
test('a stale missing-cache rebuild cannot delete the concurrently repaired winner during export', async t => {
  const s = state([]),
    original = await r2Ref(s, new Blob(['original']), 'v1/i/own/g/1');
  const build = async () => new Blob(['pinned export bytes'], { type: 'application/gzip' });
  const first = await derivedArtifact(s.ctx, original, 'zone-export-v1', 'pin', build, async () => {});
  s.tables.derivedArtifacts.get(first._id).storageId = 'missing-legacy';
  let started, release;
  const entered = new Promise(resolve => {
      started = resolve;
    }),
    gate = new Promise(resolve => {
      release = resolve;
    });
  const slow = derivedArtifact(
    s.ctx,
    original,
    'zone-export-v1',
    'pin',
    async t => {
      started();
      await gate;
      return build();
    },
    async () => {},
  );
  await entered;
  const winner = await derivedArtifact(s.ctx, original, 'zone-export-v1', 'pin', build, async () => {});
  assert.match(winner.storageId, /^r2blob:/);
  release();
  const late = await slow;
  assert.equal(late.storageId, winner.storageId);
  assert.ok(
    await blobStore(s.ctx).getMetadata(winner.storageId),
    'Valid concurrent export survives stale cache repair',
  );
  assert.equal(await (await blobStore(s.ctx).get(winner.storageId)).text(), 'pinned export bytes');
});

test('verified Work sidecars retain independently stored v1 derivatives and rebuild corrupt files from original bytes', async t => {
  const manifest = Buffer.from(' {"future":"original"}\n'),
    work = Buffer.from('{"future":true,"a":1}\n');
  const bytes = gzipSync(
      Buffer.concat([entry('manifest.json', manifest), entry('work.json', work), Buffer.alloc(1024)]),
    ),
    s = state([]),
    sha = digest(bytes),
    archive = await r2Ref(s, new Blob([bytes]), 'v1/p/synthetic/archives/a');
  const old = await derivedArtifact(
    s.ctx,
    archive,
    'work-metadata-v1',
    '',
    async () =>
      new Blob(
        [gzipSync(JSON.stringify({ manifest: manifest.toString('base64'), work: work.toString('base64') }))],
        { type: 'application/gzip' },
      ),
    async () => {},
  );
  const read = () => projectArchiveMetadata(s.ctx, archive, bytes.length, sha, async () => {});
  const first = await read();
  assert.deepEqual(Buffer.from(first.work), work);
  const row = [...s.tables.derivedArtifacts.values()].find(x => x.kind === 'work-metadata-v3');
  assert.ok(row.storageId);
  // A stored sidecar whose bytes no longer match its pins is replaced from the original.
  const corrupt = await r2Ref(s, new Blob(['corrupt sidecar']), 'v1/d/damaged');
  row.storageId = corrupt;
  const repaired = await read();
  assert.deepEqual(Buffer.from(repaired.manifest), manifest);
  assert.deepEqual(Buffer.from(repaired.work), work);
  assert.ok(await blobStore(s.ctx).getMetadata(old.storageId));
  assert.equal(s.tables.derivedArtifacts.get(old._id).storageId, old.storageId);
});

test('repeated endpoint navigation reuses derivatives and still rejects revoked GitHub access', async t => {
  const { s, ref, read, revoke } = await original(t);
  const first = await read('files?limit=50');
  assert.equal(originalReads(t, s, ref), 1);
  for (let i = 0; i < 5; i++) assert.deepEqual(await read('files?limit=50'), first);
  assert.equal(originalReads(t, s, ref), 1);
  await assert.rejects(read('files?state=wrong'), code('STATE_MISMATCH'));
  revoke();
  await assert.rejects(read('files?limit=50'), code('GITHUB_UNAVAILABLE'));
});
