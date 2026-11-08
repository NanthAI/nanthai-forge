// SPDX-License-Identifier: Apache-2.0
// Incident replay, Issue 3439ae76 (batch 2d82c075, 2026-11-08): a shared check passed late, after
// main moved six times, so the 4-member cohort recomposed on the new main. That compose merged its
// first member, yielded at the 2 MiB compute budget, and saved `batchMerged` in its cursor. The
// strict cursor schema did not know the field, so the next step failed with SOURCE_JOB_INVALID;
// the cohort split, both halves failed the same way, and every member rechecked alone.
// Composition runs before any check, so this holds for every CI adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initialSourceStep, runSourceStep, enqueueSourceObject } from '../dist/hosted-source-step.js';
import { runSourceTask, applySourceFanout } from '../dist/hosted-source-fanout.js';
import { loadSourceProgress, saveSourceProgress } from '../dist/hosted-source-step-progress.js';
import { parseSourceCursor } from '../dist/hosted-source-cursor-schema.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';

const at = '2026-01-01T00:00:00.000Z';
function fixture() {
  const committed = new Map(),
    staged = new Map();
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
  return { committed, put, json, io, commit, take };
}

/** The incident shape: ~500 KB State manifests, main moved under the cohort, members disjoint. */
function incident(memberCount = 4) {
  const x = fixture();
  const blob = x.put('same bytes\n').sha256;
  const tree = Array.from({ length: 4500 }, (_, i) => ({
    path: `packages/area-${i % 40}/src/module-${String(i).padStart(5, '0')}-with-a-long-name.ts`,
    mode: 'file',
    blob,
  }));
  const state = (extra, parents) =>
    x.json({
      schema: 1,
      kind: 'forge-source-state',
      parents,
      files: [...tree, ...extra].sort((a, b) => (a.path < b.path ? -1 : 1)),
      message: 'seed',
      at,
    });
  const file = (path, text) => ({ path, mode: 'file', blob: x.put(text).sha256 });
  const root = state([], []);
  const main = state([file('main-moved.txt', 'main\n')], [root.sha256]);
  const members = Array.from({ length: memberCount }, (_, i) => {
    const head = state([file(`member-${i}.txt`, `member ${i}\n`)], [root.sha256]);
    return { candidateId: randomUUID(), head: head.sha256, state: { object: head, recipe: null } };
  });
  const dependencies = buildComposePages(members),
    inputs = buildComposePages([]);
  for (const page of [...dependencies.pages, ...inputs.pages]) x.json(page.value);
  const input = x.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    batch: { members: members.map(m => m.candidateId) },
    base: { head: main.sha256, receiptId: randomUUID() },
    main: { object: main, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'Compose concurrent hosted landings',
    at,
  });
  return { x, members, input };
}

/** Each step resumes from the durable progress the Convex source step saves and loads. */
async function drainDurable(x, input) {
  const store = new Map();
  const durable = {
    store: async bytes => {
      const id = `p${store.size}`;
      store.set(id, Buffer.from(bytes));
      return id;
    },
    read: async id => store.get(id),
  };
  let c = initialSourceStep(input),
    progress = null,
    steps = 0;
  const resumedMidBatch = [];
  while (c.phase !== 'done') {
    assert(++steps < 80, 'finite continuations');
    const result = await runSourceStep(c, x.io);
    x.commit();
    const saved = await saveSourceProgress(result.cursor, progress, durable.store);
    const loaded = await loadSourceProgress(await durable.read(saved.id), durable.read);
    progress = loaded.value;
    c = loaded.cursor;
    if (c.phase === 'compute' && c.batchMerged?.length) resumedMidBatch.push(c.batchMerged.length);
    const plan = x.take();
    if (!plan) continue;
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
  return { cursor: c, resumedMidBatch };
}

test('incident replay: a batch compose that yields mid-merge resumes and accounts every member', async () => {
  const { x, members, input } = incident();
  const { cursor, resumedMidBatch } = await drainDurable(x, input);
  assert(resumedMidBatch.length > 0, 'the compose yielded after merging a member, like batch 2d82c075');
  const output = JSON.parse(x.committed.get(cursor.output.sha256));
  assert.equal(output.result.status, 'clean');
  assert.deepEqual(output.dropped, []);
  assert.deepEqual(
    cursor.batchMerged,
    members.map(m => m.candidateId),
  );
  const files = JSON.parse(x.committed.get(output.result.state.sha256)).files.map(f => f.path);
  for (const path of ['main-moved.txt', ...members.map((_, i) => `member-${i}.txt`)])
    assert(files.includes(path), path);
});

test('the durable cursor keeps member accounting and still refuses unknown fields', () => {
  const base = initialSourceStep({ sha256: 'a'.repeat(64), size: 1 });
  const merged = [randomUUID(), randomUUID()];
  assert.deepEqual(parseSourceCursor({ ...base, batchMerged: merged }).batchMerged, merged);
  assert.throws(() => parseSourceCursor({ ...base, batchMerged: ['not-a-candidate'] }), {
    code: 'SOURCE_JOB_INVALID',
  });
  assert.throws(() => parseSourceCursor({ ...base, unknownField: true }), { code: 'SOURCE_JOB_INVALID' });
});
