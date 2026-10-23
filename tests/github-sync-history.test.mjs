// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { workGit } from '../dist/work-git.js';
import { githubHistoryContainment } from '../dist/github-sync-history.js';
import { fixture } from './helpers.mjs';

const at = n => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
function historyFixture(
  t,
  { old = 'old\n', historical = 'external\n', mode = 'file', path = 'sample.txt' } = {},
) {
  const root = fixture(t),
    source = new NativeSource(root),
    store = new WorkStore(root);
  const state = (text, parents, n, fileMode = 'file') =>
    source.writeState(
      text == null ? [] : [{ path, mode: fileMode, blob: source.put(Buffer.from(text)) }],
      parents,
      `Synthetic state ${n}`,
      at(n),
    );
  const origin = state(old, [], 0),
    base = state('base\n', [origin], 1),
    saved = state(historical, [base], 2, mode),
    current = state('later Forge version\n', [saved], 3),
    intentId = randomUUID(),
    laneId = randomUUID(),
    viewId = randomUUID();
  const move = (head, n, previous = base) => ({
    id: randomUUID(),
    channel: 'main',
    status: 'accepted',
    head,
    previous,
    viewId: randomUUID(),
    at: at(n),
    provenance: 'user-declared-local',
  });
  const baselineMove = move(base, 1, origin),
    latestMove = { ...move(current, 4), viewId },
    baseline = { state: base, acceptanceId: baselineMove.id },
    latest = { state: current, acceptanceId: latestMove.id };
  const data = store.load();
  data.channelMoves = [baselineMove, latestMove];
  data.views = [
    {
      id: viewId,
      intentId,
      base,
      head: current,
      status: 'clean',
      details: '',
      at: at(4),
      inputs: [{ laneId, head: current }],
    },
  ];
  data.lanes = [
    {
      id: laneId,
      intentId,
      name: 'Accepted synthetic Lane',
      base,
      head: current,
      assignment: '',
      target: '',
      state: 'completed',
      checkpoints: [
        { head: saved, parent: base, message: 'Original external version', at: at(2) },
        { head: current, parent: saved, message: 'Later fix', at: at(3) },
      ],
    },
  ];
  const target = (text = historical, fileMode = mode) => ({
    path,
    entry:
      text == null
        ? undefined
        : {
            mode: fileMode === 'symlink' ? '120000' : fileMode === 'executable' ? '100755' : '100644',
            object: workGit(root, ['hash-object', '-w', '--stdin'], Buffer.from(text)).trim(),
          },
  });
  const run = (targets = [target()], { paged = true, excludePrivate = false } = {}) => {
    store.save(data);
    const records = paged ? store.readRecords() : undefined;
    if (paged) assert.ok(records);
    return githubHistoryContainment(
      root,
      source,
      { data, records },
      baseline,
      latest,
      targets,
      excludePrivate,
    );
  };
  return {
    root,
    source,
    data,
    state,
    move,
    origin,
    base,
    saved,
    current,
    laneId,
    viewId,
    baselineMove,
    latestMove,
    target,
    run,
  };
}

test('historical main evidence is read across acceptance pages and pins its exact State', t => {
  const f = historyFixture(t),
    accepted = f.move(f.saved, 2);
  f.data.channelMoves.splice(
    1,
    0,
    accepted,
    ...Array.from({ length: 55 }, () => ({ ...f.move(f.current, 3), status: 'pending' })),
  );
  // No accepted Lane checkpoint may provide the proof in this case.
  f.data.views[0].inputs = [];
  for (const paged of [false, true]) {
    assert.deepEqual(f.run(undefined, { paged }), [
      {
        kind: 'accepted-main',
        path: 'sample.txt',
        state: f.saved,
        acceptanceId: accepted.id,
        viewId: accepted.viewId,
      },
    ]);
  }
});

test('an accepted Lane checkpoint proves a superseded add/add version with exact provenance', t => {
  const f = historyFixture(t);
  assert.deepEqual(f.run(), [
    {
      kind: 'accepted-lane-checkpoint',
      path: 'sample.txt',
      state: f.saved,
      acceptanceId: f.latestMove.id,
      viewId: f.viewId,
      laneId: f.laneId,
      checkpoint: 0,
    },
  ]);
});

test('a recorded version must match both binary bytes and mode', t => {
  const binary = Buffer.from([0, 255, 4, 0]),
    f = historyFixture(t, { historical: binary, mode: 'executable' });
  assert.equal(f.run().length, 1);
  assert.deepEqual(f.run([f.target(binary, 'file')]), []);
  assert.deepEqual(f.run([f.target(Buffer.from([0, 255, 4, 1]), 'executable')]), []);
});

test('exact recorded absence can prove a later reintroduced path', t => {
  const f = historyFixture(t, { historical: null });
  assert.equal(f.run()[0].state, f.saved);
});

test('unaccepted matching Lane saves and orphan source objects cannot prove containment', t => {
  const f = historyFixture(t);
  f.data.views[0].inputs = [];
  assert.deepEqual(f.run(), []);
});

test('later saves of an accepted Lane must also belong to its accepted input ancestry', t => {
  const f = historyFixture(t),
    unaccepted = f.state('never accepted\n', [f.current], 5);
  f.data.lanes[0].head = unaccepted;
  f.data.lanes[0].checkpoints.push({
    head: unaccepted,
    parent: f.current,
    message: 'Unaccepted later save',
    at: at(5),
  });
  assert.deepEqual(f.run([f.target('never accepted\n')]), []);
});

test('versions before the mapped GitHub base are excluded without traversing old source history', t => {
  const f = historyFixture(t, { old: 'external\n', historical: 'different\n' });
  f.data.channelMoves.unshift(f.move(f.origin, 0, null));
  const read = f.source.state.bind(f.source);
  f.source.state = id => {
    assert.notEqual(id, f.origin, 'must stop at the mapped native base');
    return read(id);
  };
  assert.deepEqual(f.run([f.target('external\n')]), []);
});

test('matching checkpoints dated before the recorded base cannot satisfy the fallback', t => {
  const f = historyFixture(t);
  f.data.lanes[0].checkpoints[0].at = at(0);
  assert.deepEqual(f.run(), []);
});

test('automatic history matching uses the same private-path projection as the export', t => {
  const f = historyFixture(t, { path: '.env.local', historical: 'synthetic fixture only\n' });
  assert.equal(f.run().length, 1);
  assert.deepEqual(f.run(undefined, { excludePrivate: true }), []);
});

test('gitlinks retain their path refusal without being read as historical file blobs', t => {
  const f = historyFixture(t),
    tree = workGit(f.root, ['mktree'], '').trim(),
    commit = workGit(f.root, ['commit-tree', tree, '-m', 'Synthetic submodule commit']).trim();
  assert.deepEqual(f.run([{ path: 'sample.txt', entry: { mode: '160000', object: commit } }]), []);
});
