// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { initNative } from '../dist/native-work.js';
import { ForgeError } from '../dist/errors.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { LandJournal } from '../dist/land-journal.js';
import { trustAgents } from './autonomy-fixture.mjs';

const git = (root, args) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();

const transientWaiting = result =>
  result.entries.some(
    entry => entry.status === 'waiting' && ['WORK_BUSY', 'SOURCE_CHANGED', 'WORK_STALE'].includes(entry.code),
  );

async function fixture(t, { batching = true, supervised = false, protectedPaths = [], native = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-land-'));
  writeFileSync(join(root, 'same.txt'), 'base\n');
  if (native) initNative(root);
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Fixture']);
  }
  if (!supervised) trustAgents(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', "process.exit(require('fs').existsSync('bad.txt') ? 1 : 0)"],
  });
  if (batching || protectedPaths.length)
    await agent.dispatch({
      action: 'set-policy',
      operationId: randomUUID(),
      ...(batching ? { checks: { runner: 'local' } } : {}),
      ...(protectedPaths.length ? { acceptance: { protectedPaths } } : {}),
    });
  t.after(async () => {
    if (native) await drainPostAccept(store);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  async function lane(path, { text = `${path}\n`, intentId, after } = {}) {
    const start = (
      await agent.dispatch({
        action: 'start',
        outcome: `Change ${path}`,
        ...(intentId ? { intentId } : {}),
        ...(after ? { after } : {}),
      })
    ).result;
    writeFileSync(join(start.path, path), text);
    if (!native) git(start.path, ['add', path]);
    const checkpoint = (
      await agent.dispatch({ action: 'checkpoint', laneId: start.laneId, message: 'Saved fixture' })
    ).result;
    return { ...start, head: checkpoint.head };
  }
  const land = async (lanes, options = {}) => {
    const { settleAll = false, ...request } = options;
    const command = {
      action: 'land',
      operationId: randomUUID(),
      laneIds: lanes.map(lane => lane.laneId),
      ...request,
    };
    let response;
    // Zero lock patience can legitimately report contention; reconcile exactly the same selection.
    for (let replay = 0; replay < 20; replay++) {
      response = await agent.dispatch(command);
      const pending = settleAll
        ? response.result.entries.some(entry => entry.status === 'waiting')
        : transientWaiting(response.result);
      if (!pending) return response;
    }
    return response;
  };
  function contents(path) {
    const move = store
      .load()
      .channelMoves.filter(move => move.channel === 'main' && move.status === 'accepted')
      .at(-1);
    if (!native) {
      try {
        return execFileSync('git', ['-C', root, 'show', `${move.head}:${path}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return undefined;
      }
    }
    const source = new NativeSource(root),
      file = move && source.state(move.head).files.find(file => file.path === path);
    return file ? source.object(file.blob).toString() : undefined;
  }
  return { root, agent, store, lane, land, contents };
}

test('cross-Intent saved Lanes share one combined check, acceptance and stable replay', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt'),
    b = await f.lane('b.txt');
  writeFileSync(join(b.path, 'b.txt'), 'unsaved sibling edit\n');
  const operationId = randomUUID(),
    result = (await f.land([a, b], { operationId })).result;
  assert.equal(result.complete, true);
  assert.deepEqual(result.counts, { accepted: 2 });
  assert.equal(result.entries[0].batchId, result.entries[1].batchId);
  assert.equal(result.entries[0].message, 'Change a.txt');
  assert.equal(f.contents('b.txt'), 'b.txt\n');
  assert.equal(readFileSync(join(b.path, 'b.txt'), 'utf8'), 'unsaved sibling edit\n');
  const data = f.store.load();
  assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
  assert.equal(data.channelMoves.length, 1);
  assert.deepEqual((await f.land([a, b], { operationId })).result.entries, result.entries);
  assert.equal(f.store.load().runs.length, data.runs.length);
  assert.equal(f.store.load().channelMoves.length, 1);
  assert.match(result.replay.shell, /nforge agent .* land/);
  await assert.rejects(f.land([a, b], { operationId, message: 'Changed request' }), {
    code: 'WORK_OPERATION_CHANGED',
  });
});

test('same-Intent inputs preserve joint Candidate semantics and leave unselected siblings alone', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt');
  const b = await f.lane('b.txt', { intentId: a.intentId }),
    c = await f.lane('c.txt', { intentId: a.intentId });
  writeFileSync(join(a.path, 'unsaved.txt'), 'unsaved\n');
  const result = (await f.land([a, b], { message: 'Joint change' })).result;
  assert.equal(result.entries.length, 1);
  assert.deepEqual(
    result.entries[0].inputs,
    [a, b].map(lane => ({ laneId: lane.laneId, head: lane.head })),
  );
  assert.equal(result.entries[0].message, 'Joint change');
  assert.equal(f.contents('unsaved.txt'), undefined);
  assert.equal(f.contents('c.txt'), undefined);
  assert.equal(f.store.select('lanes', c.laneId).state, 'active');
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
});

test('duplicate inputs are rejected before creating Candidates, checks or acceptances', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt'),
    before = f.store.load();
  await assert.rejects(f.land([a, a]), { code: 'BAD_ARGUMENT' });
  assert.equal(f.store.load().views.length, before.views.length);
  assert.equal(f.store.load().runs.length, 0);
  assert.equal(f.store.load().channelMoves.length, 0);
});

test('dependency waves land upstream before checking the dependent selection', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt');
  const b = await f.lane('b.txt', { after: { intentId: a.intentId } });
  const result = (await f.land([b, a])).result;
  assert.deepEqual(result.counts, { accepted: 2 });
  const data = f.store.load(),
    moves = data.channelMoves.filter(move => move.status === 'accepted');
  assert.equal(moves.length, 2);
  assert.ok(data.views.find(view => view.id === moves[0].viewId).inputs.some(pin => pin.laneId === a.laneId));
  assert.equal(f.contents('a.txt'), 'a.txt\n');
  assert.equal(f.contents('b.txt'), 'b.txt\n');
});

test('unselected dependencies wait without checking and replay after upstream lands', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt');
  const b = await f.lane('b.txt', { after: { intentId: a.intentId } });
  const operationId = randomUUID(),
    waiting = (await f.land([b], { operationId })).result;
  assert.deepEqual(waiting.counts, { waiting: 1 });
  assert.equal(waiting.terminal, false);
  assert.equal(f.store.load().runs.length, 0);
  await f.land([a]);
  assert.deepEqual((await f.land([b], { operationId })).result.counts, { accepted: 1 });
});

for (const batching of [true, false]) {
  test(`lost acceptance reply replays original pins without duplicate checks or acceptance (batching=${batching})`, async t => {
    const f = await fixture(t, { batching }),
      a = await f.lane('a.txt'),
      b = await f.lane('b.txt');
    const operationId = randomUUID(),
      dispatch = f.agent.work.dispatch.bind(f.agent.work);
    let lost = false;
    f.agent.work.dispatch = async (...args) => {
      const response = await dispatch(...args);
      if (args[0].action === 'accept-channel' && !lost) {
        lost = true;
        throw new Error('Synthetic lost reply');
      }
      return response;
    };
    await assert.rejects(f.land([a, b], { operationId }), /Synthetic lost reply/);
    const before = f.store.load();
    const savedSubmissions = readPendingStatus(f.store).lanes.flatMap(lane => lane.submissions);
    const selected = JSON.parse(
      readFileSync(join(f.store.directory, 'agent-land', `${operationId}.json`), 'utf8'),
    ).entries;
    assert.equal(before.channelMoves.length, 1);
    const result = (
      await new AgentWorkflow(f.root).dispatch({ action: 'land', operationId, laneIds: [a.laneId, b.laneId] })
    ).result;
    assert.deepEqual(result.counts, { accepted: 2 });
    const submissions = result.entries.flatMap(entry => entry.submissions);
    assert.equal(submissions.length, 2);
    assert.ok(submissions.every(item => item.state === 'landed'));
    for (const old of savedSubmissions)
      assert.ok(submissions.some(item => item.submissionId === old.submissionId));
    assert.deepEqual(
      result.entries.map(entry => entry.operationId),
      selected.map(entry => entry.command.operationId),
    );
    const data = f.store.load();
    assert.equal(data.runs.filter(run => !run.mainCheck).length, batching ? 1 : 2);
    assert.equal(data.channelMoves.length, batching ? 1 : 2);
  });
}

test('head changing after selection fails the pinned entry and preserves partial success', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt'),
    b = await f.lane('b.txt');
  const dispatch = f.agent.work.dispatch.bind(f.agent.work);
  let changed = false;
  f.agent.work.dispatch = async (...args) => {
    if (args[0].action === 'compose' && !changed) {
      changed = true;
      writeFileSync(join(a.path, 'a.txt'), 'new saved head\n');
      await f.agent.dispatch({ action: 'checkpoint', laneId: a.laneId, message: 'Later save' });
    }
    return dispatch(...args);
  };
  const result = (await f.land([a, b])).result;
  assert.deepEqual(result.counts, { failed: 1, accepted: 1 });
  assert.equal(result.entries[0].code, 'LANE_STALE');
  assert.equal(result.entries[0].inputs[0].head, a.head);
  assert.equal(f.contents('a.txt'), undefined);
  assert.equal(f.contents('b.txt'), 'b.txt\n');
});

for (const protectedInput of [false, true]) {
  test(`${protectedInput ? 'protected' : 'supervised'} saved inputs return review-needed without acceptance`, async t => {
    const f = await fixture(t, {
      supervised: !protectedInput,
      protectedPaths: protectedInput ? ['secret/**'] : [],
    });
    const path = protectedInput ? 'same.txt' : 'a.txt';
    if (protectedInput)
      await f.agent.dispatch({
        action: 'set-policy',
        operationId: randomUUID(),
        acceptance: { protectedPaths: ['same.txt'] },
      });
    const a = await f.lane(path, { text: 'changed\n' });
    const result = (await f.land([a])).result;
    assert.deepEqual(result.counts, { 'review-needed': 1 });
    assert.equal(result.terminal, false);
    assert.equal(result.complete, false);
    assert.equal(result.entries[0].submissions[0].state, 'pending');
    assert.equal(result.entries[0].submissions[0].pendingReason, 'waiting-for-review');
    assert.equal(f.store.load().channelMoves.length, 0);
    assert.equal(f.store.load().runs.length, 1);
    assert.equal(f.store.load().runs[0].status, 'passed');
  });
}

test('mixed eligible, protected and Markdown entries preserve policy and all accepted source', async t => {
  const f = await fixture(t, { protectedPaths: ['same.txt'] });
  const lanes = [
    await f.lane('a.txt'),
    await f.lane('same.txt', { text: 'protected edit\n' }),
    await f.lane('note.md'),
  ];
  // Every selected dependency is local to this fixture; replay finite waiting outcomes until settled.
  const result = (await f.land(lanes, { settleAll: true })).result;
  assert.deepEqual(result.counts, { accepted: 2, 'review-needed': 1 });
  assert.equal(f.contents('a.txt'), 'a.txt\n');
  assert.equal(f.contents('note.md'), 'note.md\n');
  assert.equal(f.contents('same.txt'), 'base\n');
});

test('batch failure and source conflict return per-entry outcomes and retain successful entries', async t => {
  const f = await fixture(t);
  const a = await f.lane('same.txt', { text: 'one\n' }),
    b = await f.lane('same.txt', { text: 'two\n' });
  const bad = await f.lane('bad.txt'),
    good = await f.lane('good.txt');
  const operationId = randomUUID(),
    result = (await f.land([a, b, bad, good], { operationId, settleAll: true })).result;
  assert.deepEqual(result.counts, { accepted: 2, conflict: 1, failed: 1 });
  assert.equal(f.contents('same.txt'), 'one\n');
  assert.equal(f.contents('good.txt'), 'good.txt\n');
  assert.equal(f.contents('bad.txt'), undefined);
  const before = f.store.load();
  await f.land([a, b, bad, good], { operationId });
  // Detached main audits may register between these snapshots. The replay
  // guarantee concerns the original landing checks and acceptance identities.
  assert.deepEqual(
    f.store
      .load()
      .runs.filter(run => !run.mainCheck)
      .map(run => run.id),
    before.runs.filter(run => !run.mainCheck).map(run => run.id),
  );
  assert.equal(f.store.load().channelMoves.length, before.channelMoves.length);
});

test('CLI prints replay identity before landing and accepts --message / --operation-id', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt'),
    b = await f.lane('b.txt'),
    operationId = randomUUID();
  const args = [
    resolve('dist/cli.js'),
    'land',
    f.root,
    a.laneId,
    b.laneId,
    '--message',
    'CLI selection',
    '--operation-id',
    operationId,
  ];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, new RegExp(`Replay: .*${operationId}`));
  let result = JSON.parse(first.stdout).result;
  for (let attempt = 0; transientWaiting(result) && attempt < 20; attempt++) {
    const resumed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(resumed.status, 0, resumed.stderr);
    result = JSON.parse(resumed.stdout).result;
  }
  assert.deepEqual(result.counts, { accepted: 2 });
  assert.equal(result.entries[0].message, 'CLI selection');
  const replay = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(f.store.load().channelMoves.length, 1);
});

test('MCP forge_task exposes the selected-Lane land action and aggregate result', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt'),
    b = await f.lane('b.txt'),
    tools = new Map();
  registerAgentWorkflow(
    {
      registerTool(name, options, handler) {
        tools.set(name, { options, handler });
      },
    },
    f.root,
  );
  const command = { action: 'land', operationId: randomUUID(), laneIds: [a.laneId, b.laneId] };
  const input = tools.get('forge_task').options.inputSchema.command.parse(command);
  let result;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await tools.get('forge_task').handler({ command: input });
    assert.equal(response.isError, undefined);
    result = JSON.parse(response.content[0].text).result;
    if (!transientWaiting(result)) break;
  }
  assert.deepEqual(result.counts, { accepted: 2 });
});

test('merging main as a base leaves unselected accepted keepOpen Lanes open', async t => {
  const f = await fixture(t),
    prior = await f.lane('prior.txt'),
    next = await f.lane('note.md');
  // Start both inputs before acceptance: lifecycle assertions do not depend on an audit releasing a start lock.
  await f.land([prior], { keepOpen: true });
  assert.equal(f.store.select('lanes', prior.laneId).state, 'active');
  assert.deepEqual((await f.land([next])).result.counts, { accepted: 1 });
  assert.equal(f.store.select('lanes', prior.laneId).state, 'active');
  assert.equal(f.store.select('lanes', next.laneId).state, 'completed');
});

test('Git saved-head selection composes main without staging or checkpointing unsaved edits', async t => {
  const f = await fixture(t, { native: false, batching: false });
  const a = await f.lane('a.txt'),
    b = await f.lane('b.txt');
  writeFileSync(join(b.path, 'b.txt'), 'unsaved Git edit\n');
  const result = (await f.land([a, b])).result;
  assert.deepEqual(result.counts, { accepted: 2 });
  assert.equal(f.contents('a.txt'), 'a.txt\n');
  assert.equal(f.contents('b.txt'), 'b.txt\n');
  assert.equal(readFileSync(join(b.path, 'b.txt'), 'utf8'), 'unsaved Git edit\n');
});

test('a Channel race retries a separately pinned composition and preserves both landings', async t => {
  const f = await fixture(t, { batching: false });
  const a = await f.lane('a.txt'),
    other = await f.lane('other.txt');
  const dispatch = f.agent.work.dispatch.bind(f.agent.work);
  let raced = false;
  f.agent.work.dispatch = async (...args) => {
    if (args[0].action === 'accept-channel' && !raced) {
      raced = true;
      await f.land([other]);
    }
    return dispatch(...args);
  };
  const operationId = randomUUID(),
    first = (await f.land([a], { operationId })).result;
  assert.deepEqual(first.counts, { waiting: 1 });
  assert.equal(first.entries[0].code, 'CHANNEL_CHANGED');
  const result = (await f.land([a], { operationId })).result;
  assert.deepEqual(result.counts, { accepted: 1 });
  assert.equal(f.contents('a.txt'), 'a.txt\n');
  assert.equal(f.contents('other.txt'), 'other.txt\n');
  assert.equal(f.store.load().channelMoves.length, 2);
  const before = f.store.load().runs.length;
  await f.land([a], { operationId });
  assert.equal(f.store.load().runs.length, before);
});

test('declared pinned Candidate dependencies survive selected-Lane landing', async t => {
  const f = await fixture(t),
    upstream = await f.lane('upstream.txt');
  const composed = (
    await f.agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: upstream.intentId,
      inputs: [{ laneId: upstream.laneId, head: upstream.head }],
    })
  ).result;
  const target = await f.lane('target.txt');
  const dependency = { kind: 'view', viewId: composed.viewId, head: composed.head };
  await f.agent.dispatch({
    action: 'compose',
    operationId: randomUUID(),
    intentId: target.intentId,
    inputs: [{ laneId: target.laneId, head: target.head }],
    dependencies: [dependency],
  });
  const result = (await f.land([target])).result;
  assert.deepEqual(result.counts, { accepted: 1 });
  const move = f.store.load().channelMoves.at(-1),
    view = f.store.select('views', move.viewId);
  assert.deepEqual(view.dependencies, [dependency]);
  assert.equal(f.contents('upstream.txt'), 'upstream.txt\n');
  assert.equal(f.contents('target.txt'), 'target.txt\n');
});

test('batch lock contention returns waiting and replays the same entry without duplicate checks', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt');
  const dispatch = f.agent.work.dispatch.bind(f.agent.work);
  let blocked = true;
  f.agent.work.dispatch = async (...args) => {
    if (blocked && args[0].action === 'run-check')
      throw new ForgeError('WORK_BUSY', 'Synthetic busy batch check');
    return dispatch(...args);
  };
  const command = { action: 'land', operationId: randomUUID(), laneIds: [a.laneId] };
  const waiting = (await f.agent.dispatch(command)).result;
  assert.deepEqual(waiting.counts, { waiting: 1 });
  assert.equal(waiting.entries[0].code, 'WORK_BUSY');
  assert.equal(waiting.terminal, false);
  assert.equal(f.store.load().channelMoves.length, 0);
  blocked = false;
  const result = (await f.agent.dispatch(command)).result;
  assert.deepEqual(result.counts, { accepted: 1 });
  await f.agent.dispatch(command);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
  assert.equal(f.store.load().channelMoves.length, 1);
});

for (const changed of ['unrelated metadata', 'Lane head', 'Intent base'])
  test(`land revalidates ${changed} without repeating the prepared source merge`, async t => {
    const f = await fixture(t),
      a = await f.lane('a.txt'),
      peer = new WorkStore(f.root),
      compose = NativeSource.prototype.compose;
    let merges = 0;
    t.mock.method(NativeSource.prototype, 'compose', function (...args) {
      const result = compose.apply(this, args);
      if (args[2] === 'Native review composition') {
        merges++;
        peer.locked(() => {
          const tx = peer.records();
          if (changed === 'Lane head') tx.patchFields('lanes', a.laneId, { head: a.base });
          else if (changed === 'Intent base') tx.patchFields('intents', a.intentId, { base: a.head });
          else tx.patchFields('lanes', a.laneId, { concurrentExtension: 'retained' });
          peer.commitRecords(tx);
        });
      }
      return result;
    });
    const operationId = randomUUID(),
      result = (await f.land([a], { operationId })).result;
    if (changed === 'unrelated metadata') {
      assert.deepEqual(result.counts, { accepted: 1 });
      assert.equal(f.contents('a.txt'), 'a.txt\n');
      assert.equal(f.store.select('lanes', a.laneId).concurrentExtension, 'retained');
      const before = f.store.load();
      assert.deepEqual((await f.land([a], { operationId })).result.entries, result.entries);
      assert.equal(f.store.load().runs.length, before.runs.length);
      assert.equal(f.store.load().channelMoves.length, 1);
    } else {
      assert.deepEqual(result.counts, { failed: 1 });
      assert.equal(result.entries[0].code, changed === 'Lane head' ? 'LANE_STALE' : 'COMPOSITION_STALE');
      assert.equal(f.store.load().views.length, 0);
      assert.equal(f.store.load().runs.length, 0);
      assert.equal(f.store.load().channelMoves.length, 0);
    }
    assert.equal(merges, 1, 'source-pinned publication does not re-merge for metadata contention');
  });

test('land reconciles transient source observation with the original phase operation', async t => {
  const f = await fixture(t, { batching: false }),
    a = await f.lane('a.txt'),
    dispatch = f.agent.work.dispatch.bind(f.agent.work),
    operations = [];
  f.agent.work.dispatch = async (...args) => {
    if (args[0].action === 'run-check') {
      operations.push(args[0].operationId);
      if (operations.length === 1) throw new ForgeError('SOURCE_CHANGED', 'Synthetic observation race');
    }
    return dispatch(...args);
  };
  const result = (await f.land([a])).result;
  assert.deepEqual(result.counts, { accepted: 1 });
  assert.equal(operations.length, 2);
  assert.equal(operations[0], operations[1]);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
  assert.equal(f.store.load().channelMoves.length, 1);
});

test('pending submission and attempt identities survive replay and later driver adoption', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt');
  const command = { action: 'land', operationId: randomUUID(), laneIds: [a.laneId], channel: 'main' };
  const journal = new LandJournal(f.store, command);
  const entry = journal.state.entries[0];
  const savedId = entry.command.operationId;
  const dispatch = f.agent.work.dispatch.bind(f.agent.work);
  f.agent.work.dispatch = async (...args) => {
    if (args[0].action === 'run-check') throw new ForgeError('WORK_BUSY', 'Synthetic queue wait');
    return dispatch(...args);
  };
  const pending = (await f.agent.dispatch(command)).result;
  const submission = pending.entries[0].submissions[0];
  assert.equal(pending.terminal, false);
  assert.equal(submission.state, 'pending');
  assert.equal(submission.pendingReason, 'checking');
  assert.ok(submission.attemptId);
  assert.equal(pending.entries[0].operationId, savedId);
  const status = readPendingStatus(f.store);
  assert.deepEqual(status.lanes[0].submission, submission);
  assert.match(formatPendingStatus(status), /pending \(checking\).*submission .*attempt/);
  const laneStatus = (await f.agent.dispatch({ action: 'status', laneId: a.laneId })).result.lane;
  assert.deepEqual(laneStatus.submissions, [submission]);
  f.agent.work.dispatch = dispatch;
  const landed = (await f.agent.dispatch(command)).result.entries[0].submissions[0];
  assert.equal(landed.state, 'landed');
  assert.equal(landed.submissionId, submission.submissionId);
  assert.equal(landed.attemptId, submission.attemptId);
  assert.deepEqual((await f.agent.dispatch(command)).result.entries[0].submissions[0], landed);
  await assert.rejects(f.agent.dispatch({ ...command, message: 'Changed payload' }), {
    code: 'WORK_OPERATION_CHANGED',
  });
});

test('a new saved head supersedes the old landed submission without changing its request or outcome', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt');
  const command = { action: 'land', operationId: randomUUID(), laneIds: [a.laneId], keepOpen: true };
  const before = (await f.agent.dispatch(command)).result.entries[0].submissions[0];
  await drainPostAccept(f.store);
  writeFileSync(join(a.path, 'a.txt'), 'new saved bytes\n');
  const saved = (await f.agent.dispatch({ action: 'checkpoint', laneId: a.laneId, message: 'New save' }))
    .result;
  assert.notEqual(saved.head, before.head);
  const replay = (await new AgentWorkflow(f.root).dispatch(command)).result;
  const old = replay.entries[0].submissions[0];
  assert.equal(old.submissionId, before.submissionId);
  assert.equal(old.head, before.head);
  assert.equal(old.state, 'superseded');
  assert.equal(old.outcome, 'landed');
  assert.equal(old.complete, false);
  assert.equal(replay.complete, false);
  assert.equal(f.store.load().channelMoves.length, 1);
  assert.equal(readPendingStatus(f.store).lanes[0].submission.state, 'superseded');
});

test('dependency waits expose the same submission before and after its first Candidate', async t => {
  const f = await fixture(t),
    parent = await f.lane('parent.txt');
  const child = await f.lane('child.txt', { after: { intentId: parent.intentId } });
  const command = { action: 'land', operationId: randomUUID(), laneIds: [child.laneId] };
  const pending = (await f.agent.dispatch(command)).result.entries[0].submissions[0];
  assert.equal(pending.state, 'pending');
  assert.equal(pending.pendingReason, 'waiting-for-dependency');
  assert.equal(pending.attemptId, null);
  assert.deepEqual(
    readPendingStatus(f.store).lanes.find(lane => lane.laneId === child.laneId).submission,
    pending,
  );
  await f.land([parent]);
  const landed = (await f.agent.dispatch(command)).result.entries[0].submissions[0];
  assert.equal(landed.submissionId, pending.submissionId);
  assert.equal(landed.state, 'landed');
});

test('conflict and check failure causes are visible in receipts and pending status without journal inspection', async t => {
  const f = await fixture(t),
    a = await f.lane('same.txt', { text: 'a\n' }),
    b = await f.lane('same.txt', { text: 'b\n' });
  const bad = await f.lane('bad.txt');
  const result = (await f.land([a, b, bad], { keepOpen: true, settleAll: true })).result;
  const submissions = result.entries.flatMap(entry => entry.submissions);
  assert.ok(submissions.some(item => item.state === 'terminal-failed' && item.cause === 'conflict'));
  assert.ok(submissions.some(item => item.state === 'terminal-failed' && item.cause === 'check-failed'));
  // Finish the detached audit before the fixture's intentional zero-wait status read.
  await drainPostAccept(f.store);
  const status = readPendingStatus(f.store);
  assert.ok(status.lanes.some(lane => lane.submission?.cause === 'conflict'));
  assert.ok(status.lanes.some(lane => lane.submission?.cause === 'check-failed'));
  assert.match(result.summary.join('\n'), /terminal-failed \(conflict\)/);
});
