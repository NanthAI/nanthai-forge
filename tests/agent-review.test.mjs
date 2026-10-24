// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkService } from '../dist/work.js';
import { readAgentReview } from '../dist/agent-review.js';
import { viewReview } from '../dist/work-detail.js';
import { fixture as gitFixture, git, code } from './helpers.mjs';
function fixture(t, native = true) {
  let root;
  if (native) {
    const dir = mkdtempSync(join(tmpdir(), 'forge-agent-review-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    root = join(dir, 'owner');
    mkdirSync(root);
  } else root = gitFixture(t);
  writeFileSync(
    join(root, 'a.ts'),
    Array.from({ length: 100 }, (_, i) => `export const value${i}=1;`).join('\n') + '\n',
  );
  writeFileSync(join(root, 'mode.txt'), 'same bytes\n');
  writeFileSync(join(root, 'delete.txt'), 'removed\n');
  if (native) initNative(root);
  else {
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'fixture']);
  }
  const work = new WorkService(root),
    act = command => work.execute(command, work.status().revision).result;
  const intent = act({ action: 'intent', outcome: 'Compact review' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Change' }),
    path = work.store.path(lane.id);
  const read = (options = {}) =>
    readAgentReview(work.store, { kind: 'lane', id: lane.id, expectedHead: lane.head, ...options }).result;
  const checkpoint = () => {
    if (!native) git(path, ['add', '.']);
    const current = work.status().lanes[0];
    return act({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: current.actualHead,
      expectedTree: current.indexTree,
      message: 'Changed',
    });
  };
  return { root, work, act, intent, lane, path, read, checkpoint };
}
test('compact native review shows exact summary and minimal selected contextual hunks without Git or mutation', t => {
  const f = fixture(t),
    original = readFileSync(join(f.path, 'a.ts'), 'utf8');
  writeFileSync(
    join(f.path, 'a.ts'),
    original.replace('value10=1', 'value10=2').replace('value90=1', 'value90=3'),
  );
  chmodSync(join(f.path, 'mode.txt'), 0o700);
  rmSync(join(f.path, 'delete.txt'));
  writeFileSync(join(f.path, 'add.txt'), 'added\n');
  const journal = readWorkBytes(join(f.work.store.directory, 'work.json'));
  const summary = f.read();
  assert.equal(summary.total, 4);
  assert.equal(summary.truncated, false);
  assert.equal(
    summary.changes.some(change => 'hunks' in change),
    false,
  );
  assert.equal(summary.indexTree.length, 64);
  const selected = f.read({ paths: ['a.ts'], context: 2 });
  assert.equal(selected.selectedTotal, 1);
  assert.equal(selected.total, 4);
  assert.equal(selected.changes[0].hunks.length, 2);
  assert.equal(selected.changes[0].hunks[0].beforeStart, 9);
  assert.equal(selected.changes[0].hunks[0].lines.length, 6);
  assert.equal(JSON.stringify(selected).includes('value50'), false);
  assert.equal(selected.changes[0].truncated, false);
  assert.match(selected.changes[0].before.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(readWorkBytes(join(f.work.store.directory, 'work.json')), journal);
  assert.equal(existsSync(join(f.root, '.git')), false);
  const checkpoint = f.checkpoint(),
    view = f.act({
      action: 'compose',
      operationId: randomUUID(),
      intentId: f.intent.id,
      inputs: [{ laneId: f.lane.id, head: checkpoint.head }],
    });
  const review = {
    kind: 'view',
    id: view.id,
    expectedHead: view.head,
    expectedBase: view.base,
    expectedStatus: view.status,
    paths: ['a.ts'],
  };
  const pinned = readAgentReview(f.work.store, review).result;
  writeFileSync(join(f.path, 'a.ts'), 'later live source');
  assert.deepEqual(readAgentReview(f.work.store, review).result, pinned);
  assert.throws(
    () => readAgentReview(f.work.store, { ...review, expectedBase: '0'.repeat(64) }),
    code('VIEW_STALE'),
  );
  assert.match(viewReview(f.work.store, view).details, /Whole-file before\/after/);
});
test('compact review bounds content and discloses binary, newline and alignment truncation', t => {
  const f = fixture(t);
  writeFileSync(join(f.path, 'a.ts'), 'x'.repeat(10000));
  assert.throws(() => f.read({ paths: ['a.ts'], maxBytes: 1024 }), code('OUTPUT_LIMIT'));
  const limited = f.read({ paths: ['a.ts'], maxBytes: 2048 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.changes[0].hunks.length, 0);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify(
        readAgentReview(f.work.store, {
          kind: 'lane',
          id: f.lane.id,
          expectedHead: f.lane.head,
          paths: ['a.ts'],
          maxBytes: 2048,
        }),
      ),
    ) <= 2048,
  );
  writeFileSync(join(f.path, 'a.ts'), Buffer.from([0, 255]));
  assert.match(f.read({ paths: ['a.ts'] }).changes[0].content, /binary/);
  writeFileSync(join(f.path, 'mode.txt'), 'same bytes');
  const newline = f.read({ paths: ['mode.txt'] }).changes[0];
  assert.equal(
    newline.hunks[0].lines.some(line => line.kind === 'removed' && line.text === ''),
    true,
  );
  writeFileSync(join(f.path, 'a.ts'), Array.from({ length: 12000 }, (_, i) => `different ${i}`).join('\n'));
  const fallback = f.read({ paths: ['a.ts'], maxBytes: 48000 });
  assert.equal(fallback.truncated, true);
  assert.throws(() => f.read({ paths: ['../outside'] }));
  assert.throws(() => f.read({ maxBytes: 0 }));
});
test('selected live review rejects changed bytes, modes and reappeared deletions after capture', t => {
  const f = fixture(t),
    capture = NativeSource.prototype.capture;
  const assertRace = mutation => {
    NativeSource.prototype.capture = function (root, ...args) {
      const files = capture.call(this, root, ...args);
      if (root === f.path) mutation();
      return files;
    };
    try {
      assert.throws(() => f.read({ paths: ['a.ts', 'delete.txt', 'mode.txt'] }), code('SOURCE_CHANGED'));
    } finally {
      NativeSource.prototype.capture = capture;
    }
  };
  writeFileSync(join(f.path, 'a.ts'), 'first');
  assertRace(() => writeFileSync(join(f.path, 'a.ts'), 'second'));
  writeFileSync(join(f.path, 'a.ts'), readFileSync(join(f.root, 'a.ts')));
  chmodSync(join(f.path, 'mode.txt'), 0o700);
  assertRace(() => chmodSync(join(f.path, 'mode.txt'), 0o600));
  rmSync(join(f.path, 'delete.txt'));
  assertRace(() => writeFileSync(join(f.path, 'delete.txt'), 'reappeared'));
});
test('Git compatibility compact review uses original object pins and preserves lazy full review', t => {
  const f = fixture(t, false);
  writeFileSync(
    join(f.path, 'a.ts'),
    readFileSync(join(f.path, 'a.ts'), 'utf8').replace('value10=1', 'value10=2'),
  );
  writeFileSync(join(f.path, 'added.txt'), 'untracked source\n');
  rmSync(join(f.path, 'delete.txt'));
  const selected = f.read({ paths: ['a.ts', 'added.txt', 'delete.txt'] });
  assert.equal(selected.total, 3);
  assert.equal(
    selected.changes.every(change => change.hunks.length === 1),
    true,
  );
  const checkpoint = f.checkpoint(),
    view = f.act({
      action: 'compose',
      operationId: randomUUID(),
      intentId: f.intent.id,
      inputs: [{ laneId: f.lane.id, head: checkpoint.head }],
    });
  const result = readAgentReview(f.work.store, {
    kind: 'view',
    id: view.id,
    expectedHead: view.head,
    expectedBase: view.base,
    expectedStatus: view.status,
    paths: ['a.ts'],
  }).result;
  assert.match(result.changes[0].after.hash, /^[a-f0-9]{40}$/);
  assert.equal(result.changes[0].hunks.length, 1);
  assert.match(
    viewReview(f.work.store, { ...view, details: '' }).details,
    /-export const value10=1;\n\+export const value10=2;/,
  );
});
test('review pages expose all 101 paths, continue after byte truncation, and guard changed live selections', t => {
  const f = fixture(t);
  for (let i = 0; i < 101; i++)
    writeFileSync(join(f.path, `new-${String(i).padStart(3, '0')}.txt`), 'new source\n');
  const first = f.read({ limit: 100, maxBytes: 48000 });
  assert.equal(first.total, 101);
  assert.equal(first.changes.length, 100);
  assert.equal(first.more, true);
  assert.equal(first.nextOffset, 100);
  const last = f.read({
    offset: first.nextOffset,
    expectedReviewTree: first.reviewTree,
    limit: 100,
    maxBytes: 48000,
  });
  assert.equal(last.changes[0].path, 'new-100.txt');
  assert.equal(last.more, false);
  assert.equal(last.nextOffset, null);
  assert.equal(last.reviewTree, first.reviewTree);
  const small = f.read({ limit: 100, maxBytes: 2048 });
  assert.ok(small.changes.length > 0 && small.changes.length < 100);
  assert.equal(small.nextOffset, small.changes.length);
  const next = f.read({
    offset: small.nextOffset,
    expectedReviewTree: small.reviewTree,
    limit: 100,
    maxBytes: 2048,
  });
  assert.notEqual(next.changes[0].path, small.changes[0].path);
  writeFileSync(join(f.path, 'new-100.txt'), 'changed during pagination\n');
  assert.throws(
    () => f.read({ offset: first.nextOffset, expectedReviewTree: first.reviewTree }),
    code('SOURCE_CHANGED'),
  );
  assert.throws(() => f.read({ offset: -1 }));
});
test('Git staged deletion plus recreation is one live modification; identical recreation is no live change', t => {
  const f = fixture(t, false),
    original = readFileSync(join(f.path, 'delete.txt'));
  git(f.path, ['rm', 'delete.txt']);
  writeFileSync(join(f.path, 'delete.txt'), 'replacement\n');
  const summary = f.read();
  assert.equal(summary.total, 1);
  assert.equal(summary.changes[0].status, 'modified');
  assert.equal(summary.changes[0].path, 'delete.txt');
  assert.equal(summary.stagedChanges, 1);
  assert.equal(summary.untrackedFiles, 1);
  assert.equal(summary.workingMatchesIndex, false);
  const selected = f.read({ paths: ['delete.txt'] });
  assert.equal(selected.changes.length, 1);
  assert.equal(
    selected.changes[0].hunks[0].lines.some(line => line.kind === 'added' && line.text === 'replacement'),
    true,
  );
  writeFileSync(join(f.path, 'delete.txt'), original);
  const same = f.read({ paths: ['delete.txt'] });
  assert.equal(same.total, 0);
  assert.equal(same.stagedChanges, 1);
  assert.equal(same.untrackedFiles, 1);
  assert.equal(same.workingMatchesIndex, false);
});
test('Git live review pins staged checkpoint separately from unstaged text and preserves journal', t => {
  const f = fixture(t, false);
  writeFileSync(join(f.path, 'mode.txt'), 'staged\n');
  git(f.path, ['add', 'mode.txt']);
  writeFileSync(join(f.path, 'mode.txt'), 'live\n');
  const journal = readWorkBytes(join(f.work.store.directory, 'work.json'));
  const result = f.read({ paths: ['mode.txt'] });
  assert.equal(result.indexTree, git(f.path, ['write-tree']).trim());
  assert.equal(result.selection, 'live-working-source');
  assert.equal(result.checkpointSource, 'staged-index');
  assert.equal(result.stagedChanges, 1);
  assert.equal(result.unstagedChanges, 1);
  assert.equal(result.workingMatchesIndex, false);
  assert.equal(
    result.changes[0].hunks[0].lines.some(line => line.kind === 'added' && line.text === 'live'),
    true,
  );
  assert.deepEqual(readWorkBytes(join(f.work.store.directory, 'work.json')), journal);
});
