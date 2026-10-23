// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSource } from '../dist/native-source.js';
import { conflictPlan, agentSync, syncTestHooks } from '../dist/agent-sync.js';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { randomUUID } from 'node:crypto';

const at = '2026-10-18T00:00:00.000Z';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-merge-bases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = new NativeSource(root);
  const file = (text, path = 'f', mode = 'file') => ({ path, mode, blob: source.put(Buffer.from(text)) });
  const state = (files, parents = [], message = 'synthetic') =>
    source.writeState(files, parents, message, at);
  const text = head => source.object(source.state(head).files.find(f => f.path === 'f').blob).toString();
  return { source, file, state, text };
}

test('criss-cross bases compose recursively, deterministically, retaining original States', t => {
  const { source, file, state, text } = fixture(t);
  const root = state([file('a\nb\nc\nd\ne\nf\ng\n')]);
  const a = state([file('A\nb\nc\nd\ne\nf\ng\n')], [root]);
  const b = state([file('a\nb\nc\nd\ne\nf\nG\n')], [root]);
  const l = state([file('A\nb\nC\nd\ne\nf\nG\n')], [a, b]);
  const r = state([file('A\nb\nc\nd\nE\nf\nG\n')], [b, a]);
  const originals = [root, a, b, l, r].map(id => source.object(id));
  const merged = source.compose(l, r, 'merge', at);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(text(merged.head), 'A\nb\nC\nd\nE\nf\nG\n');
  assert.deepEqual(source.state(merged.head).parents, [l, r]);
  assert.deepEqual(source.compose(l, r, 'merge', at), merged);
  assert.deepEqual(source.mergeFiles(l, r), source.mergeFiles(l, r));
  assert.deepEqual(source.mergeFiles(l, r).files, source.mergeFiles(r, l).files);
  [root, a, b, l, r].forEach((id, i) => assert.deepEqual(source.object(id), originals[i]));
  assert.deepEqual(conflictPlan(source, l, r, 'main').conflicts, []);
});

test('stacked Lane syncs after its parent lands following independent syncs (60174476 shape)', t => {
  const { source, file, state, text } = fixture(t);
  const root = state([file('a\nb\nc\nd\ne\nf\ng\n')]);
  const parent = state([file('A\nb\nc\nd\ne\nf\ng\n')], [root]);
  const main = state([file('a\nb\nc\nd\ne\nf\nG\n')], [root]);
  const stacked = state([file('A\nb\nC\nd\ne\nf\ng\n')], [parent]);
  const synced = source.compose(stacked, main, 'stack sync', at).head;
  const landed = source.compose(main, parent, 'land parent', at).head;
  const after = source.compose(synced, landed, 'sync landed parent', at);
  assert.deepEqual(after.conflicts, []);
  assert.equal(text(after.head), 'A\nb\nC\nd\ne\nf\nG\n');
  assert.deepEqual(conflictPlan(source, synced, landed, 'main').conflicts, []);
});

test('three stacked handovers survive independent main syncs and sequential landings', t => {
  const { source, file, state } = fixture(t);
  const root = state([]);
  let parent = root;
  const lanes = [];
  for (let i = 0; i < 3; i++) {
    parent = state([...source.state(parent).files, file(`handover ${i}`, `h${i}`)], [parent]);
    lanes.push(parent);
  }
  let main = state([file('main', 'main')], [root]);
  const synced = lanes.map(head => source.compose(head, main, 'sync', at).head);
  for (const head of synced) {
    const merged = source.compose(main, head, 'land', at);
    assert.deepEqual(merged.conflicts, []);
    main = merged.head;
  }
  assert.deepEqual(
    source.state(main).files.map(f => f.path),
    ['h0', 'h1', 'h2', 'main'],
  );
});

for (const kind of ['text', 'binary', 'mode', 'delete', 'path']) {
  test(`conflicting virtual-base ${kind} variants remain normal conflicts until heads agree`, t => {
    const { source, file, state } = fixture(t);
    const original = file(kind === 'binary' ? 'base\0' : 'base\n');
    const root = state([original]);
    const x =
      kind === 'mode' ? { ...original, mode: 'executable' } : file(kind === 'binary' ? 'left\0' : 'left\n');
    const y =
      kind === 'mode' ? { ...original, mode: 'symlink' } : file(kind === 'binary' ? 'right\0' : 'right\n');
    const xs = kind === 'delete' ? [] : [x];
    const ys = kind === 'path' ? [file('child', 'f/child')] : [y];
    const a = state(xs, [root]),
      b = state(ys, [root]);
    const l = state(xs, [a, b]),
      r = state(ys, [b, a]);
    const merged = source.compose(l, r, 'merge', at);
    assert.equal(merged.head, undefined);
    assert(merged.conflicts.includes('f'));
    assert(conflictPlan(source, l, r, 'main').conflicts.some(c => c.path === 'f'));
    assert.deepEqual(source.compose(l, r, 'merge', at), merged);
    const agreed = state(xs, [b, a], 'agreed');
    assert.deepEqual(source.compose(l, agreed, 'resolved', at).conflicts, []);
  });
}

test('single-base merges retain content/mode behavior and unrelated histories still fail explicitly', t => {
  const { source, file, state, text } = fixture(t);
  const base = state([file('a\nb\nc\n')]);
  const l = state([file('A\nb\nc\n', 'f', 'executable')], [base]);
  const r = state([file('a\nb\nC\n')], [base]);
  const merged = source.compose(l, r, 'merge', at);
  assert.equal(text(merged.head), 'A\nb\nC\n');
  assert.equal(source.state(merged.head).files[0].mode, 'executable');
  assert.deepEqual(source.compose(merged.head, l, 'ff', at), { head: merged.head, conflicts: [] });
  assert.throws(
    () => source.compose(l, state([], [], 'unrelated'), 'merge', at),
    error => error.code === 'NATIVE_MERGE_BASE_UNKNOWN',
  );
});

test('three maximal bases fold in stable order without writing virtual States', t => {
  const { source, file, state } = fixture(t);
  const root = state([]);
  const bases = [0, 1, 2].map(i => state([file(`base ${i}`, `b${i}`)], [root]));
  const combined = bases.flatMap(id => source.state(id).files);
  const left = state([...combined, file('left', 'left')], bases);
  const right = state([...combined, file('right', 'right')], [...bases].reverse());
  const merged = source.compose(left, right, 'merge', at);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(
    source.state(merged.head).files.map(f => f.path),
    ['b0', 'b1', 'b2', 'left', 'right'],
  );
  assert.deepEqual(source.compose(left, right, 'merge', at), merged);
});

test('multi-base sync resumes a pinned plan after interruption and replays the identical head', async t => {
  const { source, file, state, text } = fixture(t);
  const initialized = initNative(source.owner);
  const agent = new AgentWorkflow(source.owner);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'synthetic sync' })).result;
  const root = initialized.head;
  const a = state([file('a', 'a')], [root]);
  const b = state([file('b', 'b')], [root]);
  const files = [file('a', 'a'), file('b', 'b')];
  const left = state([...files, file('lane')], [a, b]);
  const right = state([...files, file('main', 'main')], [b, a]);
  for (const f of source.state(left).files) writeFileSync(join(lane.path, f.path), source.object(f.blob));
  const store = agent.work.store;
  store.locked(() => {
    const tx = store.records();
    tx.patchFields('lanes', lane.laneId, { head: left });
    store.commitRecords(tx);
  });
  const command = { operationId: randomUUID(), laneId: lane.laneId, expectedHead: left, channel: 'main' };
  let planned;
  syncTestHooks.afterWorkspace = () => {
    throw new Error('synthetic interruption');
  };
  try {
    assert.throws(() => agentSync(store, command, { target: right }), /synthetic interruption/);
    // The operation's selected timestamp is used even though its publication failed.
    const { syncSelectionName, readSyncJournal, syncSelection } =
      await import('../dist/native-sync-journal.js');
    planned = readSyncJournal(lane.path, syncSelectionName(command.operationId), syncSelection);
  } finally {
    delete syncTestHooks.afterWorkspace;
  }
  const expected = source.compose(left, right, 'Sync main', planned.at).head;
  const synced = agentSync(store, command, { target: state([], [right], 'advanced target') }).result;
  assert.equal(synced.head, expected);
  assert.equal(synced.target, right);
  assert.equal(text(synced.head), 'lane');
  assert.equal(readFileSync(join(lane.path, 'main'), 'utf8'), 'main');
  assert.equal(agentSync(store, command, { target: right }).result.head, expected);
});

test('file/subtree virtual-base clashes cannot silently delete opposing head resolutions', t => {
  const { source, file, state } = fixture(t);
  const root = state([]);
  const a = state([file('file')], [root]);
  const b = state([file('child', 'f/child')], [root]);
  const left = state(source.state(a).files, [a, b]);
  const right = state(source.state(b).files, [b, a]);
  const merged = source.compose(left, right, 'merge', at);
  assert.equal(merged.head, undefined);
  assert.deepEqual(merged.conflicts, ['f', 'f/child']);
  assert.deepEqual(
    [...new Set(conflictPlan(source, left, right, 'main').conflicts.map(c => c.path))],
    ['f', 'f/child'],
  );
  assert.deepEqual(conflictPlan(source, left, right, 'main').files, source.state(left).files);
});

test('shared bases with independent roots use an empty virtual ancestor without fabricating source history', t => {
  const { source, file, state } = fixture(t);
  const a = state([file('a', 'a')], [], 'independent a');
  const b = state([file('b', 'b')], [], 'independent b');
  const files = [...source.state(a).files, ...source.state(b).files];
  const left = state([...files, file('left', 'left')], [a, b]);
  const right = state([...files, file('right', 'right')], [b, a]);
  const merged = source.compose(left, right, 'merge', at);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(
    source.state(merged.head).files.map(f => f.path),
    ['a', 'b', 'left', 'right'],
  );
  assert.deepEqual(source.state(a).parents, []);
  assert.deepEqual(source.state(b).parents, []);
});
