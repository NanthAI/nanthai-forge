// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSourceStep, runSourceStep, enqueueSourceObject } from '../dist/hosted-source-step.js';
import { runSourceTask, applySourceFanout } from '../dist/hosted-source-fanout.js';
import { saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
const at = '2026-01-01T00:00:00.000Z';
/** The Convex step's shape: fan-out is available, and an upload gets its object row (so
 * describe and read can find it) only when the step or task that made it commits. */
function committedFixture() {
  const committed = new Map(),
    staged = new Map(),
    describes = [];
  let plan = null;
  const put = b => {
    b = Buffer.from(b);
    const p = { sha256: digest(b), size: b.length };
    committed.set(p.sha256, b);
    return p;
  };
  const json = v => put(saveBytes(v));
  const absent = id =>
    Object.assign(new Error(`Exact source object is absent: ${id}`), {
      name: 'ForgeError',
      code: 'SOURCE_UNAVAILABLE',
    });
  const io = {
    async describeBatch(ids) {
      describes.push(ids);
      assert(ids.length <= 100);
      return ids.map(id => {
        const b = committed.get(id);
        if (!b) throw absent(id);
        return { object: { sha256: id, size: b.length }, recipe: null };
      });
    },
    async read(p) {
      const b = committed.get(p.sha256);
      if (!b) throw absent(p.sha256);
      return (async function* () {
        yield b;
      })();
    },
    async upload(p, stream) {
      const parts = [];
      for await (const c of stream) parts.push(c);
      const b = Buffer.concat(parts);
      assert.equal(digest(b), p.sha256);
      staged.set(p.sha256, b);
    },
    fanout(value) {
      plan = value;
    },
  };
  const commit = () => {
    for (const [id, b] of staged) committed.set(id, b);
    staged.clear();
  };
  const take = () => {
    const value = plan;
    plan = null;
    return value;
  };
  const state = (files, parents = []) =>
    json({ schema: 1, kind: 'forge-source-state', parents, files, message: 'seed', at });
  return { committed, staged, describes, put, json, state, io, commit, take };
}
/** Steps, task fan-outs and joins as the Convex provider runs them; each commits its uploads. */
async function drainCommitted(x, input) {
  let c = initialSourceStep(input),
    steps = 0,
    fanouts = 0;
  while (c.phase !== 'done') {
    assert(++steps < 50, 'finite continuations');
    const before = structuredClone(c),
      result = await runSourceStep(c, x.io);
    // A lost step reply replays the same progress; its uploads are discarded with it.
    x.staged.clear();
    x.take();
    const replay = await runSourceStep(before, x.io);
    assert.deepEqual(replay.cursor, result.cursor, 'lost step reply replays exact progress');
    x.commit();
    c = JSON.parse(JSON.stringify(result.cursor));
    const plan = x.take();
    if (!plan) continue;
    fanouts++;
    const results = [];
    for (const task of plan.tasks) {
      let previous = null,
        done;
      do {
        done = await runSourceTask(task, previous, x.io);
        previous = done.progress;
      } while (!done.done);
      x.commit();
      results.push(done.progress);
    }
    applySourceFanout(c, plan, results, ref => enqueueSourceObject(c, ref));
  }
  return { cursor: c, steps, fanouts };
}
const lines = edits => {
  const out = Array.from({ length: 24 }, (_, i) => `line ${i}`);
  for (const [i, v] of Object.entries(edits)) out[i] = v;
  return out.join('\n') + '\n';
};
// root -> A and B; left = merge(A, B) + an edit and right = merge(B, A) + another edit, so the
// sync first merges the two merge bases into a virtual base and then uses that blob as the base.
// Depth 2 stacks two criss-crosses, so the virtual base itself has two merge bases.
for (const depth of [1, 2])
  test(`criss-cross sync (recursion depth ${depth}) completes inline with exact bytes`, async t => {
    const x = committedFixture(),
      file = edits => ({ path: 'f', mode: 'file', blob: x.put(lines(edits)).sha256 });
    const root = x.state([file({})]);
    let a = x.state([file({ 0: 'side a' })], [root.sha256]),
      b = x.state([file({ 3: 'side b' })], [root.sha256]),
      edits = { 0: 'side a', 3: 'side b' };
    // Each level merges the pair below both ways and edits a different line on each side.
    for (let level = 1; level <= depth; level++) {
      const left = { ...edits, [level * 6]: `left ${level}` },
        right = { ...edits, [level * 6 + 3]: `right ${level}` };
      [a, b] = [x.state([file(left)], [a.sha256, b.sha256]), x.state([file(right)], [b.sha256, a.sha256])];
      edits = { ...left, ...right };
    }
    const input = x.json({
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work: { mode: 'sync', left: { object: a, recipe: null }, right: { object: b, recipe: null } },
      message: 'merge',
      at,
    });
    const actual = await drainCommitted(x, input);
    // Small calculations run inline: no fan-out round; a round that reads a virtual-base blob
    // this action created yields to one fresh step, once per recursion level.
    assert.equal(actual.fanouts, 0);
    assert.equal(actual.steps, depth + 1);
    const expected = await buildHostedSourceState(input, x.io);
    assert.equal(actual.cursor.head, expected.head);
    assert.deepEqual(actual.cursor.output, expected.output);
    const result = JSON.parse(x.committed.get(actual.cursor.output.sha256)).result;
    assert.equal(result.status, 'merged');
    t.diagnostic(JSON.stringify({ depth, steps: actual.steps, describes: x.describes.length }));
  });
