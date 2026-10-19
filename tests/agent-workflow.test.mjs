import { trustAgents } from './autonomy-fixture.mjs';
// SPDX-License-Identifier: Apache-2.0
import { readWorkBytes } from './work-store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { NativeSource } from '../dist/native-source.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { WorkService } from '../dist/work.js';
import { workSchema } from '../dist/work-types.js';
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
function fixture(native, legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'forge-agent-workflow-'));
  writeFileSync(join(root, 'file.txt'), 'original\n');
  if (native) initNative(root);
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'initial']);
  }
  trustAgents(root);
  if (legacy) {
    const store = new WorkStore(root),
      data = store.load();
    delete data.autonomyPolicy;
    data.schema = 1;
    writeFileSync(join(store.directory, 'work.json'), JSON.stringify(data));
  }
  return root;
}
async function start(agent) {
  return (await agent.dispatch({ action: 'start', operationId: randomUUID(), outcome: 'Change greeting' }))
    .result;
}
async function editCheckpoint(agent, lane, text) {
  writeFileSync(join(lane.path, 'file.txt'), text);
  if (!agent.work.store.native) git(lane.path, ['add', 'file.txt']);
  return (
    await agent.dispatch({
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: lane.head,
      message: 'Greeting',
    })
  ).result;
}
for (const native of [true, false])
  test(`agent ${native ? 'native' : 'Git'} complete, replay, compact, checks and exact acceptance`, async () => {
    const root = fixture(native),
      agent = new AgentWorkflow(root);
    try {
      const startCommand = {
          action: 'start',
          operationId: randomUUID(),
          outcome: 'Change greeting',
          actor: 'codex-8',
          tool: 'codex',
        },
        lane = (await agent.dispatch(startCommand)).result;
      assert.deepEqual(lane.startedBy, { kind: 'agent', name: 'codex-8', tool: 'codex' });
      assert.deepEqual(
        (await agent.dispatch({ action: 'status' })).result.lanes.items[0].startedBy,
        lane.startedBy,
      );
      assert.equal(new WorkStore(root).load().schema, 11);
      assert.equal((await new AgentWorkflow(root).dispatch(startCommand)).result.laneId, lane.laneId);
      await assert.rejects(
        agent.dispatch({ ...startCommand, outcome: 'Different' }),
        error => error.code === 'WORK_OPERATION_CHANGED',
      );
      writeFileSync(join(lane.path, 'file.txt'), 'changed\n');
      if (!native) git(lane.path, ['add', 'file.txt']);
      const command = {
        action: 'checkpoint',
        operationId: randomUUID(),
        laneId: lane.laneId,
        expectedHead: lane.head,
        message: 'Greeting',
      };
      const cp = (await agent.dispatch(command)).result;
      assert.notEqual(cp.head, lane.head);
      const revision = new WorkStore(root).load().revision;
      assert.deepEqual((await new AgentWorkflow(root).dispatch(command)).result, cp);
      assert.equal(new WorkStore(root).load().revision, revision);
      await assert.rejects(
        agent.dispatch({ ...command, message: 'Changed message' }),
        error => error.code === 'WORK_OPERATION_CHANGED',
      );
      await assert.rejects(
        agent.dispatch({ ...command, operationId: randomUUID() }),
        error => error.code === 'LANE_STALE',
      );
      const composition = {
          action: 'compose',
          operationId: randomUUID(),
          intentId: lane.intentId,
          inputs: [{ laneId: lane.laneId, head: cp.head }],
        },
        view = (await agent.dispatch(composition)).result;
      assert.equal(view.head, cp.head);
      assert.ok(!('details' in view));
      assert.equal(view.reviewDeferred, true);
      assert.deepEqual((await agent.dispatch(composition)).result, view);
      const retained = new WorkStore(root).load().views.find(item => item.id === view.viewId);
      assert.ok(retained.details.length < 100);
      const full = await new WorkService(root).dispatch(
        {
          action: 'read-work-detail',
          kind: 'view',
          id: view.viewId,
          expectedHead: view.head,
          expectedBase: view.base,
          expectedStatus: 'clean',
        },
        new WorkStore(root).load().revision,
      );
      assert.match(full.result.view.details, /changed/);
      const review = await agent.dispatch({
        action: 'review',
        kind: 'view',
        id: view.viewId,
        expectedHead: view.head,
        expectedBase: view.base,
        expectedStatus: 'clean',
      });
      assert.equal(review.result.total, 1);
      const define = {
        action: 'define-check',
        name: 'Greeting check',
        executable: process.execPath,
        args: [
          '-e',
          "const fs=require('fs');if(fs.readFileSync('file.txt','utf8')!=='changed\\n')process.exit(1);console.log('checked')",
        ],
      };
      const check = (await agent.dispatch(define)).result;
      assert.deepEqual((await agent.dispatch(define)).result, check);
      assert.equal(new WorkStore(root).load().checks.length, 1);
      assert.ok(!('args' in check));
      const runCommand = {
        action: 'run',
        operationId: randomUUID(),
        viewId: view.viewId,
        expectedHead: view.head,
        checkId: check.checkId,
      };
      const run = (await agent.dispatch(runCommand)).result;
      assert.equal(run.status, 'passed');
      assert.equal(run.checkDefinition, check.definition);
      assert.equal(run.environmentFingerprint.length, 64);
      assert.ok(!('environment' in run));
      const log = (await agent.dispatch({ action: 'log', operationId: run.operationId })).result;
      assert.match(log.text, /checked/);
      assert.ok(!('base64' in log));
      assert.deepEqual((await agent.dispatch(runCommand)).result, run);
      assert.equal(new WorkStore(root).load().runs.length, 1);
      await agent.dispatch({ ...define, checkId: check.checkId, args: ['-e', 'process.exit(1)'] });
      assert.equal((await agent.dispatch(runCommand)).result.status, 'passed');
      await assert.rejects(
        agent.dispatch({ ...runCommand, expectedDefinition: 'a'.repeat(64) }),
        error => error.code === 'EVIDENCE_CHANGED',
      );
      const failed = (await agent.dispatch({ ...runCommand, operationId: randomUUID() })).result;
      assert.equal(failed.status, 'failed');
      const acceptance = {
        action: 'accept',
        actor: 'codex-acceptor',
        tool: 'codex',
        operationId: randomUUID(),
        viewId: view.viewId,
        expectedHead: view.head,
        expectedPrevious: null,
      };
      const accepted = (await agent.dispatch(acceptance)).result;
      assert.equal(accepted.status, 'accepted');
      assert.deepEqual(accepted.acceptedBy, { kind: 'agent', name: 'codex-acceptor', tool: 'codex' });
      assert.deepEqual((await agent.dispatch(acceptance)).result.acceptedBy, accepted.acceptedBy);
      const person = (
        await new WorkService(root).dispatch(
          {
            action: 'accept-channel',
            operationId: randomUUID(),
            channel: 'person',
            viewId: view.viewId,
            expectedHead: view.head,
            expectedPrevious: null,
          },
          agent.work.store.revision(),
        )
      ).result;
      assert.equal(person.acceptedBy.kind, 'person');
      assert.deepEqual(
        (await agent.dispatch({ action: 'records', collection: 'channelMoves' })).result.items.at(-1)
          .acceptedBy,
        person.acceptedBy,
      );
      assert.equal((await agent.dispatch(acceptance)).result.operationId, accepted.operationId);
      const next = await start(agent);
      assert.equal(next.base, view.head);
      assert.equal(next.baseChannel.acceptanceId, accepted.operationId);
      assert.equal((await agent.dispatch(startCommand)).result.head, lane.head);
      await assert.rejects(
        agent.dispatch({ ...acceptance, operationId: randomUUID() }),
        error => error.code === 'CHANNEL_CHANGED',
      );
      const status = (await agent.dispatch({ action: 'status', intentId: lane.intentId, limit: 1 })).result;
      assert.equal(status.runs.total, 2);
      assert.equal(status.runs.items.length, 1);
      assert.equal(status.runs.more, true);
      assert.ok(!('args' in status.checks.items[0]));
      const bytes = readWorkBytes(join(agent.work.store.directory, 'work.json'));
      workSchema.parse(JSON.parse(bytes));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
test('agent native stale live tree and unsafe source preserve originals', async () => {
  const root = fixture(true),
    agent = new AgentWorkflow(root);
  try {
    const lane = await start(agent);
    const before = readWorkBytes(join(agent.work.store.directory, 'work.json'));
    writeFileSync(join(lane.path, 'file.txt'), 'edited\n');
    await assert.rejects(
      agent.dispatch({
        action: 'checkpoint',
        operationId: randomUUID(),
        laneId: lane.laneId,
        expectedHead: lane.head,
        expectedTree: 'a'.repeat(64),
        message: 'wrong',
      }),
      error => error.code === 'LANE_STALE',
    );
    assert.deepEqual(readWorkBytes(join(agent.work.store.directory, 'work.json')), before);
    await assert.rejects(
      agent.dispatch({ action: 'start', operationId: randomUUID(), outcome: 'bad', channel: 'missing' }),
      error => error.code === 'CHANNEL_CHANGED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('agent resumes original journaled native start; partial source is retained', async () => {
  const root = fixture(true),
    agent = new AgentWorkflow(root);
  try {
    const command = { action: 'start', operationId: randomUUID(), outcome: 'Interrupted' },
      lane = (await agent.dispatch(command)).result;
    const store = agent.work.store;
    store.locked(() => {
      const data = store.load();
      data.lanes[0].state = 'creating';
      data.revision++;
      store.save(data);
    });
    rmSync(lane.path, { recursive: true });
    const resumed = (await new AgentWorkflow(root).dispatch(command)).result;
    assert.equal(resumed.laneId, lane.laneId);
    assert.ok(existsSync(lane.path));
    store.locked(() => {
      const data = store.load();
      data.lanes[0].state = 'creating';
      data.revision++;
      store.save(data);
    });
    writeFileSync(join(lane.path, 'file.txt'), 'partial');
    await assert.rejects(agent.dispatch(command), error => error.code === 'LANE_DIVERGED');
    assert.equal(readFileSync(join(lane.path, 'file.txt'), 'utf8'), 'partial');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('agent cancellation and unknown process outcome do not replay executable', async () => {
  const root = fixture(true),
    agent = new AgentWorkflow(root);
  try {
    const lane = await start(agent),
      cp = await editCheckpoint(agent, lane, 'changed\n'),
      view = (
        await agent.dispatch({
          action: 'compose',
          operationId: randomUUID(),
          intentId: lane.intentId,
          inputs: [{ laneId: lane.laneId, head: cp.head }],
        })
      ).result;
    const check = (
      await agent.dispatch({
        action: 'define-check',
        name: 'Long check',
        executable: process.execPath,
        args: ['-e', 'setTimeout(()=>process.exit(0),10000)'],
      })
    ).result;
    const command = {
      action: 'run',
      operationId: randomUUID(),
      viewId: view.viewId,
      expectedHead: view.head,
      checkId: check.checkId,
      wait: false,
    };
    const run = (await agent.dispatch(command)).result;
    assert.ok(['running', 'preparing'].includes(run.status));
    await agent.dispatch({ action: 'cancel', operationId: run.operationId });
    const cancelled = (
      await agent.dispatch({ action: 'observe', operationId: run.operationId, waitMs: 5000 })
    ).result;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await agent.dispatch(command)).result.status, 'cancelled');
    const store = agent.work.store;
    store.locked(() => {
      const data = store.load();
      const original = data.runs[0];
      data.runs.push({
        ...original,
        id: randomUUID(),
        status: 'preparing',
        runner: { pid: 2147483647, host: original.runner.host },
      });
      data.revision++;
      store.save(data);
    });
    const interrupted = store.load().runs.at(-1);
    assert.equal(
      (await agent.dispatch({ action: 'observe', operationId: interrupted.id })).result.status,
      'interrupted',
    );
    assert.equal(
      (await agent.dispatch({ ...command, operationId: interrupted.id })).result.status,
      'interrupted',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent compact native compose never reads source blobs for whole-file diff', async () => {
  const root = fixture(true),
    agent = new AgentWorkflow(root);
  try {
    const lane = await start(agent),
      cp = await editCheckpoint(agent, lane, 'changed\n');
    const source = new NativeSource(root),
      blobs = new Set(
        [...source.state(lane.head).files, ...source.state(cp.head).files].map(file => file.blob),
      );
    const original = NativeSource.prototype.object;
    NativeSource.prototype.object = function (id) {
      if (blobs.has(id)) throw Error('Whole-file source blob read');
      return original.call(this, id);
    };
    try {
      const result = await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: cp.head }],
      });
      assert.equal(result.result.head, cp.head);
    } finally {
      NativeSource.prototype.object = original;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('agent restart reconciles original pending Git checkpoint without new commit', async () => {
  const root = fixture(false),
    agent = new AgentWorkflow(root);
  try {
    const lane = await start(agent);
    writeFileSync(join(lane.path, 'file.txt'), 'changed\n');
    git(lane.path, ['add', 'file.txt']);
    const command = {
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: lane.head,
      message: 'Pending',
    };
    const cp = (await agent.dispatch(command)).result;
    git(lane.path, ['update-ref', `refs/heads/forge/lane/${lane.laneId}`, lane.head, cp.head]);
    agent.work.store.locked(() => {
      const data = agent.work.store.load();
      const item = data.lanes[0];
      item.pending = item.checkpoints.pop();
      item.head = lane.head;
      data.revision++;
      agent.work.store.save(data);
    });
    const replay = (await new AgentWorkflow(root).dispatch(command)).result;
    assert.equal(replay.head, cp.head);
    assert.equal(git(lane.path, ['rev-parse', 'HEAD']), cp.head);
    assert.equal(agent.work.store.load().lanes[0].checkpoints.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('agent schema promotion is explicit and optional declared inputs never downgrade', async () => {
  const root = fixture(true, true),
    agent = new AgentWorkflow(root);
  try {
    assert.equal(agent.work.store.load().schema, 1);
    await agent.dispatch({ action: 'status' });
    assert.equal(agent.work.store.load().schema, 1);
    await start(agent);
    await agent.dispatch({
      action: 'define-check',
      name: 'Declared',
      executable: process.execPath,
      args: [],
      declaredInputs: [{ kind: 'environment', name: 'TZ' }],
    });
    assert.equal(agent.work.store.load().schema, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent new Git checkpoint reconciles a different pending operation first', async () => {
  const root = fixture(false),
    agent = new AgentWorkflow(root);
  try {
    const lane = await start(agent);
    writeFileSync(join(lane.path, 'file.txt'), 'first\n');
    git(lane.path, ['add', 'file.txt']);
    const original = {
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: lane.head,
      message: 'Original first',
    };
    const first = (await agent.dispatch(original)).result;
    git(lane.path, ['update-ref', `refs/heads/forge/lane/${lane.laneId}`, lane.head, first.head]);
    agent.work.store.locked(() => {
      const data = agent.work.store.load();
      const item = data.lanes[0];
      item.pending = item.checkpoints.pop();
      item.head = lane.head;
      data.revision++;
      agent.work.store.save(data);
    });
    writeFileSync(join(lane.path, 'file.txt'), 'second\n');
    git(lane.path, ['add', 'file.txt']);
    const next = {
      action: 'checkpoint',
      operationId: randomUUID(),
      laneId: lane.laneId,
      expectedHead: lane.head,
      message: 'Second operation',
    };
    await assert.rejects(agent.dispatch(next), error => error.code === 'LANE_STALE');
    const recovered = agent.work.store.load().lanes[0];
    assert.equal(recovered.head, first.head);
    assert.equal(recovered.checkpoints[0].operation.id, original.operationId);
    assert.equal(recovered.pending, undefined);
    assert.equal(git(lane.path, ['rev-parse', 'HEAD']), first.head);
    assert.equal(readFileSync(join(lane.path, 'file.txt'), 'utf8'), 'second\n');
    assert.equal((await new AgentWorkflow(root).dispatch(original)).result.head, first.head);
    const second = (await agent.dispatch({ ...next, expectedHead: first.head })).result;
    assert.equal(second.parent, first.head);
    assert.equal(agent.work.store.load().lanes[0].checkpoints.length, 2);
    assert.equal((await agent.dispatch(original)).result.head, first.head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('agent native conflict composition returns retained useful conflict diagnostics', async () => {
  const root = fixture(true),
    agent = new AgentWorkflow(root);
  try {
    const left = await start(agent);
    const raw = await agent.work.dispatch(
      { action: 'lane', intentId: left.intentId, name: 'Second Lane' },
      agent.work.store.load().revision,
    );
    const right = {
      laneId: raw.result.id,
      path: agent.work.store.path(raw.result.id),
      head: raw.result.head,
    };
    const a = await editCheckpoint(agent, left, 'left\n'),
      b = await editCheckpoint(agent, right, 'right\n');
    const command = {
      action: 'compose',
      operationId: randomUUID(),
      intentId: left.intentId,
      inputs: [
        { laneId: left.laneId, head: a.head },
        { laneId: right.laneId, head: b.head },
      ],
    };
    const conflicted = (await agent.dispatch(command)).result;
    assert.equal(conflicted.status, 'conflict');
    assert.equal(conflicted.head, null);
    assert.match(conflicted.conflicts, /file.txt/);
    assert.equal(conflicted.conflictDetailsTruncated, false);
    assert.deepEqual((await new AgentWorkflow(root).dispatch(command)).result, conflicted);
    const retained = agent.work.store.load().views.find(view => view.id === conflicted.viewId);
    assert.match(retained.details, /file.txt/);
    assert.equal(readFileSync(join(left.path, 'file.txt'), 'utf8'), 'left\n');
    assert.equal(readFileSync(join(right.path, 'file.txt'), 'utf8'), 'right\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent check configuration rejects unsafe artifact paths without corrupting Work', async () => {
  const root = fixture(true),
    agent = new AgentWorkflow(root);
  try {
    const before = readWorkBytes(join(agent.work.store.directory, 'work.json'));
    for (const path of ['../outside', '.git/config', 'nested/.git/config', '/absolute']) {
      await assert.rejects(
        agent.dispatch({
          action: 'define-check',
          name: 'Unsafe artifact',
          executable: process.execPath,
          args: [],
          artifactPaths: [path],
        }),
        error => error.code === 'BAD_ARGUMENT',
      );
      assert.deepEqual(readWorkBytes(join(agent.work.store.directory, 'work.json')), before);
      assert.equal((await agent.dispatch({ action: 'status' })).result.checks.total, 0);
    }
    const check = (
      await agent.dispatch({
        action: 'define-check',
        name: 'Safe artifact',
        executable: process.execPath,
        args: [],
        artifactPaths: ['output/result.txt'],
      })
    ).result;
    assert.equal(agent.work.store.load().checks[0].id, check.checkId);
    assert.deepEqual(agent.work.store.load().checks[0].artifactPaths, ['output/result.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent default start preserves accepted Channel integrity; explicit workspace selection remains available', async () => {
  const root = fixture(false),
    agent = new AgentWorkflow(root);
  try {
    const lane = await start(agent),
      cp = await editCheckpoint(agent, lane, 'accepted\n');
    const view = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: cp.head }],
      })
    ).result;
    const check = (
      await agent.dispatch({
        action: 'define-check',
        name: 'verify',
        executable: process.execPath,
        args: ['-e', '0'],
      })
    ).result;
    await agent.dispatch({ action: 'run', viewId: view.viewId, checkId: check.checkId });
    const accepted = (
      await agent.dispatch({
        action: 'accept',
        operationId: randomUUID(),
        viewId: view.viewId,
        expectedHead: view.head,
        expectedPrevious: null,
      })
    ).result;
    git(root, ['update-ref', '-d', `refs/forge/channel-moves/${accepted.operationId}`]);
    const before = readWorkBytes(join(agent.work.store.directory, 'work.json'));
    await assert.rejects(
      agent.dispatch({ action: 'start', operationId: randomUUID(), outcome: 'Default accepted source' }),
      error => error.code === 'CHANNEL_CHANGED',
    );
    assert.deepEqual(readWorkBytes(join(agent.work.store.directory, 'work.json')), before);
    const selected = (
      await agent.dispatch({
        action: 'start',
        operationId: randomUUID(),
        outcome: 'Explicit checkout source',
        channel: null,
      })
    ).result;
    assert.equal(selected.head, git(root, ['rev-parse', 'HEAD']));
    assert.equal(selected.baseChannel, null);
    assert.notEqual(selected.head, view.head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
