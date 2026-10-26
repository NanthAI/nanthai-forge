// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { CoordinationJournal } from '../dist/agent-coordination-journal.js';
import { ForgeError } from '../dist/errors.js';
import { digest } from '../dist/hash.js';
import { land } from '../dist/land.js';
import { overlapRegions } from '../dist/agent-overlap-alerts.js';
import { batchEdit, enqueueLanding, selectBatch, composeBatch } from '../dist/landing-batch-store.js';
import { checkEnvironment } from '../dist/work-run.js';
import { savedOverlapPlan } from '../dist/agent-overlap-plan.js';
import { landingOverlap } from '../dist/landing-overlap.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { overlapNotifications } from '../dist/mcp-overlap-notifications.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { trustAgents } from './autonomy-fixture.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = '# Document\n\nShared paragraph.\nAnother paragraph.\n\nEnd.\n';
const docs = ['docs/one.md', 'docs/two.md'];
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-overlap-order-'));
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'src'));
  for (const path of docs) writeFileSync(join(root, path), base);
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  // Synthetic accepted bootstrap, as in predictive-overlap's fixture.
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: tx.data().nativeHead,
      previous: null,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    store.commitRecords(tx);
  });
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  await agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    checks: { runner: 'local' },
  });
  t.after(async () => {
    await drainPostAccept(store);
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  });
  const start = async (name, extra = {}) =>
    (
      await agent.dispatch({
        action: 'start',
        outcome: name,
        scope: { paths: docs },
        ...extra,
      })
    ).result;
  const save = async lane =>
    (
      await agent.dispatch({
        action: 'checkpoint',
        laneId: lane.laneId,
        message: 'Save incident edits',
      })
    ).result;
  const status = async lane =>
    (
      await agent.dispatch({
        action: 'status',
        laneId: lane.laneId,
        detail: true,
      })
    ).result;
  const journal = new CoordinationJournal(store);
  return { root, agent, store, start, save, status, journal };
}
function edit(lane, name, mode = 'insert', size = 1) {
  mkdirSync(join(lane.path, 'src'), { recursive: true });
  for (const path of docs)
    writeFileSync(
      join(lane.path, path),
      mode === 'insert'
        ? base.replace('Another paragraph.', `${name} addition.\nAnother paragraph.`)
        : base.replace('Shared paragraph.', `${name} rewrite.`),
    );
  writeFileSync(
    join(lane.path, `src/${name}.ts`),
    Array.from({ length: size }, (_, i) => `export const ${name}${i} = ${i};\n`).join(''),
  );
}
const evidence = (kind, value) => {
  if (process.env.FORGE_OVERLAP_EVIDENCE)
    appendFileSync(process.env.FORGE_OVERLAP_EVIDENCE, JSON.stringify({ kind, ...value }) + '\n');
};

test('planned scope is visible before saves; canonical alerts deduplicate heads and grow with regions', async t => {
  const f = await fixture(t),
    a = await f.start('Alpha'),
    b = await f.start('Beta');
  assert.equal(b.peers.overlaps.find(peer => peer.lane === a.laneId).claim, 'planned');
  assert.equal(f.journal.overlaps(a.laneId).length, 0);
  edit(a, 'alpha');
  edit(b, 'beta');
  await f.save(a);
  await f.save(b);
  const initial = f.journal.overlaps(a.laneId);
  assert.equal(initial.length, 2);
  assert.deepEqual(f.journal.overlaps(b.laneId), initial);
  await f.save(b);
  await f.status(a);
  await f.status(b);
  writeFileSync(join(b.path, 'src/beta.txt'), 'unrelated head change\n');
  await f.save(b);
  assert.equal(f.journal.overlaps(a.laneId).length, 2);
  for (const path of docs)
    writeFileSync(
      join(b.path, path),
      base
        .replace('Shared paragraph.', 'Beta rewrite.')
        .replace('Another paragraph.', 'beta addition.\nAnother paragraph.'),
    );
  await f.save(b);
  assert.equal(f.journal.overlaps(a.laneId).length, 4);
  assert.equal(new Set(f.journal.overlaps(a.laneId).map(item => item.noticeId)).size, 4);
  assert.equal(
    readdirSync(join(f.store.directory, 'coordination')).filter(name => name.startsWith('overlap-')).length,
    4,
  );
});

test('both Lanes get pending receipts once and retain historical peers/brief inbox; reads never write', async t => {
  const f = await fixture(t),
    a = await f.start('Alpha'),
    b = await f.start('Beta');
  edit(a, 'alpha');
  edit(b, 'beta');
  await f.save(a);
  const saved = await f.save(b);
  assert.ok(saved.peers.inbox.length);
  const delivered = new Map([[b.laneId, new Set(saved.peers.inbox.map(item => item.noticeId))]]);
  for (const lane of [a, b]) {
    const seen = delivered.get(lane.laneId) ?? new Set();
    for (const action of ['status', 'checkpoint', 'sync', 'brief', 'peers']) {
      const before = readdirSync(join(f.store.directory, 'coordination')).sort();
      const result = (
        await f.agent.dispatch({
          action,
          laneId: lane.laneId,
          ...(action === 'brief' ? { situation: 'continue-lane' } : {}),
          ...(action === 'checkpoint' ? { message: 'Unchanged' } : {}),
        })
      ).result;
      const historical = ['brief', 'peers'].includes(action);
      const inbox = (action === 'peers' ? result.inbox : result.peers.inbox) ?? [];
      if (historical) {
        assert.ok(
          inbox.some(item => item.lanes.includes(a.laneId) && item.lanes.includes(b.laneId)),
          action,
        );
      } else {
        assert.ok(
          inbox.every(item => !seen.has(item.noticeId)),
          `${action} repeats no delivered notice`,
        );
        if (action !== 'status') for (const item of inbox) seen.add(item.noticeId);
      }
      if (['status', 'brief', 'peers'].includes(action))
        assert.deepEqual(readdirSync(join(f.store.directory, 'coordination')).sort(), before);
      if (action === 'brief')
        assert.ok(result.context.messages.some(message => message.id === saved.peers.inbox[0].noticeId));
    }
    assert.equal(f.journal.pendingOverlaps(lane.laneId).length, 0);
    assert.equal(seen.size, f.journal.overlaps(lane.laneId).length);
  }
  const cli = spawnSync(
    process.execPath,
    [resolve('dist/cli.js'), 'agent', f.root, 'status', JSON.stringify({ laneId: a.laneId })],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).result.peers.inbox, undefined);
});

test('overlap notices and pending groups retain the latest handoff context together', async t => {
  const f = await fixture(t),
    a = await f.start('Alpha', { scope: { paths: [] } }),
    b = await f.start('Beta');
  edit(a, 'alpha');
  edit(b, 'beta');
  await f.save(a);
  await f.save(b);
  for (const summary of ['Earlier delivery', 'Current delivery'])
    await f.agent.dispatch({ action: 'handoff', laneId: a.laneId, summary });
  const peers = (await f.agent.dispatch({ action: 'peers', laneId: a.laneId, detail: true })).result;
  assert.equal(peers.handoff.summary, 'Current delivery');
  assert.ok(peers.inbox.some(item => item.lanes.includes(b.laneId)));
  const pending = readPendingStatus(f.store, undefined, undefined, { detail: true });
  assert.equal(pending.lanes.find(lane => lane.laneId === a.laneId).handoff.summary, 'Current delivery');
  assert.ok(
    pending.overlap.groups.some(group => group.order.includes(a.laneId) && group.order.includes(b.laneId)),
  );
  const text = formatPendingStatus(pending);
  assert.match(text, /Current delivery/);
  assert.match(text, /Overlap:.*land /);
  // Historical inbox and handoff remain readable even without any live scope.
  for (const path of docs) writeFileSync(join(a.path, path), base);
  rmSync(join(a.path, 'src/alpha.ts'));
  const pristine = (await f.agent.dispatch({ action: 'peers', laneId: a.laneId, detail: true })).result;
  assert.equal(pristine.handoff.operationId, peers.handoff.operationId);
  assert.deepEqual(pristine.inbox, peers.inbox);
});

test('event-driven MCP notifications target selected Lanes, deduplicate and stop on close', async t => {
  const f = await fixture(t),
    a = await f.start('Alpha'),
    b = await f.start('Beta');
  const sent = [];
  let capabilities;
  const notifications = overlapNotifications(
    {
      server: {
        registerCapabilities: value => {
          capabilities = value;
        },
      },
      sendLoggingMessage: async value => {
        sent.push(value);
      },
    },
    f.store,
  );
  t.after(() => notifications.close());
  notifications.select(a.laneId);
  assert.deepEqual(capabilities, { logging: {} });
  edit(a, 'alpha');
  edit(b, 'beta');
  await f.save(a);
  await f.save(b);
  for (let i = 0; i < 30 && sent.length < 2; i++) await pause(10);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(value => value.data.laneId === a.laneId));
  assert.ok(sent.every(value => value.data.regions === undefined && value.data.heads === undefined));
  await f.save(b);
  await pause(30);
  assert.equal(sent.length, 2);
  const idle = sent.length;
  await pause(50);
  assert.equal(sent.length, idle, 'idle creates no calls');
  notifications.close();
  notifications.select(b.laneId); // Closed transports ignore later selections.
  const closed = sent.length;
  for (const path of docs)
    writeFileSync(
      join(b.path, path),
      base
        .replace('Shared paragraph.', 'grow')
        .replace('Another paragraph.', 'beta addition.\nAnother paragraph.'),
    );
  await f.save(b);
  await pause(30);
  assert.equal(sent.length, closed);
});

test('pending groups and scheduler agree on ready/smaller ordering with stable ties', async t => {
  const f = await fixture(t),
    a = await f.start('Large'),
    b = await f.start('Small'),
    c = await f.start('Ready');
  edit(a, 'large', 'insert', 8);
  edit(b, 'small', 'insert', 1);
  edit(c, 'ready', 'insert', 4);
  for (const lane of [a, b, c]) await f.save(lane);
  await f.agent.dispatch({ action: 'complete', laneId: c.laneId });
  await f.agent.dispatch({ action: 'reopen', laneId: c.laneId });
  f.store.locked(() => {
    const data = f.store.load();
    data.lanes.find(lane => lane.id === c.laneId).state = 'ready';
    data.revision++;
    f.store.save(data);
  });
  const data = f.store.load(),
    plan = savedOverlapPlan(f.store, data.lanes);
  assert.deepEqual(plan.groups[0].order, [c.laneId, b.laneId, a.laneId]);
  const pending = readPendingStatus(f.store, undefined, undefined, { detail: true });
  assert.deepEqual(pending.overlap.groups, plan.groups);
  assert.match(
    formatPendingStatus(pending),
    new RegExp(`land ${c.laneId.slice(0, 8)} → ${b.laneId.slice(0, 8)} → ${a.laneId.slice(0, 8)}`),
  );
  const views = data.lanes.map(lane => ({
    id: lane.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  }));
  const entries = data.lanes.map(lane => ({ id: lane.id, viewId: lane.id }));
  assert.deepEqual(
    landingOverlap(f.store, { ...data, views }, entries).ordered.map(entry => entry.id),
    plan.order,
  );
});

for (let repeat = 1; repeat <= 5; repeat++)
  test(`four-agent incident replay ${repeat}: alerts on next action, ordered landing, disjoint batching, stable retry`, async t => {
    const f = await fixture(t),
      lanes = [];
    for (const name of ['R1', 'R4', 'R5', 'R7']) lanes.push(await f.start(name));
    for (const [index, lane] of lanes.entries()) {
      edit(lane, ['r1', 'r4', 'r5', 'r7'][index], 'insert', index + 1);
      const saved = await f.save(lane);
      for (const previous of lanes.slice(0, index)) {
        const next = await f.status(previous);
        assert.ok(
          next.peers.inbox.some(item => item.lanes.includes(lane.laneId)),
          'earlier agent sees peer save on next action',
        );
      }
      if (index) assert.ok(saved.peers.inbox.length, 'saving peer gets reciprocal alert');
      evidence('save', {
        repeat,
        lane: lane.laneId,
        inbox: saved.peers.inbox ?? [],
      });
    }
    assert.equal(f.journal.overlaps().length, 12);
    for (const lane of lanes) {
      await f.save(lane);
      await f.status(lane);
    }
    assert.equal(f.journal.overlaps().length, 12);
    const disjoint = [];
    for (const name of ['DisjointA', 'DisjointB']) {
      const lane = await f.start(name, {
        scope: { paths: [`src/${name}.ts`] },
      });
      mkdirSync(join(lane.path, 'src'), { recursive: true });
      writeFileSync(join(lane.path, `src/${name}.ts`), `export const value = '${name}';\n`);
      await f.save(lane);
      disjoint.push(lane);
    }
    const before = readPendingStatus(f.store, undefined, undefined, { detail: true });
    evidence('pending', { repeat, overlap: before.overlap });
    const command = {
      action: 'land',
      operationId: randomUUID(),
      laneIds: [...lanes]
        .reverse()
        .concat(disjoint)
        .map(lane => lane.laneId),
    };
    let result;
    for (let replay = 0; replay < 20; replay++) {
      const response = spawnSync(
        process.execPath,
        [resolve('dist/cli.js'), 'land', f.root, ...command.laneIds, '--operation-id', command.operationId],
        { encoding: 'utf8' },
      );
      assert.equal(response.status, 0, response.stderr);
      assert.doesNotMatch(response.stdout + response.stderr, /WORK_STALE/);
      result = JSON.parse(response.stdout).result;
      evidence('land', { repeat, replay, result });
      assert.equal(result.counts.conflict ?? 0, 0, JSON.stringify(result));
      if (result.terminal) break;
    }
    assert.deepEqual(result.counts, { accepted: 6 }, JSON.stringify(result));
    await drainPostAccept(f.store); // Join known audit writers before observing pending groups.
    const data = f.store.load(),
      moves = data.channelMoves.filter(
        move => move.status === 'accepted' && data.views.some(view => view.id === move.viewId),
      );
    assert.equal(moves.length, 4);
    assert.deepEqual(
      moves.map(move =>
        data.views
          .find(view => view.id === move.viewId)
          .inputs.filter(pin => lanes.some(lane => lane.laneId === pin.laneId))
          .map(pin => pin.laneId),
      ),
      lanes.map(lane => [lane.laneId]),
    );
    const entry = lane => result.entries.find(entry => entry.inputs.some(pin => pin.laneId === lane.laneId));
    assert.equal(entry(disjoint[0]).batchId, entry(disjoint[1]).batchId);
    assert.equal(new Set(lanes.map(lane => entry(lane).batchId)).size, 4);
    assert.deepEqual(
      readPendingStatus(f.store, undefined, undefined, { detail: true }).overlap.groups,
      [],
      'accepted Lanes leave pending overlap groups',
    );
    for (let i = 1; i < moves.length; i++) {
      const view = data.views.find(view => view.id === moves[i].viewId);
      assert.equal(view.composedMain, moves[i - 1].head, 'later check is on actual new main');
    }
    const source = new NativeSource(f.root),
      main = source.state(moves.at(-1).head);
    for (const path of docs) {
      const text = source.object(main.files.find(file => file.path === path).blob).toString();
      for (const name of ['r1', 'r4', 'r5', 'r7']) assert.ok(text.includes(`${name} addition.`));
    }
    const replay = (await f.agent.dispatch(command)).result;
    assert.deepEqual(replay.entries, result.entries);
    assert.equal(
      f.store.load().runs.filter(run => !run.mainCheck).length,
      data.runs.filter(run => !run.mainCheck).length,
    );
  });

test('genuine paragraph rewrites surface one named conflict after the compatible predecessors land', async t => {
  const f = await fixture(t),
    lanes = [];
  for (const [index, name] of ['r1', 'r4', 'r5', 'r7'].entries()) {
    const lane = await f.start(name);
    edit(lane, name, index < 2 ? 'insert' : 'rewrite', index + 1);
    await f.save(lane);
    lanes.push(lane);
  }
  const result = (
    await f.agent.dispatch({
      action: 'land',
      laneIds: lanes.map(lane => lane.laneId).reverse(),
    })
  ).result;
  evidence('genuine-conflict', { result });
  assert.deepEqual(result.counts, { accepted: 3, conflict: 1 });
  const conflict = result.entries.find(entry => entry.status === 'conflict');
  assert.ok(conflict.inputs.some(pin => pin.laneId === lanes[3].laneId));
  assert.match(conflict.conflict, new RegExp(lanes[2].laneId));
  assert.doesNotMatch(JSON.stringify(result), /WORK_STALE/);
});

test('finish with overlapping saved siblings splits them before composition and replays safely', async t => {
  const f = await fixture(t),
    a = await f.start('Alpha'),
    b = await f.start('Beta', { intentId: a.intentId });
  edit(a, 'alpha', 'insert', 1);
  edit(b, 'beta', 'insert', 2);
  await f.save(b);
  const command = {
    action: 'finish',
    operationId: randomUUID(),
    laneId: a.laneId,
    with: [b.laneId],
    message: 'Joint ordered finish',
    accept: true,
  };
  const result = (await f.agent.dispatch(command)).result;
  assert.equal(result.complete, true);
  assert.deepEqual(result.counts, { accepted: 2 });
  assert.equal(new Set(result.entries.map(entry => entry.runId)).size, 2);
  assert.deepEqual((await f.agent.dispatch(result.replay.command)).result.entries, result.entries);
  assert.deepEqual(
    (await f.agent.dispatch({ ...command, ...result.resolved })).result.entries,
    result.entries,
  );
});

test('separate overlapping regions and symbols keep independent notice identities', () => {
  const item = {
    lane: 'b',
    head: 'head',
    file: 'file',
    risk: 'high',
    reason: 'regions',
    mine: [
      { start: 10, lines: 2 },
      { start: 90, lines: 2 },
    ],
    peer: [
      { start: 12, lines: 1 },
      { start: 92, lines: 1 },
    ],
    first: 'a',
    orderReason: 'smaller',
  };
  const regions = overlapRegions(item);
  assert.equal(regions.length, 2);
  assert.deepEqual(regions[0].mine, [item.mine[0]]);
  assert.deepEqual(regions[1].peer, [item.peer[1]]);
  assert.deepEqual(
    overlapRegions({ ...item, symbols: ['One', 'Two'] }).map(region => region.symbols),
    [['One'], ['Two']],
  );
});

test('remote scheduler waits for high-overlap parent but speculates disjoint work without no-op Work writes', async t => {
  const f = await fixture(t),
    a = await f.start('First'),
    b = await f.start('Later'),
    d = await f.start('Disjoint');
  edit(a, 'first', 'insert', 1);
  edit(b, 'later', 'insert', 2);
  writeFileSync(join(d.path, 'disjoint.txt'), 'disjoint\n');
  for (const lane of [a, b, d]) await f.save(lane);
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    checks: { runner: 'modal' },
  });
  const enqueue = async lane => {
    const saved = f.store.select('lanes', lane.laneId),
      check = f.store.load().checks[0];
    const receipt = (
      await f.agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: lane.intentId,
        inputs: [{ laneId: lane.laneId, head: saved.head }],
      })
    ).result;
    return enqueueLanding(
      f.agent.work,
      {
        action: 'finish',
        operationId: randomUUID(),
        laneId: lane.laneId,
        expectedHead: saved.head,
        message: 'Synthetic',
        dependencies: [],
        checkId: check.id,
        expectedDefinition: check.definition,
        expectedEnvironment: checkEnvironment().fingerprint,
        accept: { channel: 'main', expectedPrevious: null },
        keepOpen: false,
      },
      f.store.select('views', receipt.viewId),
    );
  };
  const first = await enqueue(a);
  const parent = await batchEdit(f.agent.work, 'select', data => selectBatch(f.agent.work, data, 'main'));
  assert.deepEqual(parent.entryIds, [first.id]);
  await composeBatch(f.agent.work, parent);
  const later = await enqueue(b),
    revision = f.store.revision();
  const blocked = await batchEdit(f.agent.work, 'select', data =>
    selectBatch(f.agent.work, data, 'main', new Set([parent.id])),
  );
  assert.equal(blocked, undefined);
  assert.equal(f.store.revision(), revision, 'waiting on overlap does not invalidate prepared commits');
  const disjoint = await enqueue(d);
  const speculative = await batchEdit(f.agent.work, 'select', data =>
    selectBatch(f.agent.work, data, 'main', new Set([parent.id])),
  );
  assert.deepEqual(speculative.entryIds, [disjoint.id]);
  assert.equal(speculative.parentId, parent.id);
  assert.equal(f.store.select('landingEntries', later.id).status, 'queued');
});

test('overlapping finish preserves supervised review policy', async t => {
  const f = await fixture(t),
    a = await f.start('Alpha'),
    b = await f.start('Beta', { intentId: a.intentId });
  edit(a, 'alpha');
  edit(b, 'beta', 'insert', 2);
  await f.save(b);
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    preset: 'supervised',
  });
  const before = f.store.load().channelMoves.length;
  const result = (
    await f.agent.dispatch({
      action: 'finish',
      laneId: a.laneId,
      with: [b.laneId],
      message: 'Review ordered changes',
      accept: true,
    })
  ).result;
  assert.equal(result.status, 'awaiting-review');
  assert.equal(result.complete, false);
  assert.equal(f.store.load().channelMoves.length, before);
  assert.equal(result.counts['review-needed'], 2);
});

test('cancelling an ordered finish selection prevents acceptance after its check', async t => {
  const f = await fixture(t),
    a = await f.start('Alpha'),
    b = await f.start('Beta');
  edit(a, 'alpha');
  edit(b, 'beta', 'insert', 2);
  await f.save(a);
  await f.save(b);
  let cancelled = false;
  const dispatch = f.agent.work.dispatch.bind(f.agent.work);
  f.agent.work.dispatch = async (...args) => {
    const response = await dispatch(...args);
    if (args[0].action === 'run-check') cancelled = true;
    return response;
  };
  const before = f.store.load().channelMoves.length;
  const result = (
    await land(
      f.agent.work,
      {
        action: 'land',
        operationId: randomUUID(),
        laneIds: [a.laneId, b.laneId],
        channel: 'main',
      },
      undefined,
      () => cancelled,
    )
  ).result;
  assert.equal(result.complete, false);
  assert.equal(f.store.load().channelMoves.length, before);
  assert.equal(result.counts.cancelled, 2);
});

test('an unavailable saved peer cannot turn an incomplete alert scan into a clear receipt', async t => {
  const f = await fixture(t),
    peer = await f.start('Peer'),
    empty = await f.start('Empty', { scope: { paths: [] } });
  edit(peer, 'peer');
  await f.save(peer);
  const saved = f.store.select('lanes', peer.laneId),
    source = new NativeSource(f.root);
  rmSync(join(source.directory, saved.head));
  // Remove only this synthetic owner's disposable cache, so missing source is actually observed.
  rmSync(join(tmpdir(), `forge-peers-${process.getuid?.() ?? 'user'}`, digest(f.store.root)), {
    recursive: true,
    force: true,
  });
  const receipt = await f.save(empty);
  assert.equal(receipt.peers.coverage, 'local-incomplete');
  assert.equal(receipt.peers.clear, undefined);
});

test('documentation-only and batched Lanes share one order, including waiting predecessors', async t => {
  const f = await fixture(t),
    lanes = [];
  for (let i = 0; i < 4; i++) {
    const lane = await f.start(`Docs ${i}`);
    lanes.push(lane);
    for (const path of docs)
      writeFileSync(
        join(lane.path, path),
        base.replace('Another paragraph.', `${`docs-${i} addition.\n`.repeat(i + 1)}Another paragraph.`),
      );
    if (i === 1) writeFileSync(join(lane.path, 'mixed.ts'), 'export const mixed = true;\n');
    await f.save(lane);
  }
  const command = {
    action: 'land',
    operationId: randomUUID(),
    laneIds: lanes.map(lane => lane.laneId).reverse(),
  };
  const dispatch = f.agent.work.dispatch.bind(f.agent.work);
  let blocked = true,
    firstRun;
  f.agent.work.dispatch = async (input, ...args) => {
    if (input.action === 'run-check') firstRun ??= input.operationId;
    if (blocked && input.action === 'run-check' && input.operationId === firstRun)
      throw new ForgeError('WORK_BUSY', 'Synthetic first-check contention');
    return dispatch(input, ...args);
  };
  const waiting = (await f.agent.dispatch(command)).result;
  assert.equal(
    waiting.counts.accepted ?? 0,
    0,
    'a later overlapping docs Lane cannot overtake a waiting predecessor',
  );
  blocked = false;

  let result;
  for (let pass = 0; pass < 20; pass++) {
    result = (await f.agent.dispatch(command)).result;
    assert.doesNotMatch(JSON.stringify(result), /WORK_STALE/);
    if (result.terminal) break;
  }
  assert.deepEqual(result.counts, { accepted: 4 }, JSON.stringify(result));
  await drainPostAccept(f.store);
  const data = f.store.load(),
    moves = data.channelMoves.filter(
      move => move.status === 'accepted' && data.views.some(view => view.id === move.viewId),
    );
  assert.deepEqual(
    moves.map(move => data.views.find(view => view.id === move.viewId).inputs[0].laneId),
    lanes.map(lane => lane.laneId),
  );
  for (let i = 1; i < moves.length; i++)
    assert.equal(data.views.find(view => view.id === moves[i].viewId).composedMain, moves[i - 1].head);
});

test('finish with a genuine sibling rewrite reports the named peer in its compose conflict', async t => {
  const f = await fixture(t),
    a = await f.start('Alpha'),
    b = await f.start('Beta', { intentId: a.intentId });
  edit(a, 'alpha', 'rewrite', 1);
  edit(b, 'beta', 'rewrite', 2);
  await f.save(b);
  const result = (
    await f.agent.dispatch({
      action: 'finish',
      laneId: a.laneId,
      with: [b.laneId],
      message: 'Conflicting sibling changes',
      accept: true,
    })
  ).result;
  assert.equal(result.phase, 'compose');
  assert.equal(result.status, 'conflict');
  assert.equal(result.complete, false);
  assert.equal(result.view.inputs.length, 2);
  assert.ok(result.conflictingLanes.some(lane => lane.laneId === a.laneId));
  assert.equal(f.store.load().runs.length, 0);
  assert.equal(f.store.load().channelMoves.length, 1); // Only the synthetic bootstrap.
});

test('joint finish follows latest main before preflight when accepted edits were superseded', async t => {
  const f = await fixture(t),
    a = await f.start('Alpha'),
    b = await f.start('Beta', { intentId: a.intentId });
  edit(a, 'alpha', 'rewrite', 1);
  edit(b, 'beta', 'rewrite', 2);
  await f.save(a);
  await f.save(b);
  const landSaved = async (lane, keepOpen = false) => {
    const command = {
      action: 'land',
      operationId: randomUUID(),
      laneIds: [lane.laneId],
      keepOpen,
    };
    let result;
    for (let pass = 0; pass < 20; pass++) {
      result = (await f.agent.dispatch(command)).result;
      if (result.terminal) break;
    }
    assert.equal(result.complete, true, JSON.stringify(result));
    await drainPostAccept(f.store);
  };
  await landSaved(a, true);
  const current = await f.start('Supersede accepted text');
  edit(current, 'beta', 'rewrite', 2);
  await f.save(current);
  await landSaved(current);
  const main = f.store.load().channelMoves.at(-1).head;
  const result = (
    await f.agent.dispatch({
      action: 'finish',
      laneId: a.laneId,
      with: [b.laneId],
      message: 'Use current accepted main',
      accept: true,
    })
  ).result;
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.equal(result.sync.target, main);
});

test('ordered finish preserves an explicit zero retry budget', async t => {
  const f = await fixture(t),
    a = await f.start('Alpha'),
    b = await f.start('Beta', { intentId: a.intentId });
  edit(a, 'alpha');
  edit(b, 'beta', 'insert', 2);
  await f.save(b);
  const dispatch = f.agent.work.dispatch.bind(f.agent.work);
  let accepts = 0;
  f.agent.work.dispatch = async (input, ...args) => {
    if (input.action === 'accept-channel') {
      accepts++;
      throw new ForgeError('CHANNEL_CHANGED', 'Synthetic moved main');
    }
    return dispatch(input, ...args);
  };
  const result = (
    await f.agent.dispatch({
      action: 'finish',
      operationId: randomUUID(),
      laneId: a.laneId,
      with: [b.laneId],
      message: 'Preserve retry choice',
      maxRetries: 0,
      accept: true,
    })
  ).result;
  assert.equal(result.status, 'retry-exhausted');
  assert.equal(result.code, 'CHANNEL_CHANGED');
  assert.equal(result.phase, 'accept');
  assert.equal(result.complete, false);
  assert.equal(accepts, 1);
  assert.equal(f.store.load().channelMoves.length, 1);
  assert.equal(result.entries.filter(entry => entry.runId).length, 1);
  assert.equal(result.replay.command.maxRetries, 0);
  assert.equal(result.replay.command.operationId, result.operationId);
});
