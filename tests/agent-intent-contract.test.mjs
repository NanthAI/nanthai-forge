// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { readAgentReview } from '../dist/agent-review.js';
import { viewReadModels } from '../dist/view-read-model.js';
import { enforceAcceptance } from '../dist/work-autonomy.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { cleanupOwner } from './owner-cleanup.mjs';
const a = 'tests/leaf.test.mjs',
  b = 'tests/extra.test.mjs';
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-intent-contract-'));
  t.after(() => cleanupOwner(root));
  for (const dir of ['src', 'tests', 'scripts', 'web', 'convex', 'netlify']) mkdirSync(join(root, dir));
  for (const [file, text] of Object.entries({
    'src/leaf.ts': 'export const leaf = 1;',
    [a]: "import '../dist/leaf.js';",
    [b]: "import 'node:assert';",
    'package.json': '{"scripts":{}}',
    'package-lock.json': '{"packages":{}}',
  }))
    writeFileSync(join(root, file), text);
  initNative(root);
  const agent = new AgentWorkflow(root),
    lane = (await agent.dispatch({ action: 'start', outcome: 'Proving tests' })).result;
  writeFileSync(join(lane.path, 'src/leaf.ts'), 'export const leaf = 2;');
  const saved = (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Change leaf' }))
    .result;
  const view = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: saved.head }],
    })
  ).result;
  const reports =
    [a, b]
      .map(
        (file, i) => '__FORGE_TESTS__' + JSON.stringify({ file, complete: true, durationMs: i ? 800 : 1200 }),
      )
      .join('\n') + '\n';
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(reports)})`],
    environmentLabel: 'synthetic timing collector',
  });
  return { root, agent, lane, view: agent.work.store.select('views', view.viewId), store: agent.work.store };
}
test('native proposal, measured confirmation, edit, replay and review retain exact Candidate evidence', async t => {
  const { agent, lane, view, store } = await fixture(t);
  const before = store.snapshotBytes(),
    proposal = (await agent.dispatch({ action: 'tests', candidateId: view.id })).result;
  assert.deepEqual(store.snapshotBytes(), before);
  assert.ok(proposal.tests.includes(a));
  assert.equal(proposal.contract, null);
  assert.deepEqual(proposal.contractProposal.missingTimings, [a]);
  const runId = randomUUID();
  assert.equal(
    (await agent.dispatch({ action: 'run', operationId: runId, viewId: view.id })).result.status,
    'passed',
  );
  const measured = (await agent.dispatch({ action: 'tests', candidateId: view.id, runId })).result;
  assert.equal(measured.contractProposal.totalMs, 1200);
  assert.equal(measured.contractProposal.measuredOn, view.head);
  const command = {
    action: 'confirm-tests',
    operationId: randomUUID(),
    candidateId: view.id,
    runId,
    expectedHead: view.head,
    expectedVersion: 0,
  };
  const first = (await agent.dispatch(command)).result.contract;
  assert.equal(first.totalMs, 1200);
  assert.equal(first.version, 1);
  const second = (
    await agent.dispatch({ ...command, operationId: randomUUID(), expectedVersion: 1, tests: [a, b] })
  ).result.contract;
  assert.equal(second.totalMs, 2000);
  assert.equal(second.version, 2);
  assert.deepEqual((await agent.dispatch(command)).result.contract, first);
  await assert.rejects(agent.dispatch({ ...command, tests: [b] }), { code: 'WORK_OPERATION_CHANGED' });
  assert.deepEqual(
    readAgentReview(store, {
      kind: 'view',
      id: view.id,
      expectedHead: view.head,
      expectedBase: view.base,
      expectedStatus: 'clean',
    }).result.contract,
    second,
  );
  assert.deepEqual(viewReadModels(store.load()).find(item => item.viewId === view.id).contract, second);
  assert.deepEqual((await agent.dispatch({ action: 'tests', laneId: lane.laneId })).result.contract, second);
});
test('native confirmation refuses missing reports and an unrelated Candidate run without storing a contract', async t => {
  const { agent, view, store } = await fixture(t);
  const runId = randomUUID();
  await agent.dispatch({ action: 'run', operationId: runId, viewId: view.id });
  rmSync(join(store.directory, `check-${runId}`, 'stdout.log'));
  assert.equal(
    (await agent.dispatch({ action: 'tests', candidateId: view.id, runId })).result.contractProposal.totalMs,
    1200,
    'compact timing evidence survives raw-log removal',
  );
  rmSync(join(store.directory, `check-${runId}`, 'test-evidence.json'));
  const command = {
    action: 'confirm-tests',
    operationId: randomUUID(),
    candidateId: view.id,
    runId,
    expectedHead: view.head,
    expectedVersion: 0,
  };
  await assert.rejects(agent.dispatch(command), { code: 'CONTRACT_TIMING_MISSING' });
  await assert.rejects(agent.dispatch({ ...command, runId: randomUUID() }), {
    code: 'CONTRACT_TIMING_SOURCE',
  });
  assert.equal(store.select('intents', view.intentId).testContracts, undefined);
});
test('native historical proposal times stay estimates and never satisfy confirmation', async t => {
  const { agent, view, store } = await fixture(t);
  writeFileSync(
    join(store.directory, 'test-timings.json'),
    JSON.stringify({
      version: 1,
      files: { [a]: { durationMs: 1234, updatedAt: '2026-01-01T00:00:00.000Z' } },
      runs: [],
    }),
  );
  const result = (await agent.dispatch({ action: 'tests', candidateId: view.id })).result;
  assert.equal(result.contractProposal.totalMs, 1234);
  assert.equal(result.contractProposal.timingBasis, 'historical-estimate');
  assert.equal(result.contractProposal.measuredOn, null);
  await assert.rejects(
    agent.dispatch({
      action: 'confirm-tests',
      operationId: randomUUID(),
      candidateId: view.id,
      expectedHead: view.head,
      expectedVersion: 0,
    }),
    { code: 'BAD_ARGUMENT' },
  );
});

test('contract metadata does not bypass the existing exact-Candidate full gate', async t => {
  const { view, store } = await fixture(t);
  const data = store.load();
  data.autonomyPolicy = policyPreset('autonomous');
  const actor = { kind: 'agent', id: 'synthetic-agent' };
  assert.throws(() => enforceAcceptance(store, data, view, null, actor), { code: 'CHECK_REQUIRED' });
  data.intents.find(intent => intent.id === view.intentId).testContracts = [
    { version: 1, measuredOn: view.head, tests: [], totalMs: 0 },
  ];
  assert.throws(() => enforceAcceptance(store, data, view, null, actor), { code: 'CHECK_REQUIRED' });
});
