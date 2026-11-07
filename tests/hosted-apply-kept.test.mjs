// SPDX-License-Identifier: Apache-2.0
// Recover-apply keeps only the changed files, in the client cache, lists them, and expires them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { recoverLocalApply } from '../dist/hosted-apply-recovery.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import {
  KEPT_APPLY_TTL_MS,
  keptApplyEnvelope,
  keptApplyRoot,
  listKeptApply,
  removeCachePreservingKept,
  sweepKeptApply,
} from '../dist/hosted-apply-kept.js';

const COUNT = 300;
const extra = Array.from({ length: COUNT }, (_, i) => ({
  path: `src/dir${i % 10}/file${i}.txt`,
  content: `baseline ${i} `.repeat(40),
}));
const filesUnder = (directory, prefix = '') =>
  readdirSync(directory).flatMap(name => {
    const path = join(directory, name),
      relative = prefix ? `${prefix}/${name}` : name;
    return lstatSync(path).isDirectory() ? filesUnder(path, relative) : [relative];
  });
const bytesUnder = directory =>
  filesUnder(directory).reduce((sum, name) => sum + lstatSync(join(directory, name)).size, 0);

async function blocked(t, edit) {
  const s = await fixture(t, undefined, [{ path: '.gitignore', content: '*.log\nbuild/\n' }, ...extra]);
  mkdirSync(join(s.root, 'build'), { recursive: true });
  writeFileSync(join(s.root, 'build', 'output.js'), 'ignored build output');
  edit(s);
  const request = s.command();
  await assert.rejects(applyHostedSync(s.root, request, s.transport), { code: 'WORK_CONFLICT' });
  return { s, request };
}
const incoming = path => `incoming ${path}`;
/** The incoming change also touches `paths` (a new file where none was). */
const changeAlso = (s, paths) => {
  const touched = new Set(paths);
  s.setFiles([
    { ...s.files[0], blob: s.put('after\n') },
    ...s.files
      .slice(1)
      .map(file => (touched.has(file.path) ? { ...file, blob: s.put(incoming(file.path)) } : file)),
    ...paths
      .filter(path => !s.files.some(file => file.path === path))
      .map(path => ({ path, blob: s.put(incoming(path)), mode: 'file' })),
  ]);
};
const clashing = [
  'src/dir1/file1.txt',
  'src/dir2/file2.txt',
  'src/dir3/file3.txt',
  'notes.txt',
  'src/dir4/file4.txt.link',
  'src/dir5/file5.txt',
];
// Every local change meets the incoming change, so recovery keeps every one (e0ae9db0 F1 keeps
// only those; tests/hosted-userbytes-followups.test.mjs covers edits that stay in place).
const localEdits = s => {
  writeFileSync(join(s.root, 'a'), 'local draft of a');
  writeFileSync(join(s.root, 'src/dir1/file1.txt'), 'local draft one');
  writeFileSync(join(s.root, 'src/dir2/file2.txt'), 'local draft two');
  rmSync(join(s.root, 'src/dir3/file3.txt'));
  writeFileSync(join(s.root, 'notes.txt'), 'a brand new local file');
  symlinkSync('local-target', join(s.root, 'src/dir4/file4.txt.link'));
  chmodSync(join(s.root, 'src/dir5/file5.txt'), 0o755);
  changeAlso(s, clashing);
};

test('a kept apply holds only the changed files, in the client cache, never beside the root', async t => {
  const { s, request } = await blocked(t, localEdits);
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(recovered.status, 'applied');
  const cache = clientCacheRoot(s.root);
  assert.equal(recovered.preservedAt, join(keptApplyRoot(s.root), request.operationId, 'files'));
  assert(recovered.preservedAt.startsWith(`${cache}/kept-apply/`));
  assert.deepEqual(
    readdirSync(dirname(s.root)).filter(name => name.includes('kept-apply')),
    [],
    'nothing is created beside the project root',
  );
  // Exactly the paths the apply would have overwritten or removed, not the other ~300 files.
  const kept = filesUnder(recovered.preservedAt).sort();
  assert.deepEqual(kept, [
    'a',
    'notes.txt',
    'src/dir1/file1.txt',
    'src/dir2/file2.txt',
    'src/dir4/file4.txt.link',
    'src/dir5/file5.txt',
  ]);
  assert(bytesUnder(recovered.preservedAt) < 1024, 'bytes follow the changed paths, not the tree');
  assert.equal(readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'local draft of a');
  assert.equal(readFileSync(join(recovered.preservedAt, 'src/dir1/file1.txt'), 'utf8'), 'local draft one');
  assert.equal(readlinkSync(join(recovered.preservedAt, 'src/dir4/file4.txt.link')), 'local-target');
  // The deletion keeps no bytes (the baseline has them) but is listed in the receipt and in the result.
  assert.deepEqual(recovered.kept.paths.deleted, ['src/dir3/file3.txt']);
  assert.equal(recovered.kept.edited, 4);
  assert.equal(recovered.kept.extra, 2);
  assert.equal(recovered.kept.deleted, 1);
  // The live tree is the applied target; everything not changed, including ignored output, was left alone.
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
  assert.equal(readFileSync(join(s.root, 'src/dir1/file1.txt'), 'utf8'), incoming('src/dir1/file1.txt'));
  assert.equal(readFileSync(join(s.root, 'src/dir3/file3.txt'), 'utf8'), incoming('src/dir3/file3.txt'));
  assert.equal(readFileSync(join(s.root, 'notes.txt'), 'utf8'), incoming('notes.txt'));
  assert.equal(readFileSync(join(s.root, 'src/dir7/file7.txt'), 'utf8'), 'baseline 7 '.repeat(40));
  assert.equal(readFileSync(join(s.root, 'build/output.js'), 'utf8'), 'ignored build output');
});

test('a local change comes back from the new location', async t => {
  const { s, request } = await blocked(t, localEdits);
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  for (const path of filesUnder(recovered.preservedAt)) {
    const from = join(recovered.preservedAt, path),
      to = join(s.root, path);
    mkdirSync(dirname(to), { recursive: true });
    rmSync(to, { force: true });
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  }
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'local draft of a');
  assert.equal(readFileSync(join(s.root, 'src/dir1/file1.txt'), 'utf8'), 'local draft one');
  assert.equal(readFileSync(join(s.root, 'src/dir2/file2.txt'), 'utf8'), 'local draft two');
  assert.equal(readFileSync(join(s.root, 'notes.txt'), 'utf8'), 'a brand new local file');
  assert.equal(readlinkSync(join(s.root, 'src/dir4/file4.txt.link')), 'local-target');
});

test('a replay of a finished recovery keeps the same entry and adds no copies', async t => {
  const { s, request } = await blocked(t, localEdits);
  const first = await recoverLocalApply(s.root, request.operationId, s.transport);
  const before = filesUnder(dirname(first.preservedAt));
  const again = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(again.preservedAt, first.preservedAt);
  assert.deepEqual(filesUnder(dirname(first.preservedAt)), before);
  assert.equal(listKeptApply(s.root).entries.length, 1);
});

test('a directory standing where a saved file belongs is kept file by file and the baseline returns', async t => {
  const { s, request } = await blocked(t, s => {
    writeFileSync(join(s.root, 'a'), 'local draft of a'); // Meets the sync, so the apply refuses.
    rmSync(join(s.root, 'src/dir6/file6.txt'));
    mkdirSync(join(s.root, 'src/dir6/file6.txt'));
    writeFileSync(join(s.root, 'src/dir6/file6.txt/inner.txt'), 'inside a directory');
    changeAlso(s, ['src/dir6/file6.txt']); // The directory stands where the incoming file goes.
  });
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(
    readFileSync(join(recovered.preservedAt, 'src/dir6/file6.txt/inner.txt'), 'utf8'),
    'inside a directory',
  );
  assert.equal(readFileSync(join(s.root, 'src/dir6/file6.txt'), 'utf8'), incoming('src/dir6/file6.txt'));
});

test('a removed checkout comes back from the baseline with nothing else kept', async t => {
  const { s, request } = await blocked(t, localEdits);
  rmSync(s.root, { recursive: true, force: true });
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(recovered.status, 'applied');
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
  assert.equal(readFileSync(join(s.root, 'src/dir9/file9.txt'), 'utf8'), 'baseline 9 '.repeat(40));
});

test('status lists kept entries with their expiry, and only when something is kept', async t => {
  const { s, request } = await blocked(t, localEdits);
  assert.deepEqual(keptApplyEnvelope(s.root), {});
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  const { keptApply } = keptApplyEnvelope(s.root);
  assert.equal(keptApply.entries.length, 1);
  const [entry] = keptApply.entries;
  assert.equal(entry.id, request.operationId);
  assert.equal(entry.directory, dirname(recovered.preservedAt));
  assert.equal(entry.expiresAt, entry.confirmedAt + KEPT_APPLY_TTL_MS);
  assert.deepEqual(entry.paths.deleted, ['src/dir3/file3.txt']);
  assert(!JSON.stringify(keptApply).includes('local draft'), 'status carries paths, never file contents');
});

test('expiry removes a confirmed entry after the TTL and never an unconfirmed one', async t => {
  const { s, request } = await blocked(t, localEdits);
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  const directory = dirname(recovered.preservedAt);
  const { confirmedAt } = listKeptApply(s.root).entries[0];
  assert.deepEqual(sweepKeptApply(s.root, confirmedAt + KEPT_APPLY_TTL_MS - 1), []);
  assert(existsSync(join(directory, 'files', 'a')));
  // An entry whose apply was never confirmed has no clock: it is kept however old it is.
  const receiptPath = join(directory, 'receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  delete receipt.confirmedAt;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.deepEqual(sweepKeptApply(s.root, confirmedAt + 365 * 24 * 3600 * 1000), []);
  assert(existsSync(directory));
  receipt.confirmedAt = confirmedAt;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.deepEqual(sweepKeptApply(s.root, confirmedAt + KEPT_APPLY_TTL_MS), [request.operationId]);
  assert(!existsSync(directory));
  assert.deepEqual(keptApplyEnvelope(s.root), {});
});

test('removing a root cache leaves kept local changes in place', async t => {
  const { s, request } = await blocked(t, localEdits);
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  const cache = clientCacheRoot(s.root);
  assert(readdirSync(cache).length > 1);
  removeCachePreservingKept(cache);
  assert.deepEqual(readdirSync(cache), ['kept-apply']);
  assert.equal(readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'local draft of a');
});

test('an edit made after the copy starts another round instead of overwriting the first', async t => {
  const { s, request } = await blocked(t, localEdits);
  // Recovery reads authority once, then its apply twice; the second is the last read before
  // publication. The editor writes again right then, to a path the sync replaces.
  const select = s.transport.select;
  let reads = 0;
  s.transport.select = async laneId => {
    if (++reads === 3) writeFileSync(join(s.root, 'a'), 'second local draft');
    return select(laneId);
  };
  // The first call hits the second edit while the apply downloads and reports it as a new obstruction.
  await assert.rejects(recoverLocalApply(s.root, request.operationId, s.transport), {
    code: 'WORK_CONFLICT',
  });
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(readFileSync(join(recovered.preservedAt, 'src/dir1/file1.txt'), 'utf8'), 'local draft one');
  const [later] = recovered.additionalPreservedAt;
  assert.equal(readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'local draft of a');
  assert.equal(readFileSync(join(later, 'a'), 'utf8'), 'second local draft');
  assert(later.startsWith(`${dirname(recovered.preservedAt)}/files-`));
});
