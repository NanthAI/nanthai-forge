// SPDX-License-Identifier: Apache-2.0
// Issue 1eef1b43 (follow-up to the resolve fix): a stacked sync passed [left, right, stackBase] as
// its ancestry roots. The stack base is an ancestor of both tips and its merge base is explicit, so
// the generation walk saw a subset-common State and gave up for a breadth-first search that reads
// the States below the stack base (saved before parents were recorded) one level per round.
// Synthetic fixtures only; the history models a stack parent that branched from an old main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { digest } from '../dist/hash.js';
import { parseNativeState } from '../dist/state/format.js';

const ref = object => ({ object, recipe: null });
async function history(s, v = {}) {
  const generations = new Map(),
    old = new Set();
  // `recorded: false` is a row written before the worker recorded parents (it keeps its generation).
  // `below` marks a State under the stack base: no stacked sync needs to read it.
  const state = async (files, parents, { recorded = true, below = false, bare = false } = {}) => {
    const generation = 1 + Math.max(0, ...parents.map(id => generations.get(id)));
    const pin = await s.putSpec(
      Buffer.from(saveBytes({ schema: 1, kind: 'forge-source-state', parents, files, message: 'm', at })),
      undefined,
      bare ? undefined : generation,
      recorded ? { parents } : {},
    );
    generations.set(pin.sha256, generation);
    if (below) old.add(pin.sha256);
    return pin;
  };
  const blob = async text => (await s.putSpec(Buffer.from(text))).sha256;
  const edit = async (files, path, text) => {
    const next = files.filter(file => file.path !== path);
    next.push({ path, mode: 'file', blob: await blob(text) });
    return next.sort((a, b) => (a.path < b.path ? -1 : 1));
  };
  let files = [];
  for (let i = 0; i < 40; i++) files = await edit(files, `dir${i % 4}/f${i}.txt`, `base ${i}\n`);
  // Old main, saved before parents were recorded.
  let main = await state(files, [], { recorded: false, below: true, bare: v.bare });
  for (let i = 0; i < 12; i++) {
    files = await edit(files, `dir${i % 4}/f${i}.txt`, `old main ${i}\n`);
    main = await state(files, [main.sha256], { recorded: false, below: true, bare: v.bare });
  }
  // The stack parent Lane branches from that main; its first save is the stack base.
  let parentFiles = await edit(files, 'parent/base.txt', 'p0\n');
  const stackBase = await state(parentFiles, [main.sha256], { recorded: false });
  // The child Lane stacks on it and takes several saves; the parent also moves on.
  let childFiles = parentFiles,
    child = stackBase;
  for (let i = 0; i < 6; i++) {
    childFiles = await edit(childFiles, `child/c${i}.txt`, `child ${i}\n`);
    if (v.conflict && i === 5) childFiles = await edit(childFiles, 'parent/base.txt', 'child edit\n');
    child = await state(childFiles, [child.sha256], { recorded: false });
  }
  let parent = stackBase;
  for (let i = 0; i < 6; i++) {
    parentFiles = await edit(parentFiles, `parent/p${i}.txt`, `parent ${i}\n`);
    if (v.conflict && i === 5) parentFiles = await edit(parentFiles, 'parent/base.txt', 'parent edit\n');
    parent = await state(parentFiles, [parent.sha256], { recorded: false });
  }
  if (v.mergeMain) {
    // Main moved on (after the parent branched) and the parent synced with it.
    let mainFiles = files,
      newer = main;
    for (let i = 0; i < 8; i++) {
      mainFiles = await edit(mainFiles, `dir${i % 4}/g${i}.txt`, `newer main ${i}\n`);
      newer = await state(mainFiles, [newer.sha256], { recorded: false, below: true });
    }
    parentFiles = await edit(parentFiles, `dir0/g0.txt`, 'newer main 0\n');
    parent = await state(parentFiles, [parent.sha256, newer.sha256]);
  }
  return { generations, old, stackBase, child, parent, childFiles, parentFiles, state };
}
async function reference(s, input) {
  const uploaded = new Map(),
    bytes = async id => uploaded.get(id) ?? (await s.bytes({ sha256: id }));
  const out = await buildHostedSourceState(input, {
    async describeBatch(ids) {
      return Promise.all(ids.map(async id => ref({ sha256: id, size: (await bytes(id)).length })));
    },
    async read(pin) {
      return [await bytes(pin.sha256)];
    },
    async upload(pin, stream) {
      const parts = [];
      for await (const part of stream) parts.push(part);
      const b = Buffer.concat(parts);
      assert.equal(digest(b), pin.sha256);
      uploaded.set(pin.sha256, b);
    },
  });
  return out.output;
}
const fetched = events => events.filter(e => e.fetch).map(e => e.fetch);
const row = (s, sha256) =>
  s.ctx.db
    .query('projectObjects')
    .withIndex('by_project_and_digest', q => q.eq('projectId', s.projectId).eq('digest', sha256))
    .unique();

test('recovery compose reapplies a reverted Lane delta without reading pre-parent history', async t => {
  const s = await scaleFixture();
  try {
    const h = await history(s, { mergeMain: true });
    const recovered = h.childFiles.filter(file => file.path.startsWith('child/'));
    const accepted = await h.state([...h.parentFiles, ...recovered], [h.parent.sha256, h.child.sha256]);
    const reverted = await h.state(h.parentFiles, [accepted.sha256]);
    const fixed = {
      path: 'fix.sh',
      mode: 'executable',
      blob: (await s.putSpec(Buffer.from('#!/bin/sh\nexit 0\n'))).sha256,
    };
    const lane = await h.state([...h.childFiles, fixed], [h.child.sha256]);
    const laneId = randomUUID();
    const inputs = buildComposePages([
        { laneId, head: lane.sha256, version: 1, sourceVersion: 1, lifecycleVersion: 0, state: ref(lane) },
      ]),
      dependencies = buildComposePages([]);
    for (const page of [...dependencies.pages, ...inputs.pages]) await s.json(page.value);
    const input = await s.json({
      schema: 1,
      kind: 'forge-hosted-compose-input',
      base: { head: reverted.sha256, receiptId: 'revert' },
      main: ref(reverted),
      inputs: inputs.manifest,
      dependencies: dependencies.manifest,
      restoreBases: { [laneId]: ref(h.stackBase) },
      algorithm: 'forge-native-compose-v1',
      message: 'recover',
      at,
    });
    const start = s.events.length,
      id = await s.enqueue(input),
      drained = await s.drain(),
      job = await s.job(id),
      reads = fetched(s.events.slice(start));
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.output, await reference(s, input), 'exact whole-worker result');
    const { result } = JSON.parse(await s.bytes(job.output));
    assert.equal(result.status, 'clean');
    const merged = await row(s, result.state.sha256);
    assert.deepEqual(merged.stateParents, [reverted.sha256, lane.sha256]);
    assert.equal(
      merged.stateGeneration,
      1 + Math.max(h.generations.get(reverted.sha256), h.generations.get(lane.sha256)),
    );
    const state = parseNativeState(await s.bytes(result.state));
    assert.deepEqual(
      state.files,
      [...h.parentFiles, ...recovered, fixed].sort((a, b) => a.path.localeCompare(b.path)),
    );
    const oldReads = reads.filter(read => h.old.has(read)).length;
    t.diagnostic(
      JSON.stringify({
        oldReads,
        manifests: reads.filter(read => h.generations.has(read)).length,
        steps: drained.steps,
        calls: drained.functionCalls,
        documentsRead: drained.documentsRead,
        documentsWritten: drained.documentsWritten,
        readBytes: drained.readBytes,
        wallMs: drained.wallMs,
        maxRssBytes: drained.maxRssBytes,
      }),
    );
    assert.equal(oldReads, 0, 'no pre-parent history manifest is needed to reapply an explicit delta');
    assert.deepEqual(
      reads.filter(read => h.generations.has(read)).sort(),
      [reverted.sha256, lane.sha256, h.stackBase.sha256].sort(),
      'only main, Lane and the explicit base are read, once each',
    );
    assert(drained.steps <= 2, 'small recovery finishes in up to two source steps');
  } finally {
    s.restore();
  }
});

// The parent synced with a newer main, so a side lineage joins below the stack base. `bare` rows keep
// no recorded generation (the oldest rows); `conflict` makes both Lanes edit the same file.
for (const v of [{ mergeMain: true }, { mergeMain: true, bare: true }, { mergeMain: true, conflict: true }])
  test(`a stacked sync reads no history beside or below its stack base ${JSON.stringify(v)}`, async t => {
    const s = await scaleFixture();
    try {
      const h = await history(s, v);
      const input = await s.json({
        schema: 1,
        kind: 'forge-hosted-sync-input',
        algorithm: 'forge-native-sync-v1',
        work: { mode: 'sync', left: ref(h.child), right: ref(h.parent), stackBase: ref(h.stackBase) },
        message: 'sync',
        at,
      });
      const start = s.events.length,
        id = await s.enqueue(input),
        drained = await s.drain();
      const job = await s.job(id);
      assert.equal(job.status, 'completed');
      const events = s.events.slice(start),
        reads = fetched(events);
      assert.deepEqual(job.output, await reference(s, input), 'byte-exact stacked sync result');
      const out = JSON.parse(await s.bytes(job.output)).result;
      assert.equal(out.status, v.conflict ? 'conflict' : 'merged');
      // Before: the breadth-first walk read the old main's manifests one level per round.
      assert.deepEqual(
        reads.filter(read => h.old.has(read)),
        [],
        'no history manifest below the stack base is read',
      );
      // The stacked result keeps its exact generation and recorded parents.
      const merged = await row(s, out.state.sha256);
      assert.equal(
        merged.stateGeneration,
        1 +
          Math.max(
            h.generations.get(h.child.sha256),
            ...(v.conflict ? [] : [h.generations.get(h.parent.sha256)]),
          ),
      );
      assert.deepEqual(
        merged.stateParents,
        v.conflict ? [h.child.sha256] : [h.parent.sha256, h.child.sha256],
        'a conflict draft has only its left parent',
      );
      assert(reads.filter(read => read === h.stackBase.sha256).length <= 1, 'the stack base is read once');
      t.diagnostic(
        JSON.stringify({
          reads: reads.length,
          old: reads.filter(read => h.old.has(read)).length,
          steps: drained.steps,
          calls: events.filter(e => e.call).length,
        }),
      );
    } finally {
      s.restore();
    }
  });
