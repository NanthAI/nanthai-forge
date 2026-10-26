// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { initNative, nativeExecute } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { updateHostState } from '../dist/host-binding.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { fixture as batchFixture } from './landing-batch-fixture.mjs';
import { cleanupOwner } from './owner-cleanup.mjs';

const binding = {
  projectId: 'synthetic-project',
  deployment: 'http://127.0.0.1:1',
  projectUrl: 'https://example.invalid/owner/project',
  operationId: randomUUID(),
  name: 'Synthetic',
  visibility: 'private',
  backupId: 'synthetic-backup',
  autoSync: false,
};
const server = { mode: 'server', epoch: 4 };
function bind(store, extra = { sourceAuthority: server }) {
  updateHostState(store, state => {
    state.binding = { ...binding, ...extra };
  });
}
function hosted(error) {
  assert.equal(error.code, 'HOSTED_AUTHORITY');
  assert.ok(error.message.includes(binding.projectUrl));
  assert.match(error.message, /projectHostedLanding \/ projectHostedAcceptance/);
  const command = JSON.parse(error.message.match(/finish '([^']+)'/)[1]);
  assert.equal(command.url, binding.deployment);
  assert.equal(command.projectId, binding.projectId);
  assert.equal(command.accept, true);
  assert.match(error.message, /editing can continue/);
  return true;
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-local-acceptance-'));
  t.after(() => cleanupOwner(root));
  writeFileSync(join(root, 'source.txt'), 'synthetic\n');
  initNative(root);
  const work = new WorkService(root);
  const intent = work.execute(
    { action: 'intent', outcome: 'Synthetic acceptance' },
    work.store.revision(),
  ).result;
  const lane = work.execute(
    { action: 'lane', intentId: intent.id, name: 'Synthetic' },
    work.store.revision(),
  ).result;
  const view = work.execute(
    {
      action: 'compose',
      operationId: randomUUID(),
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: lane.head }],
    },
    work.store.revision(),
  ).result;
  const command = {
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  };
  return { root, work, store: work.store, command, lane };
}

for (const acceptanceOwner of [undefined, false, true]) {
  test(`server authority refuses local accept, owner=${acceptanceOwner ?? 'legacy'}, before any source mutation`, t => {
    const f = fixture(t);
    bind(f.store, { acceptanceOwner, sourceAuthority: server });
    const before = f.store.load();
    for (const channel of ['main', 'release'])
      for (const ownerRequest of [false, true])
        assert.throws(
          () =>
            nativeExecute(f.store, { ...f.command, channel, authorityEpoch: 4 }, before.revision, {
              ownerRequest,
            }),
          hosted,
        );
    assert.deepEqual(f.store.load(), before);
  });
  test(`a pending switch to server refuses local accept, owner=${acceptanceOwner ?? 'legacy'}`, t => {
    const f = fixture(t);
    bind(f.store, { acceptanceOwner });
    updateHostState(f.store, state => {
      state.authorityTransition = {
        projectId: binding.projectId,
        deployment: binding.deployment,
        operationId: randomUUID(),
        expected: { mode: 'native-owner', epoch: 0 },
        mode: 'server',
      };
    });
    const before = f.store.load();
    assert.throws(() => nativeExecute(f.store, f.command, before.revision), hosted);
    assert.deepEqual(f.store.load(), before);
  });
  // Before the cutover and after a rollback the native owner is still the writer.
  for (const sourceAuthority of [undefined, { mode: 'native-owner', epoch: 0 }])
    test(`native-owner authority keeps local accept, owner=${acceptanceOwner ?? 'legacy'}, pin=${sourceAuthority ? 'explicit' : 'legacy'}`, t => {
      const f = fixture(t);
      bind(f.store, { acceptanceOwner, ...(sourceAuthority ? { sourceAuthority } : {}) });
      assert.equal(nativeExecute(f.store, f.command, f.store.revision()).result.status, 'accepted');
    });
  test(`server-shadow keeps the stale-pin fence, owner=${acceptanceOwner ?? 'legacy'}`, t => {
    const f = fixture(t);
    bind(f.store, { acceptanceOwner, sourceAuthority: { mode: 'server-shadow', epoch: 4 } });
    const before = f.store.load();
    assert.throws(
      () => nativeExecute(f.store, { ...f.command, authorityEpoch: 4 }, before.revision),
      error => error.code === 'SOURCE_AUTHORITY_STALE',
    );
    assert.deepEqual(f.store.load(), before);
  });
}

test('Work dispatch, agent accept and repeated operations preserve source and return hosted guidance', async t => {
  const f = fixture(t);
  bind(f.store);
  const before = f.store.load();
  await assert.rejects(f.work.dispatch(f.command, before.revision), hosted);
  const agent = new AgentWorkflow(f.root);
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      agent.dispatch({ action: 'accept', operationId: f.command.operationId, viewId: f.command.viewId }),
      hosted,
    );
  assert.equal(f.store.load().channelMoves.length, 0);
  assert.equal(f.store.select('lanes', f.lane.id).state, 'active');
  // Under server authority, checkpoints go through hosted (covered by hosted-agent-bound tests).
});

test('CLI work and agent accept return structured hosted authority errors', t => {
  const f = fixture(t);
  bind(f.store);
  const cli = resolve('dist/cli.js');
  for (const args of [
    ['work', f.root, JSON.stringify(f.command), String(f.store.revision())],
    ['agent', f.root, 'accept', JSON.stringify({ viewId: f.command.viewId })],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    hosted(JSON.parse(result.stderr.trim().split('\n').at(-1)).error);
  }
  assert.equal(f.store.load().channelMoves.length, 0);
});

test('MCP accept returns HOSTED_AUTHORITY without changing main', async t => {
  const f = fixture(t);
  bind(f.store);
  const handlers = new Map();
  registerAgentWorkflow(
    { registerTool: (name, _definition, handler) => handlers.set(name, handler) },
    f.root,
  );
  const response = await handlers.get('forge_task')({
    command: { action: 'accept', viewId: f.command.viewId },
  });
  assert.equal(response.isError, true);
  hosted(JSON.parse(response.content[0].text).error);
  assert.equal(f.store.load().channelMoves.length, 0);
});

test('native landing worker cannot accept a passing batch when the project becomes bound', async t => {
  const f = await batchFixture(t, { delay: 0 });
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { batchWindowMs: 0 },
  });
  await f.candidate('ready.txt');
  await assert.rejects(
    drainLandingBatches(f.work, 'main', undefined, async () => {
      bind(f.store, { acceptanceOwner: true, sourceAuthority: server });
    }),
    hosted,
  );
  const data = f.store.load();
  assert.equal(data.channelMoves.length, 0);
  assert.equal(
    data.landingEntries.some(entry => entry.status === 'accepted'),
    false,
  );
  assert.ok(data.runs.some(run => run.status === 'passed'));
  assert.ok(data.lanes.every(lane => lane.state === 'active'));
});
