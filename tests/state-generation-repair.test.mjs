// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Review 3aa618e2 F1: save States published while begin dropped the baseline generation have none,
// and the gap spread to their descendants. The operator repair fills them from recorded parents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const repair = await import(moduleUrl('../convex/projectStateGenerationRepair.ts'));
const hex = n => n.toString(16).padStart(64, '0');
function generationFixture() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const state = (n, parents, generation) => {
    s.insert('projectObjects', {
      projectId,
      digest: hex(n),
      size: 10,
      removed: false,
      nonce: `n${n}`,
      location: 'r2',
      r2Committed: true,
      r2Key: `v1/p/${projectId}/o/${hex(n)}`,
      ...(parents ? { stateParents: parents.map(hex) } : {}),
      ...(generation === undefined ? {} : { stateGeneration: generation }),
    });
    const id = s.insert('projectHostedStates', {
      projectId,
      head: hex(n),
      size: 10,
      input: hex(900 + n),
      jobId: `job-${n}`,
      output: hex(800 + n),
    });
    return s.tables.projectHostedStates.get(id)._creationTime;
  };
  const run = (since, apply, cursor = null) =>
    s.call('repair', repair.fromParents, { projectId, since, cursor, apply });
  const generation = n =>
    [...s.tables.projectObjects.values()].find(row => row.digest === hex(n)).stateGeneration;
  return { state, run, generation };
}

test('repair fills missing generations from recorded parents in publication order, only since the given time', async () => {
  const { state, run, generation } = generationFixture();
  state(1, [], 5); // before the window, with a generation
  state(2, [1]); // before the window, missing: out of scope
  const since = state(3, [1]); // first save after the regression: parent generation 5
  state(4, [3]); // its child, repaired in the same page
  state(5, [3, 1], 9); // already recorded: unchanged
  state(6, [2]); // parent outside the window has none: stays unresolved
  state(7, null); // no recorded parents: stays unresolved
  const preview = await run(since, false);
  assert.deepEqual(preview, { scanned: 5, missing: 4, assigned: 2, unresolved: 2, cursor: null, done: true });
  assert.equal(generation(3), undefined, 'preview writes nothing');
  assert.equal((await run(since, true)).assigned, 2);
  assert.deepEqual([3, 4, 5, 6, 7, 2].map(generation), [6, 7, 9, undefined, undefined, undefined]);
  assert.equal((await run(since, true)).assigned, 0, 'a rerun changes nothing');
});

test('a two-page preview counts a child of a parent assigned on the first page without writing either', async () => {
  const { state, run, generation } = generationFixture();
  state(1, [], 5);
  const since = state(2, [1]);
  for (let n = 3; n <= 101; n++) state(n, [1], 6);
  state(102, [2]);
  const first = await run(since, false);
  assert.equal(first.scanned, 100);
  assert.equal(first.assigned, 1);
  assert(first.cursor);
  const second = await run(since, false, first.cursor);
  assert.deepEqual(second, { scanned: 1, missing: 1, assigned: 1, unresolved: 0, cursor: null, done: true });
  assert.deepEqual([2, 102].map(generation), [undefined, undefined]);
  assert.deepEqual(await run(since, false, first.cursor), second, 'replaying the cursor stays read-only');
  const live = await run(since, true);
  assert.deepEqual(await run(since, true, live.cursor), second);
  assert.deepEqual([2, 102].map(generation), [6, 7]);
});
