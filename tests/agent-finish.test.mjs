import { cleanupOwner, waitForOwnerChildren } from './owner-cleanup.mjs';
import { processAlive } from '../dist/local-process.js';
import { trustAgents } from './autonomy-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { WorkService } from '../dist/work.js';
import { AgentWorkflow, agentActionSchema } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { PeersSource } from '../dist/agent-peers-source.js';
import { initNative } from '../dist/native-work.js';
import { ForgeError } from '../dist/errors.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const git = (root, args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
function fixture(native) {
  const root = mkdtempSync(join(tmpdir(), 'forge-agent-finish-'));
  writeFileSync(join(root, 'file.txt'), 'original\n');
  if (native) initNative(root);
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'initial']);
  }
  trustAgents(root);
  return root;
}
async function setup(
  native,
  args = [
    '-e',
    "if(require('fs').readFileSync('file.txt','utf8')!=='changed\\n')process.exit(1);console.log('checked')",
  ],
) {
  const root = fixture(native),
    agent = new AgentWorkflow(root),
    lane = (await agent.dispatch({ action: 'start', operationId: randomUUID(), outcome: 'Finish greeting' }))
      .result;
  writeFileSync(join(lane.path, 'file.txt'), 'changed\n');
  if (!native) git(lane.path, ['add', 'file.txt']);
  const check = (
    await agent.dispatch({
      action: 'define-check',
      name: 'Greeting check',
      executable: process.execPath,
      args,
    })
  ).result;
  const command = {
    action: 'finish',
    lockWaitMs: 0,
    operationId: randomUUID(),
    laneId: lane.laneId,
    expectedHead: lane.head,
    message: 'Greeting',
    checkId: check.checkId,
    expectedDefinition: check.definition,
  };
  return { root, agent, lane, check, command };
}
function readRunWhileStarting(store) {
  try {
    return store.load().runs[0];
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'SOURCE_CHANGED') return undefined;
    throw error;
  }
}
// Peers are a fresh, bounded observation; only the recorded finish receipt replays.
function canonicalReceipt({ peers: _peers, ...receipt }) {
  return receipt;
}
function pins(data) {
  return {
    checkpoints: data.lanes.flatMap(l => l.checkpoints).map(c => c.head),
    views: data.views.map(v => v.id),
    runs: data.runs.map(r => r.id),
    moves: data.channelMoves.map(m => m.id),
  };
}
for (const native of [true, false])
  test(`finish ${native ? 'native' : 'Git'} complete exact check, explicit acceptance, original replay`, async () => {
    const { root, agent, lane, check, command } = await setup(native);
    try {
      const request = { ...command, accept: { expectedPrevious: null } },
        receipt = (await agent.dispatch(request)).result;
      assert.equal(receipt.complete, true);
      assert.equal(receipt.phase, 'accept');
      assert.equal(receipt.status, 'accepted');
      assert.equal(receipt.view.head, receipt.checkpoint.head);
      assert.equal(receipt.run.head, receipt.view.head);
      assert.equal(receipt.run.checkDefinition, check.definition);
      assert.equal(receipt.run.runId, receipt.run.operationId);
      assert.equal(receipt.acceptance.acceptanceId, receipt.acceptance.operationId);
      assert.equal(receipt.acceptance.head, receipt.view.head);
      assert.equal(receipt.acceptance.channel, 'main');
      const originalPins = pins(agent.work.store.load());
      writeFileSync(join(lane.path, 'file.txt'), 'later live bytes\n');
      if (!native) git(lane.path, ['add', 'file.txt']);
      await agent.dispatch({
        action: 'define-check',
        checkId: check.checkId,
        name: 'Changed check',
        executable: process.execPath,
        args: ['-e', 'process.exit(1)'],
      });
      assert.deepEqual(
        canonicalReceipt((await new AgentWorkflow(root).dispatch(request)).result),
        canonicalReceipt(receipt),
      );
      assert.deepEqual(pins(agent.work.store.load()), originalPins);
      assert.equal(readFileSync(join(lane.path, 'file.txt'), 'utf8'), 'later live bytes\n');
      // A later Channel move does not replace the finish operation's original receipt.
      const later = (await agent.dispatch({ action: 'start', operationId: randomUUID(), outcome: 'Later' }))
        .result;
      writeFileSync(join(later.path, 'file.txt'), 'next\n');
      if (!native) git(later.path, ['add', 'file.txt']);
      const cp = (
        await agent.dispatch({
          action: 'checkpoint',
          operationId: randomUUID(),
          laneId: later.laneId,
          expectedHead: later.head,
          message: 'Next',
        })
      ).result;
      const view = (
        await agent.dispatch({
          action: 'compose',
          operationId: randomUUID(),
          intentId: later.intentId,
          inputs: [{ laneId: later.laneId, head: cp.head }],
        })
      ).result;
      // A person can explicitly accept; an unchecked new View cannot auto-accept.
      const person = new WorkService(root);
      await person.dispatch(
        {
          action: 'accept-channel',
          channel: 'main',
          operationId: randomUUID(),
          viewId: view.viewId,
          expectedHead: view.head,
          expectedPrevious: receipt.view.head,
        },
        person.store.revision(),
      );
      const replay = (await agent.dispatch(request)).result;
      const { peers: originalPeers, ...originalReceipt } = receipt;
      const { peers, ...replayedReceipt } = replay;
      assert.deepEqual(replayedReceipt, originalReceipt);
      assert.deepEqual(originalPeers, { clear: true });
      assert.equal(peers.landed[0].head, cp.head); // Advisory peers refresh; canonical operation pins replay.
    } finally {
      await cleanupOwner(root);
    }
  });
for (const native of [true, false])
  test(`finish ${native ? 'native' : 'Git'} failed check stays terminal and standalone acceptance remains available`, async () => {
    const { root, agent, check, command } = await setup(native, [
      '-e',
      'console.error("failed check");process.exit(7)',
    ]);
    try {
      const request = { ...command, accept: { expectedPrevious: null } },
        receipt = (await agent.dispatch(request)).result;
      assert.equal(receipt.terminal, true);
      assert.equal(receipt.complete, false);
      assert.equal(receipt.phase, 'check');
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.run.exitCode, 7);
      assert.equal(receipt.acceptance, null);
      assert.equal(agent.work.store.load().channelMoves.length, 0);
      await agent.dispatch({
        action: 'define-check',
        checkId: check.checkId,
        name: 'Now passes',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
      });
      assert.deepEqual(
        canonicalReceipt((await new AgentWorkflow(root).dispatch(request)).result),
        canonicalReceipt(receipt),
      );
      assert.equal(agent.work.store.load().runs.length, 1);
      await assert.rejects(
        agent.dispatch({ action: 'accept', viewId: receipt.view.viewId }),
        error => error.code === 'CHECK_REQUIRED',
      );
      await agent.dispatch({ action: 'run', viewId: receipt.view.viewId, checkId: check.checkId });
      const acceptance = (
        await agent.dispatch({
          action: 'accept',
          operationId: randomUUID(),
          viewId: receipt.view.viewId,
          expectedHead: receipt.view.head,
          expectedPrevious: null,
        })
      ).result;
      assert.equal(acceptance.status, 'accepted');
      assert.deepEqual(canonicalReceipt((await agent.dispatch(request)).result), canonicalReceipt(receipt));
    } finally {
      await cleanupOwner(root);
    }
  });
test('finish without explicit acceptance preserves capability and native operation needs no Git or index', async () => {
  const { root, agent, command } = await setup(true),
    previous = process.env.PATH;
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const marker = join(root, 'git-was-called');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 91\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${dirname(process.execPath)}`;
    const receipt = (await agent.dispatch(command)).result;
    assert.equal(receipt.phase, 'check');
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.acceptance, null);
    assert.equal(agent.work.store.load().channelMoves.length, 0);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(root, '.forge/index')), false);
  } finally {
    process.env.PATH = previous;
    await cleanupOwner(root);
  }
});
test('finish binds check, acceptance, environment and checkpoint inputs before writes', async () => {
  const { root, agent, lane, command } = await setup(true);
  try {
    // Omitted pins are resolved from current state (see agent-concurrency tests); malformed pins still fail.
    assert.equal(agentActionSchema.safeParse({ ...command, expectedDefinition: 'not-a-pin' }).success, false);
    const receipt = (await agent.dispatch(command)).result,
      bytes = readWorkBytes(join(agent.work.store.directory, 'work.json'));
    for (const changed of [
      { checkId: randomUUID() },
      { expectedDefinition: 'a'.repeat(64) },
      { expectedEnvironment: 'b'.repeat(64) },
      { accept: { expectedPrevious: null } },
      { message: 'Changed' },
      { expectedTree: 'c'.repeat(64) },
      { dependencies: [{ kind: 'view', viewId: randomUUID(), head: 'd'.repeat(64) }] },
    ]) {
      await assert.rejects(
        agent.dispatch({ ...command, ...changed }),
        e => e.code === 'WORK_OPERATION_CHANGED',
      );
      assert.deepEqual(readWorkBytes(join(agent.work.store.directory, 'work.json')), bytes);
    }
    await assert.rejects(
      agent.dispatch({
        action: 'checkpoint',
        operationId: command.operationId,
        laneId: lane.laneId,
        expectedHead: lane.head,
        message: command.message,
      }),
      e => e.code === 'WORK_OPERATION_CHANGED',
    );
    assert.deepEqual(canonicalReceipt((await agent.dispatch(command)).result), canonicalReceipt(receipt));
  } finally {
    await cleanupOwner(root);
  }
});
for (const native of [true, false])
  for (const phase of ['compose', 'run-check', 'accept-channel'])
    test(`finish ${native ? 'native' : 'Git'} reconciles unknown ${phase} reply without replacement`, async () => {
      const { root, agent, command } = await setup(native);
      try {
        const request = { ...command, accept: { expectedPrevious: null } },
          original = agent.work.dispatch.bind(agent.work);
        let interrupted = false;
        agent.work.dispatch = async (...args) => {
          const reply = await original(...args);
          if (args[0].action === phase && !interrupted) {
            interrupted = true;
            throw new Error('Unknown reply after recorded phase');
          }
          return reply;
        };
        await assert.rejects(agent.dispatch(request), /Unknown reply/);
        const before = pins(agent.work.store.load());
        const receipt = (await new AgentWorkflow(root).dispatch(request)).result;
        assert.equal(receipt.status, 'accepted');
        assert.equal(receipt.complete, true);
        const after = pins(agent.work.store.load());
        for (const key of Object.keys(before))
          assert.deepEqual(after[key].slice(0, before[key].length), before[key]);
        assert.equal(after.checkpoints.length, 1);
        assert.equal(after.views.length, 1);
        assert.equal(after.runs.length, 1);
        assert.equal(after.moves.length, 1);
        assert.deepEqual(
          canonicalReceipt((await new AgentWorkflow(root).dispatch(request)).result),
          canonicalReceipt(receipt),
        );
      } finally {
        await cleanupOwner(root);
      }
    });
test('finish reconciles unknown checkpoint reply and preserves full request binding', async () => {
  const { root, agent, command } = await setup(true);
  try {
    const original = agent.work.store.save.bind(agent.work.store);
    let interrupted = false;
    agent.work.store.save = data => {
      original(data);
      if (!interrupted && data.lanes[0].checkpoints.length) {
        interrupted = true;
        throw new Error('Unknown checkpoint reply');
      }
    };
    await assert.rejects(agent.dispatch(command), /Unknown checkpoint reply/);
    const head = agent.work.store.load().lanes[0].head;
    await assert.rejects(
      new AgentWorkflow(root).dispatch({ ...command, checkId: randomUUID() }),
      e => e.code === 'WORK_OPERATION_CHANGED',
    );
    const receipt = (await new AgentWorkflow(root).dispatch(command)).result;
    assert.equal(receipt.checkpoint.head, head);
    assert.equal(agent.work.store.load().lanes[0].checkpoints.length, 1);
    assert.equal(receipt.run.status, 'passed');
  } finally {
    await cleanupOwner(root);
  }
});
for (const native of [true, false])
  test(`finish ${native ? 'native' : 'Git'} stale reviewed source rejects before checkpoint or check`, async () => {
    const { root, agent, lane, command } = await setup(native);
    try {
      const expectedTree = native
        ? new NativeSource(root).tree(new NativeSource(root).capture(lane.path, true, lane.head))
        : git(lane.path, ['write-tree']);
      writeFileSync(join(lane.path, 'file.txt'), 'unreviewed\n');
      if (!native) git(lane.path, ['add', 'file.txt']);
      const before = readWorkBytes(join(agent.work.store.directory, 'work.json'));
      await assert.rejects(agent.dispatch({ ...command, expectedTree }), e => e.code === 'LANE_STALE');
      assert.deepEqual(readWorkBytes(join(agent.work.store.directory, 'work.json')), before);
      assert.equal(agent.work.store.load().runs.length, 0);
    } finally {
      await cleanupOwner(root);
    }
  });
test('terminal observe reads original run while another Work lock is live and leaves unrelated run untouched', async () => {
  const { root, agent, command } = await setup(true);
  try {
    const receipt = (await agent.dispatch(command)).result,
      store = agent.work.store;
    store.locked(() => {
      const data = store.load();
      data.runs.push({
        ...data.runs[0],
        id: randomUUID(),
        status: 'preparing',
        runner: { host: hostname(), pid: 2147483647 },
      });
      data.revision++;
      store.save(data);
    });
    const before = readWorkBytes(join(store.directory, 'work.json')),
      lock = join(store.directory, 'lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname() }));
    try {
      const observed = (await agent.dispatch({ action: 'observe', operationId: receipt.run.runId })).result;
      assert.equal(observed.status, 'passed');
      assert.equal(observed.runId, receipt.run.runId);
      assert.equal(store.load().runs[1].status, 'preparing');
      assert.deepEqual(readWorkBytes(join(store.directory, 'work.json')), before);
    } finally {
      unlinkSync(lock);
    }
  } finally {
    await cleanupOwner(root);
  }
});
test('finish bounded busy reconciliation keeps original phase IDs and never retries changed pins', async () => {
  const { root, agent, command } = await setup(true);
  try {
    const original = agent.work.dispatch.bind(agent.work),
      calls = [];
    let busy = 0;
    agent.work.dispatch = async (...args) => {
      calls.push(args[0]);
      if (args[0].action === 'compose' && busy++ < 2) throw new ForgeError('WORK_BUSY', 'Concurrent cleanup');
      return original(...args);
    };
    const result = (await agent.dispatch(command)).result;
    assert.equal(result.status, 'passed');
    const compose = calls.filter(c => c.action === 'compose');
    assert.equal(compose.length, 3);
    assert.deepEqual(compose[0], compose[1]);
    assert.deepEqual(compose[1], compose[2]);
    assert.equal(agent.work.store.load().views.length, 1);
    const cp = agent.work.store.load().lanes[0].checkpoints[0];
    assert.equal(cp.operation.id, command.operationId);
  } finally {
    await cleanupOwner(root);
  }
});
for (const native of [true, false])
  test(`finish ${native ? 'native' : 'Git'} conflict retains original composition and never runs or accepts`, async t => {
    const { root, agent, lane, command } = await setup(native);
    try {
      const other = (
          await agent.work.dispatch(
            { action: 'lane', intentId: lane.intentId, name: 'Dependency' },
            agent.work.store.load().revision,
          )
        ).result,
        path = agent.work.store.path(other.id);
      writeFileSync(join(path, 'file.txt'), 'dependency\n');
      if (!native) git(path, ['add', 'file.txt']);
      const cp = (
        await agent.dispatch({
          action: 'checkpoint',
          operationId: randomUUID(),
          laneId: other.id,
          expectedHead: other.head,
          message: 'Dependency',
        })
      ).result;
      const view = (
        await agent.dispatch({
          action: 'compose',
          operationId: randomUUID(),
          intentId: lane.intentId,
          inputs: [{ laneId: other.id, head: cp.head }],
        })
      ).result;
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [],
        dependencies: [{ kind: 'view', viewId: view.viewId, head: view.head }],
      });
      const request = {
          ...command,
          dependencies: [{ kind: 'view', viewId: view.viewId, head: view.head }],
          accept: { expectedPrevious: null },
        },
        receipt = (await agent.dispatch(request)).result;
      assert.equal(receipt.phase, 'compose');
      assert.equal(receipt.status, 'conflict');
      assert.equal(receipt.terminal, true);
      assert.equal(receipt.complete, false);
      assert.match(receipt.view.conflicts, /file.txt/);
      assert.equal(receipt.run, null);
      assert.equal(receipt.acceptance, null);
      assert.equal(agent.work.store.load().runs.length, 0);
      assert.equal(agent.work.store.load().channelMoves.length, 0);
      // A live source gap may change advisory peers, never original terminal evidence.
      const unavailable = t.mock.method(PeersSource.prototype, 'live', () => {
        throw new ForgeError('LANE_UNAVAILABLE', 'Synthetic unavailable peer source.');
      });
      let replay;
      try {
        replay = (await new AgentWorkflow(root).dispatch(request)).result;
      } finally {
        unavailable.mock.restore();
      }
      assert.equal(replay.peers.coverage, 'local-incomplete');
      assert.match(replay.peers.next, /peer source is unavailable/);
      assert.deepEqual(canonicalReceipt(replay), canonicalReceipt(receipt));
      assert.equal(readFileSync(join(lane.path, 'file.txt'), 'utf8'), 'changed\n');
    } finally {
      await cleanupOwner(root);
    }
  });
for (const native of [true, false])
  test(`finish ${native ? 'native' : 'Git'} cancellation remains original terminal evidence without acceptance`, async () => {
    const { root, agent, command } = await setup(native, ['-e', 'setTimeout(()=>process.exit(0),10000)']);
    try {
      const original = agent.work.dispatch.bind(agent.work);
      agent.work.dispatch = async (...args) => {
        const reply = await original(...args);
        if (args[0].action === 'run-check')
          await original(
            { action: 'cancel-check', operationId: args[0].operationId },
            agent.work.store.load().revision,
          );
        return reply;
      };
      const request = { ...command, accept: { expectedPrevious: null } },
        receipt = (await agent.dispatch(request)).result;
      assert.equal(receipt.status, 'cancelled');
      assert.equal(receipt.terminal, true);
      assert.equal(receipt.complete, false);
      assert.equal(receipt.acceptance, null);
      assert.equal(agent.work.store.load().channelMoves.length, 0);
      assert.deepEqual(
        canonicalReceipt((await new AgentWorkflow(root).dispatch(request)).result),
        canonicalReceipt(receipt),
      );
      assert.equal(agent.work.store.load().runs.length, 1);
    } finally {
      await cleanupOwner(root);
    }
  });
test('finish reconciles a phase under a real concurrent lock; a terminal parent replays without dispatching children', async () => {
  const { root, agent, command } = await setup(true);
  try {
    const original = agent.work.dispatch.bind(agent.work),
      lock = join(agent.work.store.directory, 'lock');
    let held = false;
    agent.work.dispatch = async (...args) => {
      const reply = await original(...args);
      if (args[0].action === 'compose' && !held) {
        held = true;
        writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname() }));
        setTimeout(() => unlinkSync(lock), 200);
        throw new ForgeError('WORK_BUSY', 'Lost reply during concurrent Work');
      }
      return reply;
    };
    const receipt = (await agent.dispatch(command)).result;
    assert.equal(receipt.status, 'passed');
    assert.equal(agent.work.store.load().views.length, 1);
    // A durable terminal receipt no longer needs any child owner to be available.
    const restarted = new AgentWorkflow(root),
      calls = [];
    restarted.work.dispatch = async command => {
      calls.push(command);
      throw new ForgeError('WORK_BUSY', 'Persistently busy');
    };
    assert.deepEqual(canonicalReceipt((await restarted.dispatch(command)).result), canonicalReceipt(receipt));
    assert.equal(calls.length, 0);
    assert.equal(agent.work.store.load().views.length, 1);
    assert.equal(agent.work.store.load().runs.length, 1);
  } finally {
    await cleanupOwner(root);
  }
});
async function dependency(agent, native) {
  const lane = (
    await agent.dispatch({ action: 'start', operationId: randomUUID(), outcome: 'Dependency source' })
  ).result;
  writeFileSync(join(lane.path, 'dependency.txt'), 'selected dependency\n');
  if (!native) git(lane.path, ['add', 'dependency.txt']);
  const cp = (
    await agent.dispatch({
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: lane.head,
      message: 'Dependency',
    })
  ).result;
  return (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: cp.head }],
    })
  ).result;
}
for (const native of [true, false])
  test(`finish ${native ? 'native' : 'Git'} checkpoint interruption cannot inherit later Intent dependencies`, async () => {
    const { root, agent, lane, command } = await setup(native);
    try {
      const dep = await dependency(agent, native),
        original = agent.work.dispatch.bind(agent.work);
      let interrupted = false;
      agent.work.dispatch = async (...args) => {
        if (args[0].action === 'compose' && !interrupted) {
          interrupted = true;
          throw new Error('Before compose');
        }
        return original(...args);
      };
      const request = { ...command, accept: { expectedPrevious: null } };
      await assert.rejects(agent.dispatch(request), /Before compose/);
      const checkpoint = agent.work.store.load().lanes.find(l => l.id === lane.laneId).head;
      const selected = [{ kind: 'view', viewId: dep.viewId, head: dep.head }];
      await original(
        {
          action: 'compose',
          operationId: randomUUID(),
          intentId: lane.intentId,
          inputs: [{ laneId: lane.laneId, head: checkpoint }],
          dependencies: selected,
        },
        agent.work.store.load().revision,
        { compact: true },
      );
      const receipt = (await new AgentWorkflow(root).dispatch(request)).result;
      assert.equal(receipt.status, 'accepted');
      assert.equal(receipt.view.head, checkpoint);
      const view = agent.work.store.load().views.find(v => v.id === receipt.view.viewId);
      assert.deepEqual(view.dependencies, []);
      const before = readWorkBytes(join(agent.work.store.directory, 'work.json'));
      await assert.rejects(
        new AgentWorkflow(root).dispatch({ ...request, dependencies: selected }),
        e => e.code === 'WORK_OPERATION_CHANGED',
      );
      assert.deepEqual(readWorkBytes(join(agent.work.store.directory, 'work.json')), before);
    } finally {
      await cleanupOwner(root);
    }
  });
for (const native of [true, false])
  test(`finish ${native ? 'native' : 'Git'} explicitly pinned dependencies compose and replay with original source`, async () => {
    const { root, agent, command } = await setup(native);
    try {
      const dep = await dependency(agent, native),
        request = {
          ...command,
          dependencies: [{ kind: 'view', viewId: dep.viewId, head: dep.head }],
          accept: { expectedPrevious: null },
        };
      const receipt = (await agent.dispatch(request)).result;
      assert.equal(receipt.status, 'accepted');
      assert.notEqual(receipt.view.head, receipt.checkpoint.head);
      assert.equal(receipt.view.dependencyCount, 1);
      assert.equal(receipt.run.head, receipt.view.head);
      if (native)
        assert.ok(
          new NativeSource(root).state(receipt.view.head).files.some(f => f.path === 'dependency.txt'),
        );
      else assert.equal(git(root, ['show', `${receipt.view.head}:dependency.txt`]), 'selected dependency');
      assert.deepEqual(
        canonicalReceipt((await new AgentWorkflow(root).dispatch(request)).result),
        canonicalReceipt(receipt),
      );
    } finally {
      await cleanupOwner(root);
    }
  });
test('finish checkpoint reconciles original parents and bounds fresh-operation contention', async () => {
  const { root, agent, command } = await setup(true);
  try {
    const receipt = (await agent.dispatch(command)).result,
      lock = join(agent.work.store.directory, 'lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname() }));
    // A replay may now finish before the simulated holder releases; wait for that release
    // so it cannot remove the second simulated lock below.
    const released = new Promise(resolve => setTimeout(() => resolve(unlinkSync(lock)), 200));
    assert.deepEqual(
      canonicalReceipt((await new AgentWorkflow(root).dispatch(command)).result),
      canonicalReceipt(receipt),
    );
    await released;
    assert.equal(agent.work.store.load().lanes[0].checkpoints.length, 1);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname() }));
    try {
      await assert.rejects(
        new AgentWorkflow(root).dispatch({ ...command, operationId: randomUUID() }),
        e => e.code === 'WORK_BUSY',
      );
    } finally {
      unlinkSync(lock);
    }
  } finally {
    await cleanupOwner(root);
  }
});

test('finish actual CLI and SDK MCP share original canonical receipts and discovery', async () => {
  const { root, lane, command } = await setup(true);
  const client = new Client({ name: 'finish-replay-test', version: '1' });
  try {
    const cli = join(process.cwd(), 'dist/cli.js'),
      request = { ...command, accept: { expectedPrevious: null } };
    const invoke = () =>
      JSON.parse(
        execFileSync(process.execPath, [cli, 'agent', root, 'finish', JSON.stringify(request)], {
          encoding: 'utf8',
        }),
      ).result;
    const receipt = invoke();
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.complete, true);
    assert.equal(receipt.terminal, true);
    assert.deepEqual(canonicalReceipt(invoke()), canonicalReceipt(receipt));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, 'mcp', root, '--agent'],
        stderr: 'pipe',
      }),
    );
    const tools = (await client.listTools()).tools,
      task = tools.find(t => t.name === 'forge_task');
    assert.match(JSON.stringify(task.inputSchema), /finish/);
    assert.equal(task.annotations.openWorldHint, true);
    const response = await client.callTool({ name: 'forge_task', arguments: { command: request } });
    assert.ok(!response.isError);
    assert.deepEqual(
      canonicalReceipt(JSON.parse(response.content[0].text).result),
      canonicalReceipt(receipt),
    );
    writeFileSync(join(lane.path, 'file.txt'), 'later dirty bytes\n');
    const changed = await client.callTool({
      name: 'forge_task',
      arguments: { command: { ...request, expectedDefinition: 'f'.repeat(64) } },
    });
    assert.equal(changed.isError, true);
    assert.equal(JSON.parse(changed.content[0].text).error.code, 'WORK_OPERATION_CHANGED');
    assert.equal(readFileSync(join(lane.path, 'file.txt'), 'utf8'), 'later dirty bytes\n');
  } finally {
    await client.close();
    await cleanupOwner(root);
  }
});

for (const native of [true, false])
  test(`finish ${native ? 'native' : 'Git'} restart preserves actual interrupted runner outcome without acceptance or reexecution`, async () => {
    const { root, agent, command } = await setup(native, [
      '-e',
      'console.log("begun");setTimeout(()=>process.exit(0),120000)',
    ]);
    let child, run;
    try {
      const request = { ...command, accept: { expectedPrevious: null } },
        cli = join(process.cwd(), 'dist/cli.js');
      child = spawn(process.execPath, [cli, 'agent', root, 'finish', JSON.stringify(request)], {
        stdio: 'ignore',
      });
      // Readiness follows the recorded spawn, with room for shared-machine contention.
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        run = readRunWhileStarting(agent.work.store);
        if (run?.status === 'running' && run.childPid) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(run?.status, 'running');
      assert.ok(run.runner.pid > 0 && run.runner.pid !== process.pid);
      assert.ok(run.childPid);
      // The managed owner may adopt after the submitting CLI exits on contention.
      // Kill the recorded runner, rather than assume the observer owns execution.
      if (run.runner.pid !== child.pid && processAlive(run.runner)) process.kill(run.runner.pid, 'SIGKILL');
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      while (processAlive(run.runner) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(processAlive(run.runner), false);
      // Stop this fixture's detached command after its owning runner died. No
      // completion writer survives, so the canonical owner records interruption.
      try {
        if (process.platform === 'win32') process.kill(run.childPid, 'SIGKILL');
        else process.kill(-run.childPid, 'SIGKILL');
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
      // The detached owner can still hold this finish lock while reconciling the dead runner.
      // Join it before this fixture explicitly restarts the workflow with zero lock patience.
      await waitForOwnerChildren(root);
      const receipt = (await new AgentWorkflow(root).dispatch(request)).result;
      assert.equal(receipt.status, 'interrupted');
      assert.equal(receipt.terminal, true);
      assert.equal(receipt.complete, false);
      assert.equal(receipt.run.runId, run.id);
      assert.equal(receipt.acceptance, null);
      assert.equal(agent.work.store.load().runs.length, 1);
      assert.equal(agent.work.store.load().channelMoves.length, 0);
      assert.deepEqual(
        canonicalReceipt((await new AgentWorkflow(root).dispatch(request)).result),
        canonicalReceipt(receipt),
      );
    } finally {
      if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
      if (run?.childPid) {
        try {
          if (process.platform === 'win32') process.kill(run.childPid, 'SIGKILL');
          else process.kill(-run.childPid, 'SIGKILL');
        } catch {}
      }
      await cleanupOwner(root);
    }
  });
for (const native of [true, false])
  for (const invalid of ['stale-check', 'unknown-check', 'stale-environment'])
    test(`finish ${native ? 'native' : 'Git'} first-use ${invalid} leaves source operation unreserved for correction`, async () => {
      const { root, agent, lane, command } = await setup(native);
      try {
        const before = readWorkBytes(join(agent.work.store.directory, 'work.json')),
          wrong =
            invalid === 'stale-check'
              ? { expectedDefinition: 'a'.repeat(64) }
              : invalid === 'unknown-check'
                ? { checkId: randomUUID() }
                : { expectedEnvironment: 'b'.repeat(64) };
        await assert.rejects(agent.dispatch({ ...command, ...wrong }), e => e.code === 'EVIDENCE_CHANGED');
        assert.deepEqual(readWorkBytes(join(agent.work.store.directory, 'work.json')), before);
        assert.deepEqual(pins(agent.work.store.load()), { checkpoints: [], views: [], runs: [], moves: [] });
        assert.equal(agent.work.store.load().lanes[0].head, lane.head);
        assert.equal(readFileSync(join(lane.path, 'file.txt'), 'utf8'), 'changed\n');
        const corrected = (await new AgentWorkflow(root).dispatch(command)).result;
        assert.equal(corrected.status, 'passed');
        assert.equal(corrected.complete, true);
        assert.equal(corrected.operationId, command.operationId);
        assert.equal(agent.work.store.load().lanes[0].checkpoints.length, 1);
        assert.equal(agent.work.store.load().views.length, 1);
        assert.equal(agent.work.store.load().runs.length, 1);
      } finally {
        await cleanupOwner(root);
      }
    });
for (const native of [true, false])
  test(`finish ${native ? 'native' : 'Git'} retained checkpoint bypasses preflight but canonical run rejects changed definitions`, async () => {
    const { root, agent, check, command } = await setup(native);
    try {
      const original = agent.work.dispatch.bind(agent.work);
      agent.work.dispatch = async (...args) => {
        if (args[0].action === 'compose') throw new Error('Before compose');
        return original(...args);
      };
      await assert.rejects(agent.dispatch(command), /Before compose/);
      const checkpoint = agent.work.store.load().lanes[0].head;
      await agent.dispatch({
        action: 'define-check',
        checkId: check.checkId,
        name: 'Changed before registration',
        executable: process.execPath,
        args: ['-e', 'process.exit(1)'],
      });
      await assert.rejects(new AgentWorkflow(root).dispatch(command), e => e.code === 'EVIDENCE_CHANGED');
      assert.equal(agent.work.store.load().lanes[0].head, checkpoint);
      assert.equal(agent.work.store.load().lanes[0].checkpoints.length, 1);
      assert.equal(agent.work.store.load().views.length, 1);
      assert.equal(agent.work.store.load().runs.length, 0);
    } finally {
      await cleanupOwner(root);
    }
  });
test('runner readiness poll retries only genuine SOURCE_CHANGED observations', () => {
  const ready = { status: 'running', childPid: 1 };
  let reads = 0;
  const store = {
    load() {
      if (reads++ === 0) throw new ForgeError('SOURCE_CHANGED', 'Concurrent atomic Work save');
      return { runs: [ready] };
    },
  };
  assert.equal(readRunWhileStarting(store), undefined);
  assert.equal(readRunWhileStarting(store), ready);
  assert.equal(reads, 2);
  for (const error of [
    new ForgeError('INVALID_WORK_STORE', 'Invalid metadata'),
    new Error('Unexpected read failure'),
    Object.assign(new Error('Untrusted error code'), { code: 'SOURCE_CHANGED' }),
  ])
    assert.throws(
      () =>
        readRunWhileStarting({
          load() {
            throw error;
          },
        }),
      caught => caught === error,
    );
});

test('finish reconciles a Work publication race before registering its exact check', async t => {
  const { root, agent, command } = await setup(true);
  t.after(() => cleanupOwner(root));
  const original = agent.work.dispatch.bind(agent.work);
  const registrations = [];
  const { workProgressIdentity } = await import('../dist/work-progress.js');
  const revision = agent.work.store.revision.bind(agent.work.store);
  let checkedRevision = false;
  agent.work.store.revision = () => {
    if (workProgressIdentity().phase === 'queued for check' && registrations.length < 2) {
      checkedRevision = true;
      assert.equal(existsSync(join(agent.work.store.directory, 'lock')), true);
    }
    return revision();
  };
  agent.work.dispatch = async (input, ...args) => {
    if (input.action === 'run-check') {
      registrations.push(structuredClone(input));
      if (registrations.length === 1)
        throw new ForgeError('SOURCE_CHANGED', 'Work pointer changed during phase revision read');
    }
    return original(input, ...args);
  };
  const receipt = (await agent.dispatch({ ...command, accept: true })).result;
  assert.equal(receipt.status, 'accepted');
  assert.equal(checkedRevision, true);
  assert.equal(registrations.length, 2);
  assert.deepEqual(registrations[0], registrations[1]);
  assert.equal(receipt.run.head, receipt.acceptance.head);
  const data = agent.work.store.load();
  assert.equal(data.runs.length, 1);
  assert.equal(data.channelMoves.length, 1);
});

test('finish returns a resumable result for a changed check observation and replays the pinned run', async t => {
  const { root, agent, command } = await setup(true);
  t.after(() => cleanupOwner(root));
  const store = agent.work.store,
    original = store.select.bind(store);
  let changed = false;
  store.select = (...args) => {
    const record = original(...args);
    if (args[0] === 'runs' && record?.status === 'passed' && !changed) {
      changed = true;
      throw new ForgeError('SOURCE_CHANGED', 'Work changed after the check completed');
    }
    return record;
  };
  const request = { ...command, accept: true };
  const stopped = (await agent.dispatch(request)).result;
  assert.equal(changed, true);
  assert.equal(stopped.status, 'source-changed');
  assert.equal(stopped.terminal, false);
  assert.equal(stopped.complete, false);
  assert.equal(stopped.code, 'SOURCE_CHANGED');
  assert.equal(store.load().channelMoves.length, 0);
  const receipt = (await agent.dispatch({ ...request, ...stopped.resolved })).result;
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.run.head, receipt.acceptance.head);
  assert.equal(store.load().runs.length, 1);
  assert.equal(store.load().channelMoves.length, 1);
});

test('finish submission remains stable through new saves and reports the original landed head as superseded', async t => {
  const { root, agent, lane, command } = await setup(true);
  t.after(() => cleanupOwner(root));
  const request = { ...command, keepOpen: true, accept: { expectedPrevious: null } };
  const landed = (await agent.dispatch(request)).result;
  const submission = landed.submissions[0];
  assert.equal(submission.state, 'landed');
  assert.equal(submission.attemptId, landed.attempts[0].operationId);
  writeFileSync(join(lane.path, 'file.txt'), 'new save\n');
  await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'New saved source' });
  const replay = (await agent.dispatch(request)).result;
  assert.equal(replay.submissions[0].submissionId, submission.submissionId);
  assert.equal(replay.submissions[0].head, submission.head);
  assert.equal(replay.submissions[0].state, 'superseded');
  assert.equal(replay.submissions[0].outcome, 'landed');
  assert.equal(replay.complete, false);
  assert.equal(agent.work.store.load().channelMoves.length, 1);
});
