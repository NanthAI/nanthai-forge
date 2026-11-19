// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { clientCacheRoot } from '../dist/root-paths.js';
import { keptSaveTiming, saveStartedHere } from '../dist/hosted-save-receipt-state.js';

/** The operation journal's get/retain: the first retained value wins. */
const journal = () => {
  const values = new Map();
  return {
    get: key => values.get(key),
    retain: async (key, prepare) => {
      if (!values.has(key)) values.set(key, prepare());
      return values.get(key);
    },
  };
};
const split = stepsMs => ({ totalMs: Object.values(stepsMs).reduce((a, b) => a + b, 0), stepsMs });

test('Issue 15fd0037 F4: a save replay that first sees the outcome keeps its split marked replay, never as the original', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'forge-save-timing-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'lane');
  mkdirSync(root);
  const operationId = randomUUID();
  assert.equal(saveStartedHere(root, operationId), false, 'a fresh save is the original invocation');
  // The first call captured and uploaded, then returned IN_PROGRESS: its folder stays, nothing is kept.
  mkdirSync(join(clientCacheRoot(root), 'saves', operationId), { recursive: true });
  const replay = saveStartedHere(root, operationId);
  assert.equal(replay, true);
  const j = journal();
  assert.equal(
    await keptSaveTiming(j, { outcome: false, split: split({ capture: 900 }), replay: false }),
    undefined,
  );
  const kept = await keptSaveTiming(j, {
    outcome: true,
    split: split({ settle: 5, hostedWait: 40 }),
    replay,
  });
  assert.deepEqual(kept, { ...split({ settle: 5, hostedWait: 40 }), replay: true });
  // A later replay answered from the settled receipt returns the same kept split.
  assert.deepEqual(
    await keptSaveTiming(j, { outcome: true, split: split({ settle: 1 }), replay: true }),
    kept,
  );
  assert.deepEqual(await keptSaveTiming(j, { outcome: true, split: split({}), replay: true }), kept);
  // A save that saw its own outcome first time keeps an unmarked split.
  const original = split({ capture: 700, upload: 200, submit: 100 });
  assert.deepEqual(
    await keptSaveTiming(journal(), { outcome: true, split: original, replay: false }),
    original,
  );
});
