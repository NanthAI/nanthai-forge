// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { finishChild } from '../dist/agent-finish-journal.js';
import { readLaneSubmissions, finishSubmissions } from '../dist/landing-submission-read.js';
import { finishAttempt } from '../dist/agent-finish-journal.js';
import { initNative } from '../dist/native-work.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { trustAgents } from './autonomy-fixture.mjs';

test('overlap delegation keeps the original finish identities through pending, check and acceptance', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-submission-identity-'));
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'src'));
  const base = '# Document\n\nShared paragraph.\nAnother paragraph.\n\nEnd.\n';
  writeFileSync(join(root, 'docs/shared.md'), base);
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  t.after(async () => {
    await drainPostAccept(store);
    rmSync(root, { recursive: true, force: true });
  });
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  await agent.dispatch({ action: 'set-policy', operationId: randomUUID(), checks: { runner: 'local' } });
  const a = (await agent.dispatch({ action: 'start', outcome: 'Overlap contract' })).result;
  const b = (await agent.dispatch({ action: 'start', outcome: 'Sibling contract', intentId: a.intentId }))
    .result;
  for (const [lane, name] of [
    [a, 'alpha'],
    [b, 'beta'],
  ]) {
    mkdirSync(join(lane.path, 'src'), { recursive: true });
    writeFileSync(
      join(lane.path, 'docs/shared.md'),
      base.replace('Another paragraph.', `${name} addition.\nAnother paragraph.`),
    );
    writeFileSync(join(lane.path, `src/${name}.ts`), `export const ${name} = 1;\n`);
    await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save contract' });
  }
  const operationId = randomUUID(),
    dispatch = agent.work.dispatch.bind(agent.work);
  let before, during;
  agent.work.dispatch = async (...args) => {
    const response = await dispatch(...args);
    if (args[0].operationId === finishChild(operationId, 'overlap-preflight'))
      before = readLaneSubmissions(store);
    if (args[0].action === 'run-check' && !during) during = readLaneSubmissions(store);
    return response;
  };
  const result = (
    await agent.dispatch({
      action: 'finish',
      operationId,
      laneId: a.laneId,
      with: [b.laneId],
      message: 'Land ordered contract',
      accept: true,
      keepOpen: true,
    })
  ).result;
  assert.equal(before.length, 2);
  assert.equal(result.submissions.length, 2);
  assert.equal(during.length, 2);
  assert.ok(during.every(item => item.operationId === operationId));
  assert.deepEqual(
    during.map(item => item.submissionId).sort(),
    before.map(item => item.submissionId).sort(),
  );
  assert.ok(
    result.submissions.every(
      item =>
        item.state === 'landed' && item.operationId === operationId && item.entryOperationId !== operationId,
    ),
  );
  for (const item of before)
    assert.equal(
      result.submissions.find(after => after.laneId === item.laneId).submissionId,
      item.submissionId,
    );
  const status = readPendingStatus(store);
  for (const lane of [a, b]) {
    const submissions = readLaneSubmissions(store, lane.laneId);
    assert.equal(submissions.length, 1);
    assert.deepEqual(
      submissions,
      result.submissions.filter(item => item.laneId === lane.laneId),
    );
    assert.deepEqual(status.lanes.find(item => item.laneId === lane.laneId).submissions, submissions);
  }
});

test('finish retains the original submitted head while sync selects its attempt head', () => {
  const head = 'a'.repeat(64),
    synced = 'b'.repeat(64);
  const lane = { id: randomUUID(), intentId: randomUUID(), head: synced };
  const command = {
    operationId: randomUUID(),
    laneId: lane.id,
    accept: { channel: 'main', expectedPrevious: null },
  };
  const attempt = finishAttempt(command, 0, head, null);
  attempt.sync = { head: synced };
  const store = { select: collection => (collection === 'lanes' ? lane : undefined) };
  const result = finishSubmissions(store, command, [attempt], { status: 'accepted' })[0];
  assert.equal(result.head, head);
  assert.equal(result.attemptHead, synced);
  assert.equal(result.state, 'landed');
});
