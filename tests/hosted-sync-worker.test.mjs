// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { conflictPlan } from '../dist/agent-sync.js';
import { resolveDocsComposition } from '../dist/native-docs-resolve.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
const at = '2026-01-01T00:00:00.000Z',
  message = 'Native sync parity';
const plan = (left, right) => ({
  schema: 1,
  kind: 'forge-hosted-sync-input',
  algorithm: 'forge-native-sync-v1',
  work: { mode: 'sync', left: { object: left, recipe: null }, right: { object: right, recipe: null } },
  message,
  at,
});
async function parity(t, s, left, right) {
  const root = mkdtempSync(join(tmpdir(), 'forge-sync-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = new NativeSource(root);
  for (const bytes of s.objects.values()) source.put(bytes);
  const merged = source.compose(left.sha256, right.sha256, message, at, { insertionOrder: 'right-first' });
  const output = await s.compute(plan(left, right)),
    result = JSON.parse(output.manifest).result;
  if (merged.head) {
    assert.equal(result.status, merged.head === left.sha256 ? 'up-to-date' : 'merged');
    assert.equal(result.state.sha256, merged.head);
  } else {
    const pending = conflictPlan(source, left.sha256, right.sha256, ['lane', 'target']);
    const files = pending.files.map(file => ({
      path: file.path,
      mode: file.mode,
      blob: file.bytes ? source.put(file.bytes) : file.blob,
    }));
    assert.equal(result.status, 'conflict');
    assert.equal(result.state.sha256, source.writeState(files, [left.sha256], message, at));
    assert.equal(result.left, left.sha256);
    assert.equal(result.right, right.sha256);
  }
  assert(!output.reads.some(p => p.sha256 === s.hidden.blob));
  return { output, result };
}
test('native right-first insertions and disjoint text edits are byte-identical', async t => {
  const s = await composeFixture();
  const left = s.state([s.file('a.txt', 'first\na\nX\nb\nc\n'), s.hidden], [s.baseline.sha256]);
  const right = s.state([s.file('a.txt', 'a\nY\nb\nc\nlast\n'), s.hidden], [s.baseline.sha256]);
  const { result } = await parity(t, s, left, right);
  assert.equal(result.status, 'merged');
  const file = JSON.parse(s.objects.get(result.state.sha256)).files.find(f => f.path === 'a.txt');
  assert.equal(s.objects.get(file.blob).toString(), 'first\na\nY\nX\nb\nc\nlast\n');
});
test('incident 113bc7b3: Windows-1252 CRLF disjoint edits merge in the hosted sync worker byte-exact; same-line edits get CRLF markers', async t => {
  const s = await composeFixture(),
    latin = text => Buffer.from(text, 'latin1');
  const root = s.state([s.file('legacy.c', latin('/* caf\xe9 */\r\nint a;\r\nint b;\r\n')), s.hidden]);
  const left = s.state(
    [s.file('legacy.c', latin('/* d\xe9j\xe0 */\r\nint a;\r\nint b;\r\n')), s.hidden],
    [root.sha256],
  );
  const right = s.state(
    [s.file('legacy.c', latin('/* caf\xe9 */\r\nint a;\r\nint b = \x93q\x94;\r\n')), s.hidden],
    [root.sha256],
  );
  const { result } = await parity(t, s, left, right);
  assert.equal(result.status, 'merged');
  const file = JSON.parse(s.objects.get(result.state.sha256)).files.find(f => f.path === 'legacy.c');
  assert.deepEqual(s.objects.get(file.blob), latin('/* d\xe9j\xe0 */\r\nint a;\r\nint b = \x93q\x94;\r\n'));
  const other = s.state(
    [s.file('legacy.c', latin('/* caf\xe9 */\r\nint a;\r\nint b = \xf1;\r\n')), s.hidden],
    [root.sha256],
  );
  const conflict = (await parity(t, s, right, other)).result;
  assert.equal(conflict.status, 'conflict');
  const draft = JSON.parse(s.objects.get(conflict.state.sha256)).files.find(f => f.path === 'legacy.c');
  assert.deepEqual(
    s.objects.get(draft.blob),
    latin(
      '/* caf\xe9 */\r\nint a;\r\n<<<<<<< lane\r\nint b = \x93q\x94;\r\n||||||| base\r\nint b;\r\n=======\r\nint b = \xf1;\r\n>>>>>>> target\r\n',
    ),
  );
});
for (const recursive of [false, true])
  for (const kind of ['text', 'binary', 'mode', 'delete', 'path', 'symlink']) {
    test(`${recursive ? 'recursive' : 'single'} ${kind} draft uses local native conflict semantics`, async t => {
      const s = await composeFixture(),
        original = s.file('f', kind === 'binary' ? 'base\0' : 'base\n'),
        root = s.state([original, s.hidden]);
      const x =
          kind === 'mode'
            ? { ...original, mode: 'executable' }
            : s.file('f', kind === 'binary' ? 'left\0' : 'left\n', kind === 'symlink' ? 'symlink' : 'file'),
        y =
          kind === 'mode'
            ? { ...original, mode: 'symlink' }
            : s.file('f', kind === 'binary' ? 'right\0' : 'right\n', kind === 'symlink' ? 'symlink' : 'file');
      const xs = kind === 'delete' ? [s.hidden] : [x, s.hidden],
        ys = kind === 'path' ? [s.file('f/child', 'child'), s.hidden] : [y, s.hidden];
      let left = s.state(xs, [root.sha256]),
        right = s.state(ys, [root.sha256]);
      if (recursive) {
        const a = left,
          b = right;
        left = s.state(xs, [a.sha256, b.sha256]);
        right = s.state(ys, [b.sha256, a.sha256]);
      }
      const { result } = await parity(t, s, left, right);
      assert.equal(result.status, 'conflict');
    });
  }
// Issue 949888b8: a landing conflict merges the Lane (right) into main (left), so each draft label
// must name the side whose bytes it holds: main's half under `main`, the Lane's half under `lane`.
// A Lane sync merges main (right) into the Lane (left): `lane` above, `target` below.
async function landingDraft(s, main, lane) {
  const inputs = buildComposePages([
      {
        laneId: '00000000-0000-4000-8000-0000000000aa',
        head: lane.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: { object: lane, recipe: null },
      },
    ]),
    dependencies = buildComposePages([]);
  for (const p of [...inputs.pages, ...dependencies.pages]) s.put(saveBytes(p.value));
  const composed = JSON.parse(
    (
      await s.compute({
        schema: 1,
        kind: 'forge-hosted-compose-input',
        base: { head: main.sha256, receiptId: 'main-0' },
        main: { object: main, recipe: null },
        inputs: inputs.manifest,
        dependencies: dependencies.manifest,
        algorithm: 'forge-native-compose-v1',
        message,
        at,
      })
    ).manifest,
  ).result;
  assert.equal(composed.status, 'conflict');
  const page = JSON.parse(s.objects.get(composed.conflicts.sha256));
  assert.deepEqual([page.left, page.right], [main.sha256, lane.sha256], 'compose orientation: main left');
  const draft = JSON.parse(
    (
      await s.compute({
        ...plan(main, lane),
        work: {
          mode: 'resolution',
          candidateId: '00000000-0000-4000-8000-000000000001',
          conflicts: composed.conflicts,
        },
      })
    ).manifest,
  ).result;
  assert.equal(draft.status, 'conflict');
  return draft;
}
const draftFile = (s, result, path) => {
  const file = JSON.parse(s.objects.get(result.state.sha256)).files.find(f => f.path === path);
  return { ...file, bytes: s.objects.get(file.blob) };
};
test('incident 949888b8: landing-conflict drafts label main as main and the Lane as lane; sync drafts keep lane/target', async t => {
  const s = await composeFixture();
  const root = s.state(
    [
      s.file('text.txt', 'a\nbase\nc\n'),
      s.file('whole.txt', 'one\ntwo\nthree\n'),
      s.file('blob.bin', 'base\0'),
      s.hidden,
    ],
    [s.baseline.sha256],
  );
  // text: same line edited; whole: disjoint text edits that merge, but a clashing mode change,
  // so the draft holds both whole sides; blob: binary edited on both sides.
  const main = s.state(
      [
        s.file('text.txt', 'a\nMAIN\nc\n'),
        s.file('whole.txt', 'ONE-main\ntwo\nthree\n', 'executable'),
        s.file('blob.bin', 'main\0'),
        s.hidden,
      ],
      [root.sha256],
    ),
    lane = s.state(
      [
        s.file('text.txt', 'a\nLANE\nc\n'),
        s.file('whole.txt', 'one\ntwo\nTHREE-lane\n', 'symlink'),
        s.file('blob.bin', 'lane\0'),
        s.hidden,
      ],
      [root.sha256],
    );
  const landing = await landingDraft(s, main, lane);
  assert.equal(
    draftFile(s, landing, 'text.txt').bytes.toString(),
    'a\n<<<<<<< main\nMAIN\n||||||| base\nbase\n=======\nLANE\n>>>>>>> lane\nc\n',
  );
  assert.equal(
    draftFile(s, landing, 'whole.txt').bytes.toString(),
    '<<<<<<< main\nONE-main\ntwo\nthree\n||||||| base\none\ntwo\nthree\n=======\none\ntwo\nTHREE-lane\n>>>>>>> lane\n',
  );
  // A binary landing conflict holds main's bytes unchanged, as CONFLICT_SIDE_REQUIRED names it.
  assert.equal(draftFile(s, landing, 'blob.bin').bytes.toString(), 'main\0');
  // Contrast: a Lane sync of the same edits merges main into the Lane, so the Lane is above.
  const { result: sync } = await parity(t, s, lane, main);
  assert.equal(sync.status, 'conflict');
  assert.equal(
    draftFile(s, sync, 'text.txt').bytes.toString(),
    'a\n<<<<<<< lane\nLANE\n||||||| base\nbase\n=======\nMAIN\n>>>>>>> target\nc\n',
  );
  assert.equal(
    draftFile(s, sync, 'whole.txt').bytes.toString(),
    '<<<<<<< lane\none\ntwo\nTHREE-lane\n||||||| base\none\ntwo\nthree\n=======\nONE-main\ntwo\nthree\n>>>>>>> target\n',
  );
  assert.equal(draftFile(s, sync, 'blob.bin').bytes.toString(), 'lane\0');
});
// Issue 561996ac: a Lane sync whose only conflict is Markdown docs takes native finish's rule.
test('a Markdown-only sync conflict merges with the docs rule, byte-identical to native finish', async t => {
  const s = await composeFixture(),
    para = side => s.file('docs/status.md', `# Status\n\nIntro.${side ? ` ${side} sentence.` : ''}\n`);
  const root = s.state([para(''), s.hidden], [s.baseline.sha256]);
  const lane = s.state([para('Lane'), s.hidden], [root.sha256]),
    main = s.state([para('Main'), s.hidden], [root.sha256]);
  const dir = mkdtempSync(join(tmpdir(), 'forge-sync-docs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const native = new NativeSource(dir);
  for (const bytes of s.objects.values()) native.put(bytes);
  const expected = resolveDocsComposition(native, lane.sha256, main.sha256, message, at);
  const result = JSON.parse((await s.compute(plan(lane, main))).manifest).result;
  assert.equal(result.status, 'merged');
  assert.equal(result.state.sha256, expected.head);
  assert.deepEqual(result.docs, { paths: ['docs/status.md'], rule: 'keep both sides, main first' });
  const file = JSON.parse(s.objects.get(result.state.sha256)).files.find(f => f.path === 'docs/status.md');
  assert.equal(s.objects.get(file.blob).toString(), '# Status\n\nIntro. Main sentence. Lane sentence.\n');
  // A code conflict beside it keeps the native conflict draft for every path.
  const code = side => s.file('src/x.ts', `export const x = '${side}';\n`);
  const base2 = s.state([para(''), code('base'), s.hidden], [s.baseline.sha256]);
  const { result: mixed } = await parity(
    t,
    s,
    s.state([para('Lane'), code('lane'), s.hidden], [base2.sha256]),
    s.state([para('Main'), code('main'), s.hidden], [base2.sha256]),
  );
  assert.equal(mixed.status, 'conflict');
});
test('250 conflict paths page automatically and fetch each affected object once', async t => {
  const s = await composeFixture(),
    original = [],
    l = [],
    r = [];
  for (let i = 0; i < 250; i++) {
    const path = `f${String(i).padStart(3, '0')}`;
    original.push(s.file(path, `base-${i}\n`));
    l.push(s.file(path, `left-${i}\n`));
    r.push(s.file(path, `right-${i}\n`));
  }
  const base = s.state([...original, s.hidden]),
    left = s.state([...l, s.hidden], [base.sha256]),
    right = s.state([...r, s.hidden], [base.sha256]);
  const { output, result } = await parity(t, s, left, right);
  let next = result.conflicts;
  const pages = [];
  while (next) {
    const page = JSON.parse(s.objects.get(next.sha256));
    pages.push(page.paths.length);
    assert(next.size < 128 * 1024);
    next = page.next;
  }
  assert.deepEqual(pages, [100, 100, 50]);
  assert.equal(new Set(output.reads.map(p => p.sha256)).size, output.reads.length);
  t.diagnostic(JSON.stringify({ ...output.metrics, conflictPages: pages }));
});
// Incident 113bc7b3: a binary conflict's draft holds one side unchanged. Resolving it untouched
// used to drop the other side silently; it is refused until the file changes or is kept explicitly.
test('incident 113bc7b3: an unchanged binary conflict is refused; an explicit keep resolves choose-left', async () => {
  const s = await composeFixture(),
    root = s.state([s.file('f', 'base\0'), s.hidden]),
    left = s.state([s.file('f', 'left\0'), s.hidden], [root.sha256]),
    right = s.state([s.file('f', 'right\0'), s.hidden], [root.sha256]);
  const draft = await s.compute(plan(left, right)),
    conflict = JSON.parse(draft.manifest).result;
  for (const candidateId of [null, '00000000-0000-4000-8000-000000000001']) {
    const resolution = {
      candidateId,
      conflicts: conflict.conflicts,
      left: left.sha256,
      right: right.sha256,
      draftHead: conflict.state.sha256,
      status: 'pending',
    };
    const work = { mode: 'resolve', left: { object: conflict.state, recipe: null }, resolution };
    await assert.rejects(s.compute({ ...plan(left, right), work }), error => {
      assert.equal(error.code, 'CONFLICT_SIDE_REQUIRED');
      assert.deepEqual(error.recovery.paths, ['f']);
      assert.equal(error.recovery.otherState, right.sha256);
      assert.match(error.message, candidateId ? /main's version unchanged/ : /the Lane's version unchanged/);
      assert.match(error.message, /keep:\["PATH"\]/);
      return true;
    });
    const completed = await s.compute({ ...plan(left, right), work: { ...work, keep: ['f'] } });
    const result = JSON.parse(completed.manifest).result,
      state = JSON.parse(s.objects.get(result.state.sha256));
    assert.equal(result.status, 'resolved');
    assert.equal(result.resolution.status, 'resolved');
    assert.deepEqual(state.parents, [conflict.state.sha256, right.sha256]);
    assert.equal(
      state.files.find(f => f.path === 'f').blob,
      JSON.parse(s.objects.get(left.sha256)).files.find(f => f.path === 'f').blob,
    );
  }
  // Writing the other side's bytes is an explicit choice and needs no keep.
  const chosen = s.state([s.file('f', 'right\0'), s.hidden], [conflict.state.sha256]);
  const taken = await s.compute({
    ...plan(left, right),
    work: {
      mode: 'resolve',
      left: { object: chosen, recipe: null },
      resolution: {
        candidateId: null,
        conflicts: conflict.conflicts,
        left: left.sha256,
        right: right.sha256,
        draftHead: conflict.state.sha256,
        status: 'pending',
      },
    },
  });
  assert.equal(JSON.parse(taken.manifest).result.status, 'resolved');
});
test('unrelated roots, substituted drafts and corrupt ancestry fail without guessing source', async () => {
  const s = await composeFixture(),
    other = s.state([], [], 'unrelated');
  await assert.rejects(s.compute(plan(s.baseline, other)), e => e.code === 'NATIVE_MERGE_BASE_UNKNOWN');
  const left = s.state([s.file('f', 'left')], [s.baseline.sha256]),
    right = s.state([s.file('f', 'right')], [s.baseline.sha256]);
  const draft = await s.compute(plan(left, right)),
    result = JSON.parse(draft.manifest).result;
  await assert.rejects(
    s.compute({
      ...plan(left, right),
      work: {
        mode: 'resolve',
        left: { object: other, recipe: null },
        resolution: {
          candidateId: null,
          conflicts: result.conflicts,
          left: left.sha256,
          right: right.sha256,
          draftHead: result.state.sha256,
          status: 'pending',
        },
      },
    }),
    e => e.code === 'WORK_STALE',
  );
  s.objects.set(s.baseline.sha256, Buffer.from('corrupt'));
  await assert.rejects(s.compute(plan(left, right)), e => e.code === 'SOURCE_HASH_MISMATCH');
});
