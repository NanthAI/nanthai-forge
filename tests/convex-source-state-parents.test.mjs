// SPDX-License-Identifier: Apache-2.0
// Recorded State parents (Git commit-graph parity, issue 1eef1b43): the ancestry walk of a sync or
// resolve reads object rows, not manifests, so its source bytes do not grow with main's distance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { syncHistory, syncInput, resolveInput } from './measure-sync-ancestry.mjs';
import { convertStateTree } from '../dist/state-tree-save.js';
import { TreeSession } from '../dist/state-tree-store.js';
import { readStateTree, treeFile } from '../dist/state-tree.js';

async function run({ distance, recordParents, conflict = true }) {
  const s = await scaleFixture();
  try {
    const h = await syncHistory(s, { files: 400, changed: 2, distance, conflict, recordParents });
    const id = await s.enqueue(await syncInput(s, h)),
      sync = await s.drain(),
      job = await s.job(id);
    assert.equal(job.status, 'completed');
    const output = (await s.bytes(job.output)).toString(),
      parsed = JSON.parse(output);
    const row = digest => [...s.tables.projectObjects.values()].find(r => r.digest === digest);
    // The worker records the parents of every State it publishes, from the verified manifest.
    // A conflict draft has the Lane as its one parent; a clean merge records both tips.
    const parents = row(parsed.result.state.sha256).stateParents;
    if (conflict) assert.deepEqual(parents, [h.lane.sha256]);
    else assert.deepEqual([...parents].sort(), [h.lane.sha256, h.main.sha256].sort());
    if (!conflict) return { sync, output };
    const page = JSON.parse((await s.bytes(parsed.result.conflicts)).toString());
    assert.deepEqual(
      page.paths.map(entry => entry.path).sort(),
      [...h.selected].sort(),
      'only the edited paths conflict',
    );
    const resolveId = await s.enqueue(await resolveInput(s, h, parsed)),
      resolve = await s.drain(),
      resolved = await s.job(resolveId);
    assert.equal(resolved.status, 'completed');
    const resolvedOutput = (await s.bytes(resolved.output)).toString(),
      head = JSON.parse(resolvedOutput).result.state.sha256;
    assert.equal(row(head).stateParents.length, 2, 'a resolved State records both parents');
    // History between the Lane's base and main is never downloaded: its rows carry the edges.
    assert.equal(h.chain.length, distance - 1, 'the main chain between base and main');
    const historyReads = h.chain.reduce((n, digest) => n + (s.readCounts.get(digest) ?? 0), 0);
    return { sync, resolve, output, resolvedOutput, historyReads };
  } finally {
    s.restore();
  }
}

test('recorded parents keep sync and resolve State reads independent of main distance, byte-equal', async t => {
  const near = await run({ distance: 4, recordParents: true }),
    far = await run({ distance: 40, recordParents: true }),
    manifests = await run({ distance: 40, recordParents: false });
  assert.equal(far.historyReads, 0);
  for (const phase of ['sync', 'resolve']) {
    assert.equal(far[phase].readObjects, near[phase].readObjects, `${phase} reads do not grow with distance`);
    assert(far[phase].steps <= near[phase].steps + 1, `${phase} steps ${far[phase].steps}`);
    // One bounded descriptor page follows the recorded chain: no call per level.
    assert(far[phase].functionCalls <= near[phase].functionCalls, `${phase} calls do not grow with distance`);
    assert(far[phase].functionCalls <= manifests[phase].functionCalls, `${phase} calls never rise`);
    assert(manifests[phase].readObjects > far[phase].readObjects, 'old rows still read manifests');
    t.diagnostic(JSON.stringify({ phase, near: near[phase], far: far[phase], manifests: manifests[phase] }));
  }
  // Same conflict files, draft and resolved State whichever way the edges were learned.
  assert.equal(far.output, manifests.output);
  assert.equal(far.resolvedOutput, manifests.resolvedOutput);
});

test('a clean sync far behind main reads only its tips', async () => {
  const far = await run({ distance: 40, recordParents: true, conflict: false }),
    manifests = await run({ distance: 40, recordParents: false, conflict: false });
  assert.equal(far.output, manifests.output);
  assert(far.sync.readObjects < manifests.sync.readObjects);
  assert(far.sync.functionCalls <= manifests.sync.functionCalls);
});

test('a resolve that leaves markers in one of many conflicted files still refuses', async () => {
  const s = await scaleFixture();
  try {
    const h = await syncHistory(s, { files: 400, changed: 10, distance: 3, conflict: true });
    const id = await s.enqueue(await syncInput(s, h));
    await s.drain();
    const output = JSON.parse((await s.bytes((await s.job(id)).output)).toString()),
      left = h.selected[4];
    const resolveId = await s.enqueue(
      await resolveInput(s, h, output, p =>
        p === left ? `<<<<<<< ours\n${p}\n=======\nmain\n>>>>>>> theirs` : `resolved ${p}`,
      ),
    );
    const run = await s.drain();
    // Ten small marker scans run inside the step, not as ten child actions.
    assert.equal(run.steps, 1);
    const job = await s.job(resolveId);
    assert.equal(job.status, 'failed');
    assert.equal(job.control.failureCode, 'CONFLICT_MARKERS');
  } finally {
    s.restore();
  }
});

test('recorded parents are written once, exact and immutable', async () => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const { storeSourceOutputs } = await import(moduleUrl('../convex/projectConvexSourceOutput.ts'));
  const { r2Key } = await import(moduleUrl('../convex/r2.ts'));
  const s = await scaleFixture();
  try {
    const parent = 'a'.repeat(64),
      other = 'b'.repeat(64),
      sha256 = 'c'.repeat(64),
      pin = { sha256, size: 10, r2Key: r2Key(s.projectId, sha256), stateGeneration: 2 };
    const store = extra =>
      s.run('store', () => storeSourceOutputs(s.ctx, s.projectId, 'exec', [{ ...pin, ...extra }]));
    const row = () => [...s.tables.projectObjects.values()].find(r => r.digest === sha256);
    // An older worker wrote no parents; the first exact list fills the row.
    await store({});
    assert.equal(row().stateParents, undefined);
    await store({ stateParents: [parent] });
    assert.deepEqual(row().stateParents, [parent]);
    await store({ stateParents: [parent] });
    await store({});
    assert.deepEqual(row().stateParents, [parent], 'never cleared');
    await assert.rejects(store({ stateParents: [other] }), /Immutable State parents changed/);
    await assert.rejects(store({ stateParents: [parent, parent] }), /exact distinct digests/);
    await assert.rejects(store({ stateParents: ['not-a-digest'] }), /exact distinct digests/);
    await assert.rejects(
      store({ stateParents: Array.from({ length: 17 }, (_, i) => String(i).padStart(64, '0')) }),
      /exact distinct digests/,
    );
  } finally {
    s.restore();
  }
});

// Trees in packs, dual-write (Issue 676efbc2): the real Convex step records a State's tree pointer
// only for a project with tree writes on, in the commit it already makes.
async function treeSync(write) {
  const s = await scaleFixture();
  try {
    const row = digest => [...s.tables.projectObjects.values()].find(r => r.digest === digest);
    const store = {
      get: async id => s.bytes({ sha256: id }),
      put: async bytes => (await s.putSpec(Buffer.from(bytes))).sha256,
    };
    // States as the native writer serializes them (the tree form reproduces exactly these bytes).
    const blob = async text => (await s.putSpec(Buffer.from(text))).sha256,
      shared = await blob('synthetic\n');
    const state = async (parents, edits, generation) => {
      const files = Array.from({ length: 400 }, (_, i) => {
        const path = `src/dir${i % 20}/module-${String(i).padStart(4, '0')}.ts`;
        return { path, blob: edits[path] ?? shared, mode: 'file' };
      }).sort((a, b) => (a.path < b.path ? -1 : 1));
      const value = { schema: 1, kind: 'forge-source-state', parents, files, message: 'state', at };
      return s.putSpec(Buffer.from(JSON.stringify(value)), undefined, generation, { parents });
    };
    const base = await state([], {}, 1),
      h = {
        main: await state([base.sha256], { 'src/dir1/module-0001.ts': await blob('main\n') }, 2),
        lane: await state([base.sha256], { 'src/dir2/module-0002.ts': await blob('lane\n') }, 2),
      };
    // Both tips were converted earlier (the one-time conversion), whatever the flag says now.
    for (const pin of [h.lane, h.main]) {
      const converted = await convertStateTree(store, await s.bytes(pin), async file =>
        treeFile(file, await s.bytes({ sha256: file.blob })),
      );
      assert.ok(converted.exact);
      await s.ctx.db.patch(row(pin.sha256)._id, { stateTree: converted.pointer });
    }
    if (write) await s.ctx.db.patch(s.projectId, { stateTrees: { write: true } });
    const rowsBefore = s.tables.projectObjects.size;
    const id = await s.enqueue(await syncInput(s, h)),
      sync = await s.drain(),
      job = await s.job(id);
    assert.equal(job.status, 'completed');
    const output = (await s.bytes(job.output)).toString(),
      merged = row(JSON.parse(output).result.state.sha256);
    assert.deepEqual([...merged.stateParents].sort(), [h.lane.sha256, h.main.sha256].sort());
    const project = await s.ctx.db.get(s.projectId);
    return { s, sync, output, merged, store, rows: s.tables.projectObjects.size - rowsBefore, project, row };
  } finally {
    s.restore();
  }
}

test('dual-write in the Convex step: a merged State gets a proven tree pointer and one segment row, with no extra call or blob read; off records none', async t => {
  const off = await treeSync(false),
    on = await treeSync(true);
  assert.equal(off.merged.stateTree, undefined, 'tree writes off: no pointer');
  assert.equal(on.output, off.output, 'the flat result is byte-identical');
  const pointer = on.merged.stateTree;
  assert.ok(pointer, 'tree writes on: the merged State has a pointer');
  // The pointer rebuilds the exact flat State from what the object store holds.
  const rebuilt = await readStateTree(new TreeSession(on.store, { strict: true }), pointer);
  assert.deepEqual(
    Buffer.from(rebuilt.manifest),
    await on.s.bytes({ sha256: on.merged.digest }),
    'the stored tree is the flat State',
  );
  assert.ok(on.row(pointer.segment), 'the segment has its object row');
  assert.equal(on.rows, off.rows + 1, 'one more object row per State: its segment');
  assert.equal(on.project.stateTrees.refused, undefined, 'no alarm');
  // Calls never rise: the pointer and the segment row ride the step's own commit, and files taken
  // from main get their Git ids from main's tree.
  assert.equal(on.sync.functionCalls, off.sync.functionCalls);
  assert.equal(on.sync.steps, off.sync.steps);
  t.diagnostic(JSON.stringify({ off: off.sync, on: on.sync, segmentBytes: pointer.size }));
});
