// SPDX-License-Identifier: Apache-2.0
// Issue 1eef1b43 line 3 (friction 09c0b7cd): a live resolve spent 3 of its 4 steps reading about 40
// history manifests. The resolve walked ancestry from five roots; the draft is always an ancestor
// of the saved head, so the generation walk saw a subset-common State and fell back to a
// breadth-first search for a State all five roots pass through. In a live history (rows saved
// before recorded parents existed, and a long-lived Lane merged into main without syncing) that
// State is far below the merge. The harness models that history; synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { saveBytes } from '../dist/hosted-save.js';
import { parseNativeState } from '../dist/native-state-format.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
import { digest } from '../dist/hash.js';

const ref = object => ({ object, recipe: null });
async function history(s) {
  const generations = new Map(),
    old = new Set();
  // `recorded: false` is a row written before the worker recorded parents (it keeps its generation).
  const state = async (files, parents, { recorded = true } = {}) => {
    const generation = 1 + Math.max(0, ...parents.map(id => generations.get(id)));
    const pin = await s.putSpec(
      Buffer.from(saveBytes({ schema: 1, kind: 'forge-source-state', parents, files, message: 'm', at })),
      undefined,
      generation,
      recorded ? { parents } : {},
    );
    generations.set(pin.sha256, generation);
    if (!recorded) old.add(pin.sha256);
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
  files = await edit(files, 'shared.txt', 'a\nb\nc\n');
  // Old main and a long-lived Lane that branched from it, all saved before parents were recorded.
  let main = await state(files, [], { recorded: false });
  const branch = main;
  let mainFiles = files;
  for (let i = 0; i < 10; i++) {
    mainFiles = await edit(mainFiles, `dir${i % 4}/f${i}.txt`, `old main ${i}\n`);
    main = await state(mainFiles, [main.sha256], { recorded: false });
  }
  let lane = branch,
    laneFiles = files;
  for (let i = 0; i < 8; i++) {
    laneFiles = await edit(laneFiles, 'dir3/long.txt', `long lane ${i}\n`);
    lane = await state(laneFiles, [lane.sha256], { recorded: false });
  }
  // After the deploy: the long-lived Lane lands (a merge), and a probe Lane starts from that main.
  mainFiles = await edit(mainFiles, 'dir3/long.txt', 'long lane 7\n');
  const base = await state(mainFiles, [main.sha256, lane.sha256]);
  const probe = await state(await edit(mainFiles, 'shared.txt', 'LANE\nb\nc\n'), [base.sha256]);
  // Main moves on (a conflicting edit), and the long-lived Lane lands again without syncing first.
  mainFiles = await edit(mainFiles, 'shared.txt', 'MAIN\nb\nc\n');
  main = await state(mainFiles, [base.sha256]);
  for (let i = 8; i < 10; i++) {
    laneFiles = await edit(laneFiles, 'dir3/long.txt', `long lane ${i}\n`);
    lane = await state(laneFiles, [lane.sha256]);
  }
  mainFiles = await edit(mainFiles, 'dir3/long.txt', 'long lane 9\n');
  main = await state(mainFiles, [main.sha256, lane.sha256]);
  return { state, blob, generations, old, probe, main };
}
async function run(s, input) {
  const start = s.events.length,
    id = await s.enqueue(input),
    drained = await s.drain();
  const job = await s.job(id);
  assert.equal(job.status, 'completed');
  return { id, output: job.output, events: s.events.slice(start), steps: drained.steps };
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

test('a resolve walks only its saved head and draft, so old history costs no manifest read', async t => {
  const s = await scaleFixture();
  try {
    const h = await history(s);
    const input = await s.json({
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work: { mode: 'sync', left: ref(h.probe), right: ref(h.main) },
      message: 'sync',
      at,
    });
    const sync = await run(s, input);
    assert.deepEqual(sync.output, await reference(s, input), 'byte-exact sync result');
    const result = JSON.parse(await s.bytes(sync.output)).result;
    assert.equal(result.status, 'conflict');
    assert.deepEqual(
      fetched(sync.events).filter(id => h.old.has(id)),
      [],
      'the two-tip conflict sync already stops at its merge base',
    );

    const draft = parseNativeState(await s.bytes(result.state));
    const files = [];
    for (const file of draft.files)
      files.push(file.path === 'shared.txt' ? { ...file, blob: await h.blob('BOTH\nb\nc\n') } : file);
    h.generations.set(result.state.sha256, (await row(s, result.state.sha256)).stateGeneration);
    const saved = await h.state(files, [result.state.sha256]);
    const resolveInput = await s.json({
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work: {
        mode: 'resolve',
        left: ref(saved),
        resolution: {
          candidateId: null,
          conflicts: result.conflicts,
          left: result.left,
          right: result.right,
          draftHead: result.state.sha256,
          status: 'pending',
        },
      },
      message: 'resolve',
      at,
    });
    const resolved = await run(s, resolveInput);
    assert.deepEqual(resolved.output, await reference(s, resolveInput), 'byte-exact resolve result');
    const out = JSON.parse(await s.bytes(resolved.output)).result;
    assert.equal(out.status, 'resolved');
    const reads = fetched(resolved.events);
    // Before: the breadth-first walk read every old manifest down to the long-lived Lane's branch point.
    assert.deepEqual(
      reads.filter(id => h.old.has(id)),
      [],
      'no history manifest is read for a resolve',
    );
    assert.equal(resolved.steps, 1, 'one step');
    // The resolved State still gets a generation: the right tip's descriptor came with the probe.
    const resolvedRow = await row(s, out.state.sha256);
    assert.equal(
      resolvedRow.stateGeneration,
      1 + Math.max(h.generations.get(saved.sha256), h.generations.get(h.main.sha256)),
    );
    assert.deepEqual(resolvedRow.stateParents, [saved.sha256, h.main.sha256]);
    assert(!reads.includes(h.main.sha256), 'the right tip is described, not read');
    // The step row says what the step ran, why it stopped and what it read (friction 09c0b7cd).
    const stepRow = await s.ctx.db
      .query('projectSourceSteps')
      .withIndex('by_project_and_job', q => q.eq('projectId', s.projectId).eq('jobId', resolved.id))
      .unique();
    const [step] = stepRow.timing.steps;
    assert.equal(step.phase, 'input>done');
    assert.equal(step.stop, 'done');
    assert.equal(step.states + step.pages + step.blobs, reads.length, 'every read has a kind');
    assert(step.pages >= 2, 'the input plan and the conflict page are Forge JSON pages');
    t.diagnostic(
      JSON.stringify({
        sync: { reads: fetched(sync.events).length, steps: sync.steps },
        resolve: {
          reads: reads.length,
          steps: resolved.steps,
          calls: resolved.events.filter(e => e.call === 'projectConvexSourceObjects:resolve').length,
        },
      }),
    );
  } finally {
    s.restore();
  }
});
