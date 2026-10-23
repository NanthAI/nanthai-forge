import { cleanupOwner } from './owner-cleanup.mjs';
import { trustAgents } from './autonomy-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { currentChannelHead } from '../dist/agent-defaults.js';
import { syncTestHooks } from '../dist/agent-sync.js';

const git = (root, args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
const lines = (n, edit = {}) =>
  Array.from({ length: n }, (_, i) => `${edit[i + 1] ?? `line ${i + 1}`}\n`).join('');

async function project(native = true, files = { 'a.txt': 'a\n', 'b.txt': 'b\n' }) {
  const root = mkdtempSync(join(tmpdir(), 'forge-agent-concurrency-'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  if (native) initNative(root);
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'initial']);
  }
  trustAgents(root);
  const agent = new AgentWorkflow(root);
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  const start = async outcome => (await agent.dispatch({ action: 'start', outcome })).result;
  return { root, agent, start, store: agent.work.store };
}
function edit(lane, path, text, native = true) {
  writeFileSync(join(lane.path, path), text);
  if (!native) git(lane.path, ['add', path]);
}
const mainHead = store => currentChannelHead(store, 'main');
function fileAt(root, head, path) {
  const source = new NativeSource(root),
    file = source.state(head).files.find(item => item.path === path);
  return file ? source.object(file.blob).toString('utf8') : undefined;
}
async function rejects(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test('concurrent finishes keep both accepted changes: B auto-syncs before accepting', async () => {
  const { root, agent, start, store } = await project();
  try {
    const a = await start('Edit a'),
      b = await start('Edit b');
    edit(a, 'a.txt', 'a from A\n');
    const first = (await agent.dispatch({ action: 'finish', laneId: a.laneId, message: 'A', accept: true }))
      .result;
    assert.equal(first.status, 'accepted');
    assert.equal(first.resolved.accept.expectedPrevious, null);
    const a1 = first.acceptance.head;
    edit(b, 'b.txt', 'b from B\n');
    const request = { action: 'finish', laneId: b.laneId, message: 'B', accept: { expectedPrevious: a1 } },
      second = (await agent.dispatch(request)).result;
    assert.equal(second.status, 'accepted', JSON.stringify(second));
    assert.equal(second.sync.status, 'merged');
    assert.deepEqual(second.sync.changedPaths, ['a.txt']);
    const head = mainHead(store);
    assert.equal(head, second.acceptance.head);
    assert.equal(fileAt(root, head, 'a.txt'), 'a from A\n');
    assert.equal(fileAt(root, head, 'b.txt'), 'b from B\n');
    assert.ok(new NativeSource(root).ancestors(head).has(a1));
    // The Lane workspace now matches its synced head.
    assert.equal(readFileSync(join(b.path, 'a.txt'), 'utf8'), 'a from A\n');
    // An identical retry with the resolved pins reconciles without new records.
    const before = store.load(),
      retry = (await agent.dispatch({ ...request, ...second.resolved })).result;
    const { resolved: _resolved, ...original } = second;
    assert.deepEqual(retry, original);
    const after = store.load();
    assert.equal(after.lanes.find(l => l.id === b.laneId).checkpoints.length, 2);
    assert.equal(after.runs.length, before.runs.length);
    assert.equal(after.channelMoves.length, before.channelMoves.length);
  } finally {
    await cleanupOwner(root);
  }
});

test('accepting a View that lacks the current Channel head is refused', async () => {
  const { root, agent, start, store } = await project();
  try {
    const a = await start('Edit a'),
      b = await start('Edit b');
    edit(a, 'a.txt', 'a from A\n');
    const a1 = (await agent.dispatch({ action: 'finish', laneId: a.laneId, message: 'A', accept: true }))
      .result.acceptance.head;
    edit(b, 'b.txt', 'b from B\n');
    const cp = (await agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'B' })).result;
    const view = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: b.intentId,
        inputs: [{ laneId: b.laneId, head: cp.head }],
      })
    ).result;
    await rejects(
      agent.dispatch({
        action: 'accept',
        operationId: randomUUID(),
        viewId: view.viewId,
        expectedHead: view.head,
        expectedPrevious: a1,
      }),
      'CHANNEL_DIVERGED',
    );
    await rejects(agent.dispatch({ action: 'accept', viewId: view.viewId }), 'CHANNEL_DIVERGED');
    assert.equal(mainHead(store), a1);
  } finally {
    await cleanupOwner(root);
  }
});

test('sync merges non-overlapping edits to the same file', async () => {
  const { root, agent, start, store } = await project(true, { 'f.txt': lines(10) });
  try {
    const a = await start('Top'),
      b = await start('Bottom');
    edit(a, 'f.txt', lines(10, { 1: 'top from A' }));
    const a1 = (await agent.dispatch({ action: 'finish', laneId: a.laneId, message: 'A', accept: true }))
      .result.acceptance.head;
    edit(b, 'f.txt', lines(10, { 10: 'bottom from B' }));
    const cp = (await agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'B' })).result;
    const synced = (await agent.dispatch({ action: 'sync', laneId: b.laneId })).result;
    assert.equal(synced.status, 'merged');
    assert.equal(synced.target, a1);
    const expected = lines(10, { 1: 'top from A', 10: 'bottom from B' });
    assert.equal(readFileSync(join(b.path, 'f.txt'), 'utf8'), expected);
    const source = new NativeSource(root);
    assert.deepEqual(source.state(synced.head).parents, [cp.head, a1]);
    assert.equal(
      source.tree(source.capture(b.path, false, synced.head)),
      source.tree(source.state(synced.head).files),
    );
    const lane = store.load().lanes.find(l => l.id === b.laneId);
    assert.equal(lane.head, synced.head);
    assert.equal(lane.checkpoints.at(-1).message, 'Sync main');
    // Retrying the same sync operation replays it.
    const replay = (await agent.dispatch({ action: 'sync', laneId: b.laneId, ...synced.resolved })).result;
    assert.equal(replay.head, synced.head);
    assert.equal(store.load().lanes.find(l => l.id === b.laneId).checkpoints.length, 2);
    const done = (await agent.dispatch({ action: 'sync', laneId: b.laneId })).result;
    assert.equal(done.status, 'up-to-date');
  } finally {
    await cleanupOwner(root);
  }
});

test('overlapping edits stop finish at sync with markers until resolved', async () => {
  const { root, agent, start, store } = await project(true, { 'f.txt': lines(10) });
  try {
    const a = await start('A'),
      b = await start('B');
    edit(a, 'f.txt', lines(10, { 5: 'five from A' }));
    const a1 = (await agent.dispatch({ action: 'finish', laneId: a.laneId, message: 'A', accept: true }))
      .result.acceptance.head;
    edit(b, 'f.txt', lines(10, { 5: 'five from B' }));
    const request = { action: 'finish', laneId: b.laneId, message: 'B', accept: true },
      stopped = (await agent.dispatch(request)).result;
    assert.equal(stopped.complete, false);
    assert.equal(stopped.phase, 'sync');
    assert.equal(stopped.status, 'conflict');
    assert.deepEqual(stopped.conflicts, [{ path: 'f.txt', kind: 'text' }]);
    assert.equal(stopped.acceptance, null);
    const text = readFileSync(join(b.path, 'f.txt'), 'utf8');
    assert.equal(
      text,
      `${lines(4)}<<<<<<< lane\nfive from B\n=======\nfive from A\n>>>>>>> main\n${lines(10).split('\n').slice(5).join('\n')}`,
    );
    assert.equal(mainHead(store), a1);
    // Identical retry reports the same conflict without new records.
    const again = (await agent.dispatch({ ...request, ...stopped.resolved })).result;
    assert.deepEqual(again.conflicts, stopped.conflicts);
    assert.equal(store.load().runs.length, 1);
    await rejects(
      agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'Resolve' }),
      'CONFLICT_MARKERS',
    );
    await rejects(agent.dispatch({ action: 'sync', laneId: b.laneId }), 'MERGE_PENDING');
    edit(b, 'f.txt', lines(10, { 5: 'five from A and B' }));
    const done = (
      await agent.dispatch({ action: 'finish', laneId: b.laneId, message: 'Resolve', accept: true })
    ).result;
    assert.equal(done.status, 'accepted', JSON.stringify(done));
    const head = mainHead(store),
      source = new NativeSource(root);
    assert.ok(source.ancestors(head).has(a1));
    assert.equal(source.state(done.checkpoint.head).parents[1], a1);
    assert.equal(fileAt(root, head, 'f.txt'), lines(10, { 5: 'five from A and B' }));
    assert.equal(store.load().lanes.find(l => l.id === b.laneId).pendingMerge, undefined);
  } finally {
    await cleanupOwner(root);
  }
});

test('Git-backed acceptance of a divergent View is refused', async () => {
  const { root, agent, start } = await project(false);
  try {
    const a = await start('Edit a'),
      b = await start('Edit b');
    edit(a, 'a.txt', 'a from A\n', false);
    const a1 = (await agent.dispatch({ action: 'finish', laneId: a.laneId, message: 'A', accept: true }))
      .result.acceptance.head;
    edit(b, 'b.txt', 'b from B\n', false);
    const cp = (await agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'B' })).result;
    const view = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: b.intentId,
        inputs: [{ laneId: b.laneId, head: cp.head }],
      })
    ).result;
    await rejects(
      agent.dispatch({ action: 'accept', viewId: view.viewId, expectedPrevious: a1 }),
      'CHANNEL_DIVERGED',
    );
    edit(b, 'b.txt', 'b again\n', false);
    const accepted = (
      await agent.dispatch({ action: 'finish', laneId: b.laneId, message: 'B2', accept: true })
    ).result;
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.sync.status, 'merged');
    assert.equal(git(root, ['show', `${accepted.acceptance.head}:a.txt`]), 'a from A');
    assert.equal(git(root, ['show', `${accepted.acceptance.head}:b.txt`]), 'b again');
    assert.equal((await agent.dispatch({ action: 'sync', laneId: b.laneId })).result.status, 'up-to-date');
  } finally {
    await cleanupOwner(root);
  }
});

test('short-form finish resolves pins; retry with them reconciles without rerunning', async () => {
  const { root, agent, start, store } = await project();
  try {
    const lane = await start('Short form');
    edit(lane, 'a.txt', 'short\n');
    const request = { action: 'finish', laneId: lane.laneId, message: 'Short', accept: true },
      receipt = (await agent.dispatch(request)).result;
    assert.equal(receipt.status, 'accepted');
    const check = store.load().checks[0];
    assert.deepEqual(Object.keys(receipt.resolved).sort(), [
      'accept',
      'checkId',
      'expectedDefinition',
      'expectedHead',
      'operationId',
    ]);
    assert.equal(receipt.resolved.checkId, check.id);
    assert.equal(receipt.resolved.expectedDefinition, check.definition);
    assert.equal(receipt.resolved.expectedHead, lane.head);
    assert.deepEqual(receipt.resolved.accept, { channel: 'main', expectedPrevious: null });
    const runs = store.load().runs.length,
      retry = (await agent.dispatch({ ...request, ...receipt.resolved })).result;
    const { resolved: _resolved, ...original } = receipt;
    assert.deepEqual(retry, original);
    assert.equal(store.load().runs.length, runs);
    // A second check makes the default ambiguous unless one is named verify.
    await agent.dispatch({
      action: 'define-check',
      name: 'other',
      executable: process.execPath,
      args: ['-e', '0'],
    });
    edit(lane, 'a.txt', 'short again\n');
    const next = (await agent.dispatch({ action: 'finish', laneId: lane.laneId, message: 'Again' })).result;
    assert.equal(next.run.checkId, check.id);
  } finally {
    await cleanupOwner(root);
  }
});

test('sync reports up-to-date and refuses uncheckpointed edits', async () => {
  const { root, agent, start } = await project();
  try {
    const first = await start('Before any acceptance');
    await rejects(agent.dispatch({ action: 'sync', laneId: first.laneId }), 'NOT_FOUND');
    const a = await start('A2');
    edit(a, 'a.txt', 'a from A\n');
    await agent.dispatch({ action: 'finish', laneId: a.laneId, message: 'A', accept: true });
    const c = await start('C');
    assert.equal((await agent.dispatch({ action: 'sync', laneId: c.laneId })).result.status, 'up-to-date');
    const d = await start('D');
    edit(c, 'b.txt', 'c\n');
    await agent.dispatch({ action: 'finish', laneId: c.laneId, message: 'C', accept: true });
    edit(d, 'b.txt', 'uncheckpointed\n');
    await rejects(agent.dispatch({ action: 'sync', laneId: d.laneId }), 'LANE_DIRTY');
    assert.equal(readFileSync(join(d.path, 'b.txt'), 'utf8'), 'uncheckpointed\n');
  } finally {
    await cleanupOwner(root);
  }
});

test('CLI infers laneId from a Lane working directory and shows short forms', async () => {
  const { root, start } = await project();
  try {
    const lane = await start('CLI'),
      cli = new URL('../dist/cli.js', import.meta.url).pathname;
    writeFileSync(join(lane.path, 'a.txt'), 'cli\n');
    const output = execFileSync(
      process.execPath,
      [cli, 'agent', root, 'finish', '{"message":"From cwd","accept":true}'],
      { cwd: lane.path, encoding: 'utf8' },
    );
    const receipt = JSON.parse(output).result;
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.checkpoint.laneId, lane.laneId);
    const help = execFileSync(process.execPath, [cli, 'agent', root, 'finish', '--help'], {
      encoding: 'utf8',
    });
    assert.match(help, /"accept":true/);
    assert.match(execFileSync(process.execPath, [cli, 'agent', '--help'], { encoding: 'utf8' }), /sync/);
  } finally {
    await cleanupOwner(root);
  }
});

// Crash points: sync writes Lane files first and records metadata second.
async function diverged(files, editA, editB) {
  const p = await project(true, files),
    a = await p.start('A'),
    b = await p.start('B');
  for (const [path, text] of Object.entries(editA)) edit(a, path, text);
  const a1 = (await p.agent.dispatch({ action: 'finish', laneId: a.laneId, message: 'A', accept: true }))
    .result.acceptance.head;
  for (const [path, text] of Object.entries(editB)) edit(b, path, text);
  const cp = (await p.agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'B' })).result;
  return { ...p, b, a1, cp };
}
async function crash(agent, hook, request) {
  syncTestHooks[hook] = () => {
    throw new Error(`crash ${hook}`);
  };
  try {
    await assert.rejects(agent.dispatch(request), new RegExp(`crash ${hook}`));
  } finally {
    delete syncTestHooks[hook];
  }
}
const laneOf = (store, id) => store.load().lanes.find(l => l.id === id);

test('sync crash before or after writing files never records a head the workspace lacks', async () => {
  for (const hook of ['beforeWorkspace', 'afterWorkspace']) {
    const { root, agent, store, b, a1, cp } = await diverged(
      { 'f.txt': lines(10) },
      { 'f.txt': lines(10, { 1: 'top from A' }) },
      { 'f.txt': lines(10, { 10: 'bottom from B' }) },
    );
    try {
      const request = { action: 'sync', operationId: randomUUID(), laneId: b.laneId, expectedHead: cp.head };
      await crash(agent, hook, request);
      assert.equal(laneOf(store, b.laneId).head, cp.head);
      assert.equal(
        readFileSync(join(b.path, 'f.txt'), 'utf8'),
        hook === 'beforeWorkspace'
          ? lines(10, { 10: 'bottom from B' })
          : lines(10, { 1: 'top from A', 10: 'bottom from B' }),
      );
      // Retrying the same operation completes it instead of reporting LANE_DIRTY.
      const synced = (await agent.dispatch(request)).result;
      assert.equal(synced.status, 'merged');
      assert.equal(laneOf(store, b.laneId).head, synced.head);
      assert.deepEqual(new NativeSource(root).state(synced.head).parents, [cp.head, a1]);
      assert.equal(
        readFileSync(join(b.path, 'f.txt'), 'utf8'),
        lines(10, { 1: 'top from A', 10: 'bottom from B' }),
      );
      assert.equal((await agent.dispatch(request)).result.head, synced.head);
    } finally {
      await cleanupOwner(root);
    }
  }
});

test('after a sync crash an ordinary finish still keeps main changes', async () => {
  const { root, agent, store, b } = await diverged(
    { 'f.txt': lines(10) },
    { 'f.txt': lines(10, { 1: 'top from A' }) },
    { 'f.txt': lines(10, { 10: 'bottom from B' }) },
  );
  try {
    await crash(agent, 'afterWorkspace', { action: 'sync', laneId: b.laneId });
    edit(b, 'g.txt', 'more B work\n');
    const done = (await agent.dispatch({ action: 'finish', laneId: b.laneId, message: 'B2', accept: true }))
      .result;
    assert.equal(done.status, 'accepted', JSON.stringify(done));
    assert.equal(done.sync.status, 'merged');
    const head = mainHead(store);
    assert.equal(fileAt(root, head, 'f.txt'), lines(10, { 1: 'top from A', 10: 'bottom from B' }));
    assert.equal(fileAt(root, head, 'g.txt'), 'more B work\n');
  } finally {
    await cleanupOwner(root);
  }
});

test('a partly written sync resumes; unrelated edits are still LANE_DIRTY', async () => {
  const { root, agent, store, b } = await diverged(
    { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' },
    { 'a.txt': 'a from A\n', 'b.txt': 'b from A\n' },
    { 'c.txt': 'c from B\n' },
  );
  try {
    edit(b, 'a.txt', 'a from A\n'); // As if the crash hit after the first file.
    const synced = (await agent.dispatch({ action: 'sync', laneId: b.laneId })).result;
    assert.equal(synced.status, 'merged');
    assert.equal(readFileSync(join(b.path, 'b.txt'), 'utf8'), 'b from A\n');
    assert.equal(laneOf(store, b.laneId).head, synced.head);
  } finally {
    await cleanupOwner(root);
  }
  const other = await diverged(
    { 'a.txt': 'a\n', 'c.txt': 'c\n' },
    { 'a.txt': 'a from A\n' },
    { 'c.txt': 'c from B\n' },
  );
  try {
    edit(other.b, 'a.txt', 'someone else\n');
    await rejects(other.agent.dispatch({ action: 'sync', laneId: other.b.laneId }), 'LANE_DIRTY');
  } finally {
    await cleanupOwner(other.root);
  }
});

test('conflicted sync crash records the pending merge only after markers exist', async () => {
  const { root, agent, store, b, a1 } = await diverged(
    { 'f.txt': lines(10) },
    { 'f.txt': lines(10, { 5: 'five from A' }) },
    { 'f.txt': lines(10, { 5: 'five from B' }) },
  );
  try {
    const request = { action: 'sync', operationId: randomUUID(), laneId: b.laneId };
    await crash(agent, 'beforeWorkspace', request);
    assert.equal(laneOf(store, b.laneId).pendingMerge, undefined);
    assert.equal(readFileSync(join(b.path, 'f.txt'), 'utf8'), lines(10, { 5: 'five from B' }));
    await crash(agent, 'afterWorkspace', request);
    assert.equal(laneOf(store, b.laneId).pendingMerge, undefined);
    assert.match(readFileSync(join(b.path, 'f.txt'), 'utf8'), /^<<<<<<< lane$/m);
    const result = (await agent.dispatch(request)).result;
    assert.equal(result.status, 'conflict');
    assert.equal(laneOf(store, b.laneId).pendingMerge.parent, a1);
    await rejects(
      agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'x' }),
      'CONFLICT_MARKERS',
    );
  } finally {
    await cleanupOwner(root);
  }
});

test('Git guard still applies when the previous acceptance is recorded but pending', async () => {
  const { root, agent, start, store } = await project(false);
  try {
    const a = await start('Edit a'),
      b = await start('Edit b');
    edit(a, 'a.txt', 'a from A\n', false);
    const a1 = (await agent.dispatch({ action: 'finish', laneId: a.laneId, message: 'A', accept: true }))
      .result.acceptance.head;
    store.locked(() => {
      const data = store.load();
      data.channelMoves.at(-1).status = 'pending'; // Crash after the receipt ref, before final metadata.
      store.save(data);
    });
    edit(b, 'b.txt', 'b from B\n', false);
    const cp = (await agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'B' })).result;
    const view = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: b.intentId,
        inputs: [{ laneId: b.laneId, head: cp.head }],
      })
    ).result;
    await rejects(
      agent.dispatch({ action: 'accept', viewId: view.viewId, expectedPrevious: a1 }),
      'CHANNEL_DIVERGED',
    );
    assert.equal(git(root, ['rev-parse', 'refs/forge/channels/main']), a1);
  } finally {
    await cleanupOwner(root);
  }
});

test('finish reuses the Lane head when nothing changed since sync', async () => {
  const { root, agent, store, b } = await diverged(
    { 'a.txt': 'a\n', 'b.txt': 'b\n' },
    { 'a.txt': 'a from A\n' },
    { 'b.txt': 'b from B\n' },
  );
  try {
    const synced = (await agent.dispatch({ action: 'sync', laneId: b.laneId })).result;
    const request = { action: 'finish', laneId: b.laneId, message: 'B', accept: true },
      done = (await agent.dispatch(request)).result;
    assert.equal(done.status, 'accepted', JSON.stringify(done));
    assert.equal(done.checkpoint.head, synced.head);
    assert.equal(done.acceptance.head, synced.head);
    assert.equal(laneOf(store, b.laneId).head, synced.head);
    const runs = store.load().runs.length,
      { resolved: _resolved, ...original } = done;
    assert.deepEqual((await agent.dispatch({ ...request, ...done.resolved })).result, original);
    assert.equal(store.load().runs.length, runs);
    assert.equal(
      (await agent.dispatch({ action: 'checkpoint', laneId: b.laneId, message: 'Nothing' })).result.head,
      synced.head,
    );
  } finally {
    await cleanupOwner(root);
  }
});
