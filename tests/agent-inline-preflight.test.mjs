// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { finishGates } from '../dist/agent-default-gates.js';
import {
  preflightRuntime,
  readPreflightReceipt,
  PREFLIGHT_LOCAL_BUDGET_SECONDS,
} from '../dist/agent-preflight.js';

const common = {
  'package.json': '{"type":"module"}',
  'scripts/forge-check.mjs': '',
  'tests/docs.test.mjs':
    "import test from 'node:test'; import fs from 'node:fs'; test('document remains readable', () => fs.readFileSync(new URL('../README.md', import.meta.url)));\n",
};
async function fixture(t, policy = 'require', reader = common['tests/docs.test.mjs']) {
  const files = { ...common, 'tests/docs.test.mjs': reader };
  const s = agentFixture(t, {
    base: { ...files, 'README.md': 'Before\n' },
    lane: { ...files, 'README.md': 'After\n' },
  });
  s.caps.agentDefaults = effectiveAgentDefaults({ preflight: policy });
  s.caps.features = ['land-gates'];
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  // The synthetic server accepts the checked Candidate; real preflight and finish run unchanged.
  const mutate = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    const text = await mutate(ref, args);
    if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return text;
    const state = JSON.parse(text);
    state.phase = 'landed';
    state.observation = { state: 'landed', pendingReason: null, cause: null };
    state.acceptance = { receiptId: randomUUID(), head: s.lane.head };
    return JSON.stringify(state);
  };
  return s;
}

test('incident e0cedfb5: one land --save lands a one-file docs change after inline preflight, preserving operationId and call budget', async t => {
  const calls = [];
  for (const policy of ['require', 'off']) {
    const s = await fixture(t, policy),
      operationId = randomUUID();
    const before = s.calls.length;
    const result = await submitHostedLand(
      s.root,
      { operationId, message: 'Update document' },
      s.address,
      s.transport(),
    );
    assert.equal(result.operationId, operationId);
    assert.equal(result.result.submission.phase, 'landed');
    assert.equal(result.result.submission.operationId, operationId);
    const gate = JSON.parse(s.calls.find(c => c.name === 'projectHostedLanding:enqueue').args.gates).lanes[0];
    assert.equal(gate.preflight, policy === 'require' ? 'passed' : 'none');
    if (policy === 'require') {
      const receipt = readPreflightReceipt(s.root, s.lane.laneId);
      assert.equal(receipt.passed, true);
      assert.equal(receipt.tests, 1);
      assert.equal(receipt.budgetSeconds, PREFLIGHT_LOCAL_BUDGET_SECONDS);
    }
    calls.push(s.calls.slice(before).map(c => c.name));
  }
  // off omits path discovery by existing policy; compare require's inline run against a pre-satisfied run below.
  const s = await fixture(t),
    transport = s.transport();
  const advice = { changedPaths: { paths: ['README.md'], complete: true } };
  finishGates(s.root, s.caps.agentDefaults, { laneId: s.lane.laneId, head: s.lane.head }, advice, true);
  const before = s.calls.length;
  await submitHostedLand(
    s.root,
    { operationId: randomUUID(), message: 'Update document' },
    s.address,
    transport,
  );
  assert.deepEqual(
    s.calls.slice(before).map(c => c.name),
    calls[0],
    'inline preflight adds zero Convex calls',
  );
});

test('inline preflight failure stops before compose and names the exact next command', async t => {
  const s = await fixture(t);
  writeFileSync(
    join(s.root, 'tests/docs.test.mjs'),
    "import test from 'node:test'; test('red', () => { throw Error('synthetic regression'); });\n",
  );
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({ ok: true }));
  assert.throws(
    () =>
      finishGates(
        s.root,
        s.caps.agentDefaults,
        { laneId: s.lane.laneId, head: s.lane.head },
        { changedPaths: { paths: ['tests/docs.test.mjs'], complete: true } },
        true,
      ),
    error => {
      assert.equal(error.code, 'PREFLIGHT_REQUIRED');
      assert.match(error.message, /Inline preflight failed/);
      assert(error.message.includes(`nforge agent '${s.root}' preflight '{"laneId":"${s.lane.laneId}"}'`));
      assert.match(error.message, /same land operation/);
      return true;
    },
  );
  assert(!s.calls.some(c => /Compose|Landing/.test(c.name)));
});

test('inline preflight exhaustion keeps the existing budget and returns the exact stopped-files continuation', async t => {
  const s = await fixture(t);
  // Four direct readers exercise stopped-file recovery. Advance the fake clock without sleeping.
  for (let i = 0; i < 4; i++)
    writeFileSync(join(s.root, `tests/reader-${i}.test.mjs`), common['tests/docs.test.mjs']);
  const actual = Date.now();
  // Each parent clock read advances beyond the existing budget; the first group still runs.
  let reads = 0;
  t.mock.method(Date, 'now', () => actual + 181000 * reads++);
  let failure;
  try {
    finishGates(
      s.root,
      s.caps.agentDefaults,
      { laneId: s.lane.laneId, head: s.lane.head },
      { changedPaths: { paths: ['README.md'], complete: true } },
      true,
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'PREFLIGHT_REQUIRED');
  assert.match(failure.message, /exceeded its budget/);
  const receipt = readPreflightReceipt(s.root, s.lane.laneId);
  assert.equal(receipt.budgetSeconds, PREFLIGHT_LOCAL_BUDGET_SECONDS);
  assert(receipt.stoppedForTime > 0);
  assert(failure.message.includes(receipt.incomplete?.finish ?? receipt.stoppedRerun));
});

test('a failed inline land keeps its original operation and complete replay, with a structured exact preflight next command', async t => {
  const reader =
    "import test from 'node:test'; import fs from 'node:fs'; test('red document reader', () => { fs.readFileSync(new URL('../README.md', import.meta.url)); throw Error('synthetic failure'); });\n";
  const s = await fixture(t, 'require', reader),
    operationId = randomUUID();
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({ ok: true }));
  await assert.rejects(
    submitHostedLand(s.root, { operationId, message: 'Retain original message' }, s.address, s.transport()),
    error => {
      assert.equal(error.code, 'PREFLIGHT_REQUIRED');
      assert.equal(error.recovery.operationId, operationId);
      assert.equal(error.recovery.replay.parameters.operationId, operationId);
      assert.equal(error.recovery.replay.parameters.message, 'Retain original message');
      assert.match(error.recovery.command, /preflight/);
      assert(error.message.includes(error.recovery.command));
      assert(error.recovery.replayCommand.includes(operationId));
      return true;
    },
  );
  assert(!s.calls.some(c => /Compose|Landing/.test(c.name)), 'a failed local run starts no remote check');
});
