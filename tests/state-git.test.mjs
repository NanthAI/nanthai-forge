// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digest } from '../dist/hash.js';
import { gitHash, gitTree } from '../dist/hosted-github-git.js';
import { NativeSource, nativeMarker } from '../dist/native-source.js';
import { emptyStateGitCache, gitObjectId, gitToState, stateCommit, stateToGit } from '../dist/state-git.js';

function owner(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-state-git-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const path = join(root, 'owner');
  mkdirSync(path);
  nativeMarker(path);
  return { root, source: new NativeSource(path) };
}
const pointer = 'a'.repeat(40);
function writeState(source, files, parents = [], extra = {}) {
  const entries = Object.entries(files).map(([path, value]) => {
    const { text, mode } = typeof value === 'string' ? { text: value, mode: 'file' } : value;
    return { path, blob: source.put(Buffer.from(text)), mode };
  });
  return source.writeState(
    entries,
    parents,
    extra.message ?? 'save',
    extra.at ?? '2026-10-30T12:00:00.000Z',
    extra.git,
    extra.conversation,
  );
}
const sample = {
  'README.md': 'hello\n',
  'a.b': 'dot',
  'a-b': 'dash',
  a0: 'zero',
  'a/b': 'nested',
  'a/c/d.ts': 'export {};\n',
  'bin/run': { text: '#!/bin/sh\n', mode: 'executable' },
  link: { text: 'a/b', mode: 'symlink' },
  'vendor/lib': { text: `${pointer}\n`, mode: 'gitlink' },
  'é/ü.txt': 'unicode',
  empty: '',
};
function convert(source, id, cache = emptyStateGitCache()) {
  const store = new Map();
  const result = stateToGit(source.object(id), blob => source.object(blob), cache);
  assert.equal(result.exact, true);
  for (const [oid, object] of result.objects) store.set(oid, object);
  return { ...result, store, cache };
}

test('a State converts to Git objects and back to its exact bytes and identity', t => {
  const { source } = owner(t);
  const id = writeState(source, sample, [], {
    conversation: { agent: 'codex', sessionId: 's', turnId: 't' },
    git: { bundle: 'b'.repeat(64), commit: 'c'.repeat(40), format: 'sha1' },
  });
  const { record, store, cache } = convert(source, id);
  assert.equal(record.state, id);
  assert.equal(record.gitlinks['vendor/lib'], digest(`${pointer}\n`));
  // The mirror's existing tree hash agrees, so GitHub commits keep their trees.
  const files = source.state(id).files.map(file => ({
    path: file.path,
    mode: file.mode,
    sha: file.mode === 'gitlink' ? pointer : gitHash('blob', source.object(file.blob)),
  }));
  assert.equal(record.tree, gitTree(files));
  const bytes = gitToState(
    record,
    oid => store.get(oid).bytes,
    oid => cache.aliases.get(oid),
  );
  assert.deepEqual(bytes, source.object(id));
  // A fresh process needs only the record, trees and the alias table.
  const record2 = JSON.parse(JSON.stringify(record));
  assert.equal(
    digest(
      gitToState(
        record2,
        oid => store.get(oid).bytes,
        oid => cache.aliases.get(oid),
      ),
    ),
    id,
  );
});

test('real Git accepts the objects, lists the same files and reads the export commit', t => {
  const { root, source } = owner(t);
  const parent = writeState(source, { 'README.md': 'v1\n' }, [], {
    message: 'first',
    at: '2026-10-29T00:00:01.900Z',
  });
  const child = writeState(source, sample, [parent], { message: 'second\n\n' });
  const cache = emptyStateGitCache(),
    first = convert(source, parent, cache),
    second = convert(source, child, cache);
  const repo = join(root, 'repo.git');
  execFileSync('git', ['init', '--bare', '-q', repo]);
  const git = (args, input) =>
    execFileSync('git', ['-C', repo, ...args], {
      input,
      encoding: input === undefined ? 'utf8' : undefined,
    }).toString();
  const base = stateCommit(first.record, []),
    head = stateCommit(second.record, [base.oid]);
  for (const [oid, object] of [
    ...first.store,
    ...second.store,
    [base.oid, base.object],
    [head.oid, head.object],
  ])
    assert.equal(git(['hash-object', '-t', object.type, '-w', '--stdin'], object.bytes).trim(), oid);
  git(['update-ref', 'refs/heads/main', head.oid]);
  git(['fsck', '--strict', '--no-dangling']);
  const listed = git(['ls-tree', '-r', '-z', head.oid])
    .split('\0')
    .filter(Boolean)
    .map(line => line.split('\t')[1])
    .sort();
  assert.deepEqual(listed, Object.keys(sample).sort());
  assert.equal(git(['cat-file', '-p', `${head.oid}:link`]), 'a/b');
  assert.match(
    git(['cat-file', '-p', `${head.oid}:vendor`]),
    new RegExp(`^160000 commit ${pointer}\tlib$`, 'm'),
  );
  const message = git(['log', '-1', '--format=%P%n%at%n%B', head.oid]);
  assert.equal(message, `${base.oid}\n1793361600\nsecond\n\nForge-State: ${child}\n\n`);
  assert.equal(git(['log', '-1', '--format=%at', base.oid]).trim(), '1793232001');
  // Derivation is deterministic: the same record always yields the same commit.
  assert.equal(stateCommit(second.record, [base.oid]).oid, head.oid);
  assert.throws(() => stateCommit(second.record, []), { code: 'SOURCE_UNAVAILABLE' });
  // The child stored only what changed: README's new blob and the root tree are new,
  // and nothing the parent already emitted is emitted again.
  for (const oid of second.store.keys()) assert.equal(first.store.has(oid), false);
});

test('a non-canonical manifest is reported and kept, never rewritten', t => {
  const { source } = owner(t);
  const id = writeState(source, { x: 'x' });
  const value = JSON.parse(source.object(id).toString());
  const reordered = Buffer.from(JSON.stringify({ kind: value.kind, ...value })),
    pretty = Buffer.from(JSON.stringify(value, null, 2)),
    unsorted = Buffer.from(
      JSON.stringify({ ...value, files: [...value.files, { ...value.files[0], path: 'a' }] }),
    );
  // Reordered keys round-trip: the record keeps the original key order.
  assert.equal(stateToGit(reordered, b => source.object(b), emptyStateGitCache()).exact, true);
  for (const bytes of [pretty, unsorted])
    assert.deepEqual(
      stateToGit(bytes, b => source.object(b), emptyStateGitCache()),
      {
        exact: false,
        state: digest(bytes),
        reason: 'NON_CANONICAL_MANIFEST',
      },
    );
});

test('tampered trees, aliases or bytes fail closed', t => {
  const { source } = owner(t);
  const id = writeState(source, { 'a/b': 'b', c: 'c' });
  const { record, store, cache } = convert(source, id);
  const tree = oid => store.get(oid).bytes,
    alias = oid => cache.aliases.get(oid);
  const swapped = new Map(
    [...cache.aliases].map(([oid], index, all) => [oid, all[(index + 1) % all.length][1]]),
  );
  assert.throws(() => gitToState(record, tree, oid => swapped.get(oid)), { code: 'SOURCE_DIGEST_MISMATCH' });
  const bad = Buffer.from(store.get(record.tree).bytes);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => gitToState(record, () => bad, alias), { code: 'GIT_OBJECT_INVALID' });
  assert.throws(() => gitToState(record, tree, () => undefined), { code: 'SOURCE_UNAVAILABLE' });
  assert.throws(
    () => gitToState({ ...record, fields: { ...record.fields, message: 'other' } }, tree, alias),
    {
      code: 'SOURCE_DIGEST_MISMATCH',
    },
  );
  const blob = source.state(id).files[0].blob;
  assert.throws(
    () =>
      stateToGit(
        source.object(id),
        b => (b === blob ? Buffer.from('changed') : source.object(b)),
        emptyStateGitCache(),
      ),
    {
      code: 'SOURCE_DIGEST_MISMATCH',
    },
  );
  const forged = emptyStateGitCache();
  forged.aliases.set(gitObjectId('blob', Buffer.from('b')), 'f'.repeat(64));
  assert.throws(() => stateToGit(source.object(id), b => source.object(b), forged), {
    code: 'GIT_OBJECT_COLLISION',
  });
});

test('dogfood-scale history: each blob is read once and a save stores a few KB, not a manifest', t => {
  // ~2,750 files in ~180 directories (current main), 300 saves changing 5 files each.
  const { source } = owner(t);
  const paths = Array.from({ length: 2750 }, (_, i) => `src/m${i % 12}/d${i % 180}/file-${i}.ts`);
  const blobs = new Map(),
    put = text => {
      const blob = digest(text);
      if (!blobs.has(blob)) blobs.set(blob, Buffer.from(text));
      return blob;
    };
  let files = paths.sort().map(path => ({ path, blob: put(`export const v = '${path}';\n`), mode: 'file' }));
  const manifests = [];
  for (let save = 0; save < 300; save++) {
    if (save)
      files = files.map((file, i) =>
        (i * 7 + save * 13) % 550 === 0 ? { ...file, blob: put(`${file.path} ${save}`) } : file,
      );
    manifests.push(
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files,
          message: `s${save}`,
          at: '2026-10-30T00:00:00.000Z',
        }),
      ),
    );
  }
  const cache = emptyStateGitCache();
  let reads = 0,
    stored = 0,
    manifestBytes = 0,
    newObjects = 0,
    maxSaveBytes = 0;
  const began = performance.now();
  for (const [index, manifest] of manifests.entries()) {
    const result = stateToGit(manifest, blob => (reads++, blobs.get(blob)), cache);
    assert.equal(result.exact, true);
    let bytes = 0;
    for (const [oid, object] of result.objects) {
      cache.stored.add(oid);
      bytes += object.bytes.length;
    }
    if (index) {
      maxSaveBytes = Math.max(maxSaveBytes, bytes);
      stored += bytes;
      manifestBytes += manifest.length;
      newObjects += result.objects.size;
    }
  }
  const elapsed = performance.now() - began;
  assert.equal(reads, blobs.size);
  t.diagnostic(
    `saves=299 manifest=${(manifestBytes / 299 / 1024).toFixed(0)}KB/save git=${(stored / 299 / 1024).toFixed(1)}KB/save ` +
      `max=${(maxSaveBytes / 1024).toFixed(1)}KB objects=${(newObjects / 299).toFixed(1)}/save ms=${elapsed.toFixed(0)}`,
  );
  // Five changed blobs touch at most five leaf, five module, one src and one root tree.
  assert.ok(newObjects / 299 <= 17, `objects/save ${newObjects / 299}`);
  assert.ok(stored * 20 < manifestBytes, `stored ${stored} vs manifests ${manifestBytes}`);
  assert.ok(elapsed < 60_000, `elapsed ${elapsed}`);
});
