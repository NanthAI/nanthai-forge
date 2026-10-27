// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivedLaneName, displayLaneName } from '../dist/lane-name.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
const outcome =
  'Preserve exact check evidence when a long-running agent changes source and the first attempt fails near the end of the retained output';
test('derived Lane names end at a word boundary with an ellipsis, and full outcomes remain displayable', () => {
  const name = derivedLaneName(outcome);
  assert(name.endsWith('…'));
  assert(name.length <= 120);
  assert(outcome.startsWith(name.slice(0, -1) + ' '));
  assert.equal(displayLaneName(name, outcome), outcome);
  assert.equal(displayLaneName(outcome.slice(0, 120), outcome), outcome);
  assert.equal(displayLaneName('Custom Lane', outcome), 'Custom Lane');
  assert.equal(derivedLaneName('Short outcome'), 'Short outcome');
  assert(derivedLaneName('😀 '.repeat(50)).length <= 120);
});
test('agent start derives a bounded label without truncating the retained Intent outcome', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-lane-name-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'export const a=1;\n');
  initNative(root);
  const lane = (await new AgentWorkflow(root).dispatch({ action: 'start', outcome })).result;
  const store = new WorkStore(root);
  assert.equal(store.select('lanes', lane.laneId).name, derivedLaneName(outcome));
  assert.equal(store.select('intents', lane.intentId).outcome, outcome);
});
