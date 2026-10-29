import { cleanupOwner, waitForOwnerChildren } from './owner-cleanup.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { ForgeError } from '../dist/errors.js';
import { currentChannelHead } from '../dist/agent-defaults.js';
import { CheckQueue } from '../dist/check-queue.js';
import { landingDirectory } from '../dist/landing-queue.js';
import { withLandingSlot } from '../dist/landing-queue.js';
import { finishChild } from '../dist/agent-finish-journal.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { trustAgents } from './autonomy-fixture.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function mainCheckPassed(root) {
  try {
    return new WorkService(root)
      .status({ compact: true })
      .runs.some(run => run.mainCheck && run.status === 'passed');
  } catch (error) {
    if (['WORK_BUSY', 'SOURCE_CHANGED'].includes(error.code)) return false;
    throw error;
  }
}
// A background main audit atomically replaces work.json. Pin fixture reads under
// the owner lock rather than racing publication through readSource's path guard.
function snapshot(store) {
  return store.locked(() => store.load(), { waitMs: 60000 });
}
async function until(fn) {
  const end = Date.now() + 240000;
  while (!fn()) {
    assert.ok(Date.now() < end, 'Timed out waiting for fixture');
    await sleep(40);
  }
}
const git = (path, args) =>
  execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
async function fixture(t, native = true) {
  const root = mkdtempSync(join(tmpdir(), 'forge-landing-'));
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, 'b.txt'), 'b\n');
  if (native) initNative(root);
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'initial']);
  }
  trustAgents(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  const saved = { queue: process.env.FORGE_CHECK_QUEUE_DIR, limit: process.env.FORGE_MAX_CONCURRENT_CHECKS };
  process.env.FORGE_CHECK_QUEUE_DIR = join(store.directory, 'test-check-queue');
  process.env.FORGE_MAX_CONCURRENT_CHECKS = '4';
  async function background() {
    await drainPostAccept(store);
    await waitForOwnerChildren(root);
  }
  t.after(async () => {
    try {
      await background();
    } finally {
      for (const [key, value] of [
        ['FORGE_CHECK_QUEUE_DIR', saved.queue],
        ['FORGE_MAX_CONCURRENT_CHECKS', saved.limit],
      ])
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await cleanupOwner(root);
    }
  });
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  async function lane(path, text) {
    const lane = (await agent.dispatch({ action: 'start', outcome: `Edit ${path}` })).result;
    writeFileSync(join(lane.path, path), text);
    if (!native) git(lane.path, ['add', path]);
    return lane;
  }
  const request = lane => ({
    action: 'finish',
    operationId: randomUUID(),
    laneId: lane.laneId,
    expectedHead: lane.head,
    message: 'Land',
    accept: { expectedPrevious: null },
  });
  async function proposal(lane) {
    const cp = (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Propose' }))
      .result;
    return (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: cp.head }],
      })
    ).result;
  }
  async function personAccept(view, previous = currentChannelHead(store, 'main')) {
    const person = new WorkService(root);
    return person.dispatch(
      {
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: view.viewId,
        expectedHead: view.head,
        expectedPrevious: previous,
      },
      person.store.revision(),
    );
  }
  return { root, agent, store, lane, request, proposal, personAccept, background };
}
function unknownOnce(agent, predicate) {
  const dispatch = agent.work.dispatch.bind(agent.work);
  let lost = false;
  agent.work.dispatch = async (...args) => {
    const result = await dispatch(...args);
    if (!lost && predicate(args[0])) {
      lost = true;
      throw new Error('Lost child reply');
    }
    return result;
  };
}

for (const native of [true, false])
  test(`two genuinely concurrent ${native ? 'native' : 'Git'} finishes both land, re-check merged source and replay`, async t => {
    const f = await fixture(t, native),
      a = await f.lane('a.txt', 'A\n'),
      b = await f.lane('b.txt', 'B\n');
    const gate = join(f.store.directory, 'gate');
    await f.agent.dispatch({
      action: 'define-check',
      checkId: f.store.load().checks[0].id,
      name: 'verify',
      executable: process.execPath,
      args: [
        '-e',
        `const fs=require('fs'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer)}},25)`,
      ],
    });
    const ra = f.request(a),
      rb = f.request(b);
    const peer = new AgentWorkflow(f.root);
    for (const agent of [f.agent, peer]) {
      const dispatch = agent.work.dispatch.bind(agent.work);
      agent.work.dispatch = async (...args) => {
        if (args[0].action === 'run-check') {
          // Both the optimistic run and the CAS-race recheck must leave main free.
          const queue = new CheckQueue(landingDirectory(f.store, 'main'), { limit: 1 });
          try {
            assert.equal(queue.tryAcquire(), true, 'check held a Channel landing slot');
          } finally {
            queue.release();
          }
        }
        return dispatch(...args);
      };
    }
    const pa = f.agent.dispatch(ra),
      pb = peer.dispatch(rb);
    try {
      await until(() => snapshot(f.store).runs.filter(r => r.status === 'running').length === 2);
    } finally {
      writeFileSync(gate, 'go');
    }
    const [first, second] = (await Promise.all([pa, pb])).map(r => r.result);
    assert.equal(first.status, 'accepted');
    assert.equal(second.status, 'accepted');
    const retried = [first, second].find(r => r.attempts.length === 2);
    assert.ok(retried, 'The stale optimistic check must be retried');
    assert.equal(retried.attempts[0].error.code, 'CHANNEL_CHANGED');
    assert.equal(retried.attempts[1].sync.status, 'merged');
    assert.equal(retried.attempts[1].run.status, 'passed');
    assert.notEqual(retried.attempts[0].view.viewId, retried.attempts[1].view.viewId);
    assert.equal(f.store.load().runs.length, 3);
    const head = currentChannelHead(f.store, 'main');
    if (native) {
      const source = new NativeSource(f.root),
        files = source.state(head).files;
      for (const [path, text] of [
        ['a.txt', 'A\n'],
        ['b.txt', 'B\n'],
      ])
        assert.equal(source.object(files.find(f => f.path === path).blob).toString(), text);
      assert.ok(source.ancestors(head).has(first.acceptance.head));
      assert.ok(source.ancestors(head).has(second.acceptance.head));
    } else {
      assert.equal(git(f.root, ['show', `${head}:a.txt`]), 'A');
      assert.equal(git(f.root, ['show', `${head}:b.txt`]), 'B');
    }
    const before = f.store.load();
    for (const [request, receipt] of [
      [ra, first],
      [rb, second],
    ]) {
      const { resolved, ...original } = receipt;
      assert.deepEqual(
        (await new AgentWorkflow(f.root).dispatch({ ...request, ...resolved })).result,
        original,
      );
    }
    assert.equal(f.store.load().runs.length, before.runs.length);
    assert.equal(f.store.load().channelMoves.length, 2);
  });

test('a conflict during the automatic retry stops at sync and preserves both changes', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt', 'A\n'),
    b = await f.lane('a.txt', 'B\n');
  const rival = await f.proposal(a),
    request = f.request(b),
    dispatch = f.agent.work.dispatch.bind(f.agent.work);
  let moved = false;
  f.agent.work.dispatch = async (...args) => {
    if (args[0].action === 'accept-channel' && !moved) {
      moved = true;
      await f.personAccept(rival);
    }
    return dispatch(...args);
  };
  const receipt = (await f.agent.dispatch(request)).result;
  assert.equal(receipt.phase, 'sync');
  assert.equal(receipt.status, 'conflict');
  assert.equal(receipt.attempts.length, 2);
  assert.equal(receipt.attempts[0].run.status, 'passed');
  assert.equal(receipt.attempts[1].operations.sync, finishChild(request.operationId, 'sync', 1));
  assert.equal(f.store.load().runs.length, 1);
  assert.equal(currentChannelHead(f.store, 'main'), rival.head);
  assert.match(readFileSync(join(b.path, 'a.txt'), 'utf8'), /<<<<<<< lane\nB\n=======\nA\n>>>>>>> main/);
  const { resolved, ...original } = receipt;
  assert.deepEqual((await new AgentWorkflow(f.root).dispatch({ ...request, ...resolved })).result, original);
});

for (const maxRetries of [0, 1, undefined])
  test(`landing retry budget ${maxRetries ?? 'default 3'} is bounded and replay does not reset it`, async t => {
    const f = await fixture(t),
      lane = await f.lane('a.txt', 'A\n'),
      request = f.request(lane);
    if (maxRetries !== undefined) request.maxRetries = maxRetries;
    const dispatch = f.agent.work.dispatch.bind(f.agent.work);
    f.agent.work.dispatch = (...args) => {
      if (args[0].action === 'accept-channel')
        throw new ForgeError('CHANNEL_CHANGED', 'Injected external Channel move');
      return dispatch(...args);
    };
    const receipt = (await f.agent.dispatch(request)).result;
    assert.equal(receipt.status, 'retry-exhausted');
    assert.equal(receipt.complete, false);
    assert.equal(receipt.attempts.length, 1 + (maxRetries ?? 3));
    const ids = receipt.attempts.flatMap(a => Object.values(a.operations));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(f.store.load().runs.length, receipt.attempts.length);
    const { resolved, ...original } = receipt;
    assert.deepEqual(
      (await new AgentWorkflow(f.root).dispatch({ ...request, ...resolved })).result,
      original,
    );
    assert.equal(f.store.load().channelMoves.length, 0);
  });

test('a lost reply in a retry reconciles the same pinned attempt and child operations', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt', 'A\n'),
    b = await f.lane('b.txt', 'B\n'),
    rival = await f.proposal(a),
    request = f.request(b),
    dispatch = f.agent.work.dispatch.bind(f.agent.work);
  let moved = false;
  f.agent.work.dispatch = async (...args) => {
    if (args[0].action === 'accept-channel' && !moved) {
      moved = true;
      await f.personAccept(rival);
    }
    return dispatch(...args);
  };
  unknownOnce(f.agent, c => c.operationId === finishChild(request.operationId, 'accept', 1));
  await assert.rejects(f.agent.dispatch(request), /Lost child reply/);
  const before = f.store.load(),
    receipt = (await new AgentWorkflow(f.root).dispatch(request)).result;
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.attempts.length, 2);
  assert.equal(f.store.load().runs.length, before.runs.length);
  assert.equal(f.store.load().channelMoves.length, before.channelMoves.length);
});

test('waiting receipt shows position without consuming retries; other channels remain available', async t => {
  const f = await fixture(t),
    lane = await f.lane('a.txt', 'A\n');
  let release, entered;
  const ready = new Promise(resolve => {
    entered = resolve;
  });
  const holder = withLandingSlot(f.store, 'main', async () => {
    entered();
    await new Promise(resolve => {
      release = resolve;
    });
  });
  await ready;
  const request = { ...f.request(lane), waitMs: 0, maxRetries: 0 };
  let receipt;
  try {
    for (;;) {
      receipt = (await f.agent.dispatch({ ...request, ...receipt?.resolved })).result;
      if (receipt.status === 'waiting to land') break;
      assert.equal(receipt.terminal, false);
      await sleep(50);
    }
    assert.equal(receipt.position, 2);
    assert.equal(receipt.attempts.length, 1);
    assert.equal(receipt.landing.at(-1).status, 'waiting to land');
    assert.ok('value' in (await withLandingSlot(f.store, 'other', async () => true)));
  } finally {
    release();
    await holder;
  }
  const done = (await f.agent.dispatch({ ...request, ...receipt.resolved })).result;
  assert.equal(done.status, 'accepted');
  assert.equal(done.attempts.length, 1);
  assert.equal(done.landing[0].position, 2);
});

test('landing queue is FIFO across callers and reclaims a killed cross-process holder', async t => {
  const f = await fixture(t),
    module = new URL('../dist/landing-queue.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { withLandingSlot } from ${JSON.stringify(module)};
    await withLandingSlot({directory:${JSON.stringify(f.store.directory)}}, 'main', async () => {
      process.send('holding'); await new Promise(()=>setInterval(()=>{},1000));
    });`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await once(child, 'message');
  const order = [],
    positions = [];
  const a = withLandingSlot(
    f.store,
    'main',
    async () => {
      order.push('a');
      await sleep(100);
    },
    { observe: p => positions.push(['a', p.position]) },
  );
  const b = withLandingSlot(
    f.store,
    'main',
    async () => {
      order.push('b');
    },
    { observe: p => positions.push(['b', p.position]) },
  );
  await sleep(100);
  assert.deepEqual(order, []);
  child.kill('SIGKILL');
  await once(child, 'exit');
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);
  assert.ok(positions.some(([id, pos]) => id === 'a' && pos === 2));
  assert.ok(positions.some(([id, pos]) => id === 'b' && pos === 3));
});

test('supervised finish awaits review; person acceptance joins landing queue and never approves moved source', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt', 'A\n'),
    b = await f.lane('b.txt', 'B\n');
  const person = new WorkService(f.root);
  await person.dispatch(
    { action: 'set-policy', operationId: randomUUID(), preset: 'supervised' },
    person.store.revision(),
  );
  const waiting = (await f.agent.dispatch(f.request(b))).result;
  assert.equal(waiting.status, 'awaiting-review');
  assert.equal(waiting.readyToReview, true);
  const rival = await f.proposal(a);
  await f.personAccept(rival);
  let release, entered;
  const ready = new Promise(resolve => {
    entered = resolve;
  });
  const holder = withLandingSlot(f.store, 'main', async () => {
    entered();
    await new Promise(resolve => {
      release = resolve;
    });
  });
  await ready;
  let settled = false;
  const accepting = f.personAccept(waiting.view, null).finally(() => {
    settled = true;
  });
  const checked = assert.rejects(
    accepting,
    e => e.code === 'CHANNEL_CHANGED' && /main moved; re-check needed/.test(e.message),
  );
  await sleep(120);
  assert.equal(settled, false);
  release();
  await holder;
  await checked;
  assert.equal(currentChannelHead(f.store, 'main'), rival.head);
  assert.equal(f.store.load().runs.length, 1);
});

test('laneUpdates ask still stops an automatic retry without modifying Lane files', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt', 'A\n'),
    b = await f.lane('b.txt', 'B\n'),
    rival = await f.proposal(a),
    dispatch = f.agent.work.dispatch.bind(f.agent.work);
  let moved = false;
  f.agent.work.dispatch = async (...args) => {
    if (args[0].action === 'accept-channel' && !moved) {
      moved = true;
      await f.personAccept(rival);
      const person = new WorkService(f.root);
      await person.dispatch(
        { action: 'set-policy', operationId: randomUUID(), laneUpdates: 'ask' },
        person.store.revision(),
      );
    }
    return dispatch(...args);
  };
  const receipt = (await f.agent.dispatch(f.request(b))).result;
  assert.equal(receipt.status, 'sync-required');
  assert.equal(receipt.phase, 'sync');
  assert.equal(readFileSync(join(b.path, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(f.store.load().runs.length, 1);
});

test('a Channel race in a supervised finish reports review without creating an automatic retry', async t => {
  const f = await fixture(t),
    a = await f.lane('a.txt', 'A\n'),
    b = await f.lane('b.txt', 'B\n'),
    rival = await f.proposal(a),
    person = new WorkService(f.root);
  await person.dispatch(
    {
      action: 'set-policy',
      operationId: randomUUID(),
      preset: 'supervised',
      acceptance: { disjointFastPath: true },
    },
    person.store.revision(),
  );
  const dispatch = f.agent.work.dispatch.bind(f.agent.work);
  let moved = false;
  f.agent.work.dispatch = async (...args) => {
    if (args[0].action === 'accept-channel' && !moved) {
      moved = true;
      await f.personAccept(rival);
    }
    return dispatch(...args);
  };
  const receipt = (await f.agent.dispatch(f.request(b))).result;
  assert.equal(receipt.status, 'awaiting-review');
  assert.equal(receipt.readyToReview, true);
  assert.match(receipt.message, /main moved; re-check needed/);
  assert.equal(receipt.attempts.length, 1);
  assert.equal(f.store.load().runs.length, 1);
  assert.equal(currentChannelHead(f.store, 'main'), rival.head);
  assert.equal(readFileSync(join(b.path, 'a.txt'), 'utf8'), 'a\n');
});

test('native concurrent finishes fast-path a disjoint main race without a second Lane check', async t => {
  const f = await fixture(t, true);
  const seed = await f.lane('seed.txt', 'seed\n');
  const seedView = await f.proposal(seed);
  const base = (await f.personAccept(seedView)).result.head;
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { disjointFastPath: true },
  });
  const a = await f.lane('a.txt', 'A\n'),
    b = await f.lane('b.txt', 'B\n');
  const gate = join(f.store.directory, 'disjoint-gate');
  await f.agent.dispatch({
    action: 'define-check',
    checkId: f.store.load().checks[0].id,
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      `const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(t)},25)`,
    ],
  });
  const ra = { ...f.request(a), accept: { expectedPrevious: base } },
    rb = { ...f.request(b), accept: { expectedPrevious: base } };
  const peer = new AgentWorkflow(f.root),
    pa = f.agent.dispatch(ra),
    pb = peer.dispatch(rb);
  try {
    await until(() => snapshot(f.store).runs.filter(r => r.status === 'running').length === 2);
  } finally {
    writeFileSync(gate, 'go');
  }
  const results = (await Promise.all([pa, pb])).map(response => response.result);
  assert.ok(results.every(result => result.status === 'accepted' && result.attempts.length === 1));
  assert.equal(results.filter(result => result.acceptance.fastPath).length, 1);
  const main = currentChannelHead(f.store, 'main');
  assert.ok(new NativeSource(f.root).contains(main, results[0].view.head));
  assert.ok(new NativeSource(f.root).contains(main, results[1].view.head));
  assert.deepEqual((await peer.dispatch(rb)).result, results[1]);
  await f.background();
  assert.equal(mainCheckPassed(f.root), true);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 2);
});

test('finish reuses an already checked unchanged input after disjoint main moves', async t => {
  const f = await fixture(t, true);
  const seed = await f.lane('seed.txt', 'seed\n'),
    seedView = await f.proposal(seed);
  const base = (await f.personAccept(seedView)).result.head;
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { disjointFastPath: true },
  });
  const a = await f.lane('a.txt', 'A\n'),
    b = await f.lane('b.txt', 'B\n');
  const checked = (await f.agent.dispatch({ ...f.request(b), accept: undefined })).result;
  const proposal = await f.proposal(a);
  await f.personAccept(proposal, base);
  const before = f.store.load().runs.length;
  const landed = (
    await f.agent.dispatch({
      ...f.request(b),
      operationId: randomUUID(),
      expectedHead: checked.checkpoint.head,
      accept: true,
    })
  ).result;
  assert.equal(landed.status, 'accepted');
  assert.equal(landed.run.runId, checked.run.runId);
  assert.equal(landed.acceptance.fastPath.runId, checked.run.runId);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, before);
  await f.background();
  assert.equal(mainCheckPassed(f.root), true);
});

test('overlapping paths on a prior passing View use normal re-check even when text composes', async t => {
  const f = await fixture(t, true);
  const seed = await f.lane('a.txt', 'one\ntwo\nthree\n'),
    seedView = await f.proposal(seed);
  const base = (await f.personAccept(seedView)).result.head;
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { disjointFastPath: true },
  });
  const a = await f.lane('a.txt', 'ONE\ntwo\nthree\n'),
    b = await f.lane('a.txt', 'one\ntwo\nTHREE\n');
  const checked = (await f.agent.dispatch({ ...f.request(b), accept: undefined })).result;
  await f.personAccept(await f.proposal(a), base);
  const landed = (
    await f.agent.dispatch({
      ...f.request(b),
      operationId: randomUUID(),
      expectedHead: checked.checkpoint.head,
      accept: true,
    })
  ).result;
  assert.equal(landed.status, 'accepted');
  assert.equal(landed.attempts.length, 2);
  assert.equal(landed.acceptance.fastPath, undefined);
  assert.notEqual(landed.run.runId, checked.run.runId);
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 2);
});

test('fast-path finish automatically checks accepted main and creates one fix-forward handoff on red', async t => {
  const f = await fixture(t, true);
  const seed = await f.lane('seed.txt', 'seed\n');
  const base = (await f.personAccept(await f.proposal(seed))).result.head;
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { disjointFastPath: true },
  });
  await f.agent.dispatch({
    action: 'define-check',
    checkId: f.store.load().checks[0].id,
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      "const fs=require('fs');if(fs.readFileSync('a.txt','utf8')==='A\\n'&&fs.readFileSync('b.txt','utf8')==='B\\n'){console.error('combined main is red');process.exit(1)}",
    ],
  });
  const a = await f.lane('a.txt', 'A\n'),
    b = await f.lane('b.txt', 'B\n');
  const checked = (await f.agent.dispatch({ ...f.request(b), accept: undefined })).result;
  await f.personAccept(await f.proposal(a), base);
  const landed = (
    await f.agent.dispatch({ ...f.request(b), expectedHead: checked.checkpoint.head, accept: true })
  ).result;
  assert.equal(landed.status, 'accepted');
  assert.equal(landed.acceptance.fastPath.runId, checked.run.runId);
  // First observe the automatically started audit, then join its queue rather
  // than competing with its worker until the fix-forward publication finishes.
  await until(() => {
    // Immutable selected-record reads pin one manifest without joining writer
    // admission. Repeated synchronous writer locks can starve the detached
    // audit between selecting its View and registering its run.
    const tx = f.store.readRecords();
    try {
      return Array.from({ length: tx.manifest.collections.runs?.count ?? 0 }, (_, index) =>
        tx.at('runs', index),
      ).some(run => run.mainCheck);
    } finally {
      tx.dispose();
    }
  });
  await f.background();
  const data = snapshot(f.store),
    intent = data.intents.find(intent => intent.mainCheckFailure);
  const run = data.runs.find(run => run.id === intent.mainCheckFailure.runId);
  assert.notEqual(run.runner.pid, process.pid, 'The detached helper started the main audit.');
  assert.equal(run.status, 'failed');
  assert.equal(run.head, landed.acceptance.head);
  assert.equal(run.environment.env.FORGE_CHECK_FULL, '1');
  assert.match(run.failureSummary, /combined main is red/);
  assert.equal(currentChannelHead(f.store, 'main'), landed.acceptance.head);
  assert.equal(data.runs.filter(run => !run.mainCheck).length, 1);
  assert.equal(data.intents.filter(intent => intent.mainCheckFailure).length, 1);
  // Ordinary owner observations do not manufacture a second repair or move main.
  f.agent.work.status({ compact: true });
  assert.equal(snapshot(f.store).intents.filter(intent => intent.mainCheckFailure).length, 1);
});

for (const reason of ['definition', 'environment'])
  test(`finish re-checks a prior passing candidate after ${reason} changes`, async t => {
    const f = await fixture(t, true);
    const seed = await f.lane('seed.txt', 'seed\n');
    const base = (await f.personAccept(await f.proposal(seed))).result.head;
    await f.agent.dispatch({
      action: 'set-policy',
      operationId: randomUUID(),
      acceptance: { disjointFastPath: true },
    });
    const a = await f.lane('a.txt', 'A\n'),
      b = await f.lane('b.txt', 'B\n');
    const checked = (await f.agent.dispatch({ ...f.request(b), accept: undefined })).result;
    await f.personAccept(await f.proposal(a), base);
    if (reason === 'definition')
      await f.agent.dispatch({
        action: 'define-check',
        checkId: f.store.load().checks[0].id,
        name: 'verify',
        executable: process.execPath,
        args: ['-e', 'console.log("new definition")'],
      });
    const saved = process.env.FORGE_CHECK_FULL;
    if (reason === 'environment') process.env.FORGE_CHECK_FULL = saved === '1' ? '0' : '1';
    try {
      const landed = (
        await f.agent.dispatch({ ...f.request(b), expectedHead: checked.checkpoint.head, accept: true })
      ).result;
      assert.equal(landed.status, 'accepted');
      assert.equal(landed.acceptance.fastPath, undefined);
      assert.notEqual(landed.run.runId, checked.run.runId);
      assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 2);
    } finally {
      if (saved === undefined) delete process.env.FORGE_CHECK_FULL;
      else process.env.FORGE_CHECK_FULL = saved;
    }
  });

test('accepted-main audit pins its check and revision with selection before reserving the run', async t => {
  const f = await fixture(t, true);
  const lane = await f.lane('a.txt', 'accepted\n');
  await f.personAccept(await f.proposal(lane));
  // Queue a synthetic audit without launching the detached helper, so this
  // driver must cross the selection/reservation boundary itself.
  f.store.locked(() => {
    const data = f.store.load();
    data.channelMoves.at(-1).postAccept = {
      checkId: data.checks[0].id,
      mode: 'full',
      reason: 'disjoint-fast-path',
    };
    data.revision++;
    f.store.save(data);
  });
  const select = f.store.select.bind(f.store);
  f.store.select = (collection, id) => {
    if (collection !== 'checks') return select(collection, id);
    const read = fs.readSync;
    let armed = true;
    // Model another owner's finish publishing precisely during an unlocked
    // check lookup. A lookup already protected by the owner lock is safe.
    fs.readSync = function (...args) {
      const count = read.apply(this, args);
      const pointer = join(f.store.directory, 'work.json');
      if (
        armed &&
        count > 0 &&
        !fs.existsSync(join(f.store.directory, 'lock')) &&
        fs.fstatSync(args[0]).ino === fs.statSync(pointer).ino
      ) {
        armed = false;
        f.store.locked(() => {
          const data = f.store.load();
          data.revision++;
          f.store.save(data);
        });
      }
      return count;
    };
    syncBuiltinESMExports();
    try {
      return select(collection, id);
    } finally {
      fs.readSync = read;
      syncBuiltinESMExports();
    }
  };
  await drainPostAccept(f.store);
  const data = snapshot(f.store);
  assert.equal(data.runs.filter(run => run.mainCheck).length, 1);
  assert.equal(data.runs.find(run => run.mainCheck).status, 'passed');
  assert.equal(data.channelMoves.at(-1).postAcceptRunId, data.runs.find(run => run.mainCheck).id);
});
