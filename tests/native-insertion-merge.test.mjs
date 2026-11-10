// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeNativeText, markNativeTextConflicts } from '../dist/native-text-merge.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';

const bytes = text => Buffer.from(text);
const base = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";
const main = "\ntest('main addition', () => {\n  assert.equal(2 + 2, 4);\n});\n";
const lane = "\ntest('lane addition', () => {\n  assert.equal(3 + 3, 6);\n});\n";
const merge = (original, left, right, options) =>
  mergeNativeText(bytes(original), bytes(left), bytes(right), 'file.mjs', options);

test('EOF test-block additions merge main first, record the hunk and parse as JavaScript', () => {
  const resolutions = [];
  const result = merge(base, base + main, base + lane, { resolutions });
  assert.equal(result?.toString(), base + main + lane);
  assert.deepEqual(resolutions, [{ baseLine: 3, resolved: 'both-insertions' }]);
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: result });
  assert.equal(checked.status, 0, checked.stderr?.toString());
});

test('same-anchor middle insertions retain complete blocks and surrounding base bytes', () => {
  const end = 'export const end = true;\n';
  assert.equal(merge(base + end, base + main + end, base + lane + end)?.toString(), base + main + lane + end);
});

for (const [name, other] of [
  ['modify', 'changed\nend\n'],
  ['delete', 'end\n'],
]) {
  test(`insertion versus base-line ${name} remains a conflict in either orientation`, () => {
    const original = 'anchor\nend\n',
      added = 'new\n' + original;
    for (const [left, right] of [
      [added, other],
      [other, added],
    ]) {
      assert.equal(merge(original, left, right), null);
      assert.equal(
        markNativeTextConflicts(bytes(original), bytes(left), bytes(right), ['main', 'lane']).conflicted,
        true,
      );
    }
  });
}

test('identical insertions use deduplication and do not claim a both-insertions resolution', () => {
  const resolutions = [];
  assert.equal(merge(base, base + main, base + main, { resolutions })?.toString(), base + main);
  assert.deepEqual(resolutions, []);
});

test('partial copies and textually overlapping additions remain conflicts', () => {
  for (const [left, right] of [
    ['one\n', 'one\ntwo\n'],
    ['two\n', 'one\ntwo\n'],
    ['one\nshared\n', 'shared\ntwo\n'],
    ['one\n🔥\n', '🔥\ntwo\n'],
    ['prefix\nshared\nsuffix\n', 'other\nshared\nlast\n'],
  ]) {
    for (const [a, b] of [
      [left, right],
      [right, left],
    ]) {
      assert.equal(merge(base, base + a, base + b), null);
      assert.equal(
        markNativeTextConflicts(bytes(base), bytes(base + a), bytes(base + b), ['main', 'lane']).conflicted,
        true,
      );
    }
  }
});

test('fragmentary additions cannot join lines, and CRLF insertions retain exact bytes', () => {
  assert.equal(merge(base, base + 'main', base + 'lane\n'), null);
  assert.equal(merge(base, base + 'main\n', base + 'lane'), null);
  const crlf = text => text.replaceAll('\n', '\r\n');
  assert.equal(merge(crlf(base), crlf(base + main), crlf(base + lane))?.toString(), crlf(base + main + lane));
});

test('conflict markers retain auto-resolved insertion hunks alongside a real modification conflict', () => {
  const original = 'anchor\nunchanged\nlast\n';
  const left = 'main\nanchor\nunchanged\nLEFT\n';
  const right = 'lane\nanchor\nunchanged\nRIGHT\n';
  const result = markNativeTextConflicts(bytes(original), bytes(left), bytes(right), ['main', 'lane']);
  assert.equal(result.conflicted, true);
  assert.equal(
    result.bytes.toString(),
    'main\nlane\nanchor\nunchanged\n<<<<<<< main\nLEFT\n||||||| base\nlast\n=======\nRIGHT\n>>>>>>> lane\n',
  );
  assert.deepEqual(result.resolutions, [{ baseLine: 1, resolved: 'both-insertions' }]);
});

// Issue 113bc7b3: text is Git's rule (no NUL in the first 8,000 bytes, no UTF-16 BOM), not UTF-8
// validity, so legacy-encoded sources merge line by line on their exact bytes.
const latin = text => Buffer.from(text, 'latin1');
const legacy = [
  latin('/* caf\xe9 \xa9 */'),
  latin('int a = 1; /* \x93quoted\x94 */'),
  latin('int b = 2;'),
  latin('int c = 3;'),
  latin('int d = 4; /* \x80\x96\xf1 */'),
];
const file = (lines, eol) => Buffer.concat(lines.flatMap(line => [line, latin(eol)]));
const replaced = (lines, edits) => lines.map((line, i) => edits[i] ?? line);
test('incident 113bc7b3: disjoint edits to Windows-1252 and Latin-1 CRLF files merge byte-exact', () => {
  for (const eol of ['\n', '\r\n']) {
    const original = file(legacy, eol),
      left = file(replaced(legacy, { 0: latin('/* d\xe9j\xe0 */') }), eol),
      right = file(replaced(legacy, { 4: latin('int d = 5; /* \xa9 */') }), eol),
      expected = file(
        replaced(legacy, { 0: latin('/* d\xe9j\xe0 */'), 4: latin('int d = 5; /* \xa9 */') }),
        eol,
      );
    assert.equal(new TextDecoder().decode(original).includes('\ufffd'), true, 'fixture is not UTF-8');
    assert.deepEqual(
      mergeNativeText(original, left, right, 'legacy.c'),
      expected,
      `merge, eol ${JSON.stringify(eol)}`,
    );
    const marked = markNativeTextConflicts(original, left, right, ['lane', 'main']);
    assert.equal(marked.conflicted, false);
    assert.deepEqual(marked.bytes, expected);
  }
});
test('incident 113bc7b3: a same-line edit in a Windows-1252 file gets ASCII markers and both sides exactly', () => {
  const original = file(legacy, '\n'),
    left = file(replaced(legacy, { 2: latin('int b = 20; /* \xe9 */') }), '\n'),
    right = file(replaced(legacy, { 2: latin('int b = 21; /* \xf1 */') }), '\n');
  assert.equal(mergeNativeText(original, left, right, 'legacy.c'), null);
  const marked = markNativeTextConflicts(original, left, right, ['lane', 'main']);
  assert.equal(marked.conflicted, true);
  assert.deepEqual(
    marked.bytes,
    file(
      [
        ...legacy.slice(0, 2),
        latin('<<<<<<< lane'),
        latin('int b = 20; /* \xe9 */'),
        latin('||||||| base'),
        legacy[2],
        latin('======='),
        latin('int b = 21; /* \xf1 */'),
        latin('>>>>>>> main'),
        ...legacy.slice(3),
      ],
      '\n',
    ),
  );
});
test('incident 113bc7b3: NUL and UTF-16 inputs stay binary; UTF-8 text with control bytes merges', () => {
  const nul = Buffer.from('a\nb\0\nc\n'),
    utf16 = Buffer.from([0xff, 0xfe, 0x61, 0x00]);
  assert.equal(mergeNativeText(nul, Buffer.from('A\nb\0\nc\n'), Buffer.from('a\nb\0\nC\n')), null);
  assert.equal(markNativeTextConflicts(nul, nul, Buffer.from('x\0')), null);
  assert.equal(markNativeTextConflicts(utf16, utf16, Buffer.from([0xff, 0xfe, 0x62, 0x20])), null);
  // A NUL after Git's 8,000-byte window does not make the file binary.
  const tail = Buffer.concat([Buffer.from('a\n' + 'x'.repeat(8000) + '\n'), Buffer.from('\0\n')]);
  assert.deepEqual(
    mergeNativeText(
      tail,
      Buffer.concat([Buffer.from('A'), tail.subarray(1)]),
      Buffer.concat([tail, Buffer.from('z\n')]),
    ),
    Buffer.concat([Buffer.from('A'), tail.subarray(1), Buffer.from('z\n')]),
  );
  assert.deepEqual(
    mergeNativeText(Buffer.from('\f\na\nb\n'), Buffer.from('\f\nA\nb\n'), Buffer.from('\f\na\nB\n')),
    Buffer.from('\f\nA\nB\n'),
  );
});
test('incident d36380ca: markers take the hunk EOL: CRLF in CRLF files, LF unchanged, LF for a mixed hunk', () => {
  const crlf = markNativeTextConflicts(
    Buffer.from('a\r\nb\r\nc\r\n'),
    Buffer.from('a\r\nL\r\nc\r\n'),
    Buffer.from('a\r\nR\r\nc\r\n'),
    ['lane', 'main'],
  );
  assert.equal(
    crlf.bytes.toString(),
    'a\r\n<<<<<<< lane\r\nL\r\n||||||| base\r\nb\r\n=======\r\nR\r\n>>>>>>> main\r\nc\r\n',
  );
  const resolved = crlf.bytes
    .toString()
    .split('\r\n')
    .filter(line => !/^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/.test(line))
    .join('\r\n');
  assert.doesNotMatch(resolved, /[^\r]\n/, 'removing marker lines leaves no lone LF');
  // A last line without EOL in a CRLF file is terminated with CRLF inside the hunk.
  assert.equal(
    markNativeTextConflicts(Buffer.from('a\r\nb'), Buffer.from('a\r\nL'), Buffer.from('a\r\nR'), [
      'lane',
      'main',
    ]).bytes.toString(),
    'a\r\n<<<<<<< lane\r\nL\r\n||||||| base\r\nb\r\n=======\r\nR\r\n>>>>>>> main\r\n',
  );
  assert.equal(
    markNativeTextConflicts(Buffer.from('a\nb\nc\n'), Buffer.from('a\nL\nc\n'), Buffer.from('a\nR\nc\n'), [
      'lane',
      'main',
    ]).bytes.toString(),
    'a\n<<<<<<< lane\nL\n||||||| base\nb\n=======\nR\n>>>>>>> main\nc\n',
  );
  assert.equal(
    markNativeTextConflicts(
      Buffer.from('a\nb\r\nc\n'),
      Buffer.from('a\nL\r\nc\n'),
      Buffer.from('a\nR\nc\n'),
      ['lane', 'main'],
    ).bytes.toString(),
    'a\n<<<<<<< lane\nL\r\n||||||| base\nb\r\n=======\nR\n>>>>>>> main\nc\n',
  );
});
function fixture(t, withDocs = false) {
  const root = mkdtempSync(join(tmpdir(), 'forge-insertion-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'file.mjs'), base);
  if (withDocs) writeFileSync(join(root, 'README.md'), '- base capability\n');
  const origin = initNative(root).head,
    source = new NativeSource(root);
  const state = (text, message, doc = '- base capability\n') =>
    source.writeState(
      [
        { path: 'file.mjs', mode: 'file', blob: source.put(bytes(text)) },
        ...(withDocs ? [{ path: 'README.md', mode: 'file', blob: source.put(bytes(doc)) }] : []),
      ],
      [origin],
      message,
      'now',
    );
  return { root, origin, source, state };
}

test('native composition reports and retains resolution provenance with original parent States', t => {
  const { source, state } = fixture(t);
  const mainHead = state(base + main, 'main'),
    laneHead = state(base + lane, 'lane');
  const result = source.compose(mainHead, laneHead, 'Combine', 'now');
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.resolutions, [{ path: 'file.mjs', baseLine: 3, resolved: 'both-insertions' }]);
  const merged = source.state(result.head);
  assert.equal(source.object(merged.files[0].blob).toString(), base + main + lane);
  assert.deepEqual(merged.parents, [mainHead, laneHead]);
  assert.match(merged.message, /both-insertions.*file\.mjs:3/);
  assert.deepEqual(source.compose(mainHead, laneHead, 'Combine', 'now'), result);
  assert.equal(source.object(source.state(mainHead).files[0].blob).toString(), base + main);
  assert.equal(source.object(source.state(laneHead).files[0].blob).toString(), base + lane);
});

test('a later unresolved hunk prevents publication of speculative resolution notes', () => {
  const resolutions = [];
  assert.equal(
    merge('anchor\nlast\n', 'main\nanchor\nLEFT\n', 'lane\nanchor\nRIGHT\n', { resolutions }),
    null,
  );
  assert.deepEqual(resolutions, []);
});
