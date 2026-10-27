// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { readNativeSourceReview, reviewTextPage } from '../dist/native-source-review.js';

function fixture() {
  const objects = new Map(),
    put = value => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value),
        id = digest(bytes);
      objects.set(id, bytes);
      return id;
    };
  const state = files =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: files.map(([path, value, mode = 'file']) => ({ path, blob: put(value), mode })),
        message: 'Synthetic review',
        at: '2026-01-01T00:00:00Z',
      }),
    );
  const base = state([
    ['changed.ts', 'const value = 1;\n'],
    ['old.ts', 'renamed bytes\n'],
    ['same.ts', 'unchanged\n'],
    ['script.sh', 'echo synthetic\n'],
    ['binary.bin', Buffer.from([0, 1, 2])],
  ]);
  const head = state([
    ['changed.ts', 'const value = 2;\n'],
    ['new.ts', 'renamed bytes\n'],
    ['same.ts', 'unchanged\n'],
    ['script.sh', 'echo synthetic\n', 'executable'],
    ['binary.bin', Buffer.from([0, 1, 3])],
  ]);
  const manifest = () => ({
    schema: 1,
    kind: 'forge-native-work-backup',
    id: randomUUID(),
    head,
    revision: 1,
    files: [...objects].map(([id, bytes]) => ({ path: 'objects/' + id, sha256: id, size: bytes.length })),
    unavailable: [],
    coverage: 'Synthetic exact source',
  });
  const read = async pins => pins.map(pin => Buffer.from(objects.get(pin.sha256)));
  return { objects, put, state, base, head, manifest, read };
}
test('native source review retains exact before/after bytes, rename add/delete, executable mode and binary evidence', async () => {
  const f = fixture(),
    index = await readNativeSourceReview(f.manifest(), f.base, f.head, f.read);
  assert.deepEqual(
    index.paths.map(x => [x.path, x.status]),
    [
      ['binary.bin', 'modified'],
      ['changed.ts', 'modified'],
      ['new.ts', 'added'],
      ['old.ts', 'deleted'],
      ['same.ts', 'unchanged'],
      ['script.sh', 'modified'],
    ],
  );
  const changed = await readNativeSourceReview(f.manifest(), f.base, f.head, f.read, { file: 'changed.ts' });
  assert.equal(changed.before.text, 'const value = 1;\n');
  assert.equal(changed.comparison.beforeBlob, changed.file.before.blob);
  assert.equal(changed.comparison.afterBlob, changed.file.after.blob);
  assert.equal(changed.after.text, 'const value = 2;\n');
  assert.equal(changed.comparison.hunks[0].lines[0].kind, 'removed');
  const deleted = await readNativeSourceReview(f.manifest(), f.base, f.head, f.read, { file: 'old.ts' });
  assert.equal(deleted.after, null);
  assert.equal(deleted.before.text, 'renamed bytes\n');
  const binary = await readNativeSourceReview(f.manifest(), f.base, f.head, f.read, { file: 'binary.bin' });
  assert.equal(binary.after.kind, 'binary');
  assert.equal(binary.after.size, 3);
  assert(binary.comparison.truncated);
  const mode = index.paths.find(x => x.path === 'script.sh');
  assert.equal(mode.before.blob, mode.after.blob);
  assert.equal(mode.after.mode, 'executable');
});
test('source text pages preserve long lines, Unicode, final newlines and all content beyond the hunk preview', () => {
  const text = 'a'.repeat(15999) + '🐈\n' + 'b'.repeat(1100000) + '\n';
  let offset = 0,
    restored = '';
  do {
    const page = reviewTextPage(Buffer.from(text), offset);
    assert.equal(page.kind, 'text');
    restored += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(restored, text);
  assert.equal(reviewTextPage(Buffer.from('a\nb\nc'), 2).line, 2);
  assert.equal(reviewTextPage(Buffer.from('a\nb\nc'), 3).column, 2);
  assert.equal(reviewTextPage(Buffer.from([255])).kind, 'binary');
  assert.throws(() => reviewTextPage(Buffer.from('x'), -1));
  assert.throws(() => reviewTextPage(Buffer.from('x'), 2));
});
test('missing, corrupt, foreign and invalid native source cannot become replacement review content', async () => {
  const f = fixture();
  await assert.rejects(
    readNativeSourceReview(f.manifest(), f.base, 'f'.repeat(64), f.read),
    e => e.code === 'SOURCE_UNAVAILABLE',
  );
  await assert.rejects(
    readNativeSourceReview(f.manifest(), f.base, f.head, async pins =>
      (await f.read(pins)).map(() => Buffer.from('corrupt')),
    ),
    e => e.code === 'INVALID_NATIVE_SOURCE',
  );
  await assert.rejects(
    readNativeSourceReview(f.manifest(), f.base, f.head, f.read, { file: '../outside' }),
    e => e.code === 'NOT_FOUND',
  );
  const invalid = f.state([['.git/config', 'not source']]);
  await assert.rejects(
    readNativeSourceReview(f.manifest(), f.base, invalid, f.read),
    e => e.code === 'INVALID_NATIVE_SOURCE',
  );
  const overlap = f.state([
    ['folder', 'one'],
    ['folder/file.ts', 'two'],
  ]);
  await assert.rejects(
    readNativeSourceReview(f.manifest(), f.base, overlap, f.read),
    e => e.code === 'INVALID_NATIVE_SOURCE',
  );
});

test('cached blob-pair comparisons preserve context and detect different bytes', async () => {
  const { contextualHunks } = await import('../dist/review-hunks.js');
  const a = Buffer.from('one\ntwo\nthree\n'),
    b = Buffer.from('one\nchanged\nthree\n');
  const compact = contextualHunks(a, b, 0),
    expanded = contextualHunks(a, b, 3);
  assert.equal(contextualHunks(a, b, 0), compact);
  assert.notDeepEqual(expanded, compact);
  assert.notDeepEqual(contextualHunks(a, Buffer.from('other\n'), 0), compact);
});

test('saved file link reads its requested line from exact retained source', async () => {
  const f = fixture();
  const selected = f.state([['deep.ts', Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')]]);
  const page = await readNativeSourceReview(f.manifest(), selected, selected, f.read, {
    file: 'deep.ts',
    line: 142,
  });
  assert.equal(page.source.startLine, 142);
  assert.match(page.source.text, /^line 142\n/);
  await assert.rejects(
    readNativeSourceReview(f.manifest(), selected, selected, f.read, { file: 'deep.ts', line: 300 }),
    { code: 'BAD_ARGUMENT' },
  );
});
