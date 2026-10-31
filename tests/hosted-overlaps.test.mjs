// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture, api } from './hosted-saves-fixture.mjs';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { lifecycleFixture } from './hosted-lane-lifecycle-fixture.mjs';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import {
  hostedOverlapAdvice,
  mergeOverlapChanges,
  advanceOverlapMain,
  boundOverlapChanges,
} from '../dist/hosted-overlap.js';
import { hostedOverlapNotifications } from '../dist/mcp-hosted-overlaps.js';
import { overlapBanner } from '../dist/hosted-overlap-notice.js';
const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
const landed = await import(moduleUrl('../convex/projectHostedOverlapLanded.ts'));
const capabilities = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const acks = await import(moduleUrl('../convex/projectHostedOverlapAcks.ts'));
const deliveries = await import(moduleUrl('../convex/projectHostedOverlapDeliveries.ts'));
const oldFile = { blob: 'a'.repeat(64), mode: 'file' };
const newFile = { blob: 'b'.repeat(64), mode: 'file' };
const delta = path => ({ path, before: oldFile, after: newFile });
const code = expected => error => (error.data?.code ?? error.code) === expected;

async function setup(t) {
  const s = await saveFixture();
  const lane = JSON.parse(
    [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane').value,
  );
  const peer = { ...lane, id: randomUUID(), intentId: randomUUID() };
  const identity = { projectId: s.projectId, actor: 'owner', authorityEpoch: 1 };
  await s.transaction(
    'peer',
    {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          ...identity,
          expectedVersion: null,
          record: peer,
          overlap: { baseSequence: 0, intent: 'Peer change' },
        }),
    },
    {},
  );
  await s.transaction(
    'base',
    {
      _handler: ctx =>
        tracking.trackHostedOverlapLane(ctx, s.projectId, lane, { baseSequence: 0, intent: 'My change' }),
    },
    {},
  );
  const main = {
    schema: 2,
    projectId: s.projectId,
    snapshotId: 'seed',
    sourceRevision: 0,
    channel: 'main',
    head: lane.head,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: 'main-0', kind: 'server', previousHead: null, previousReceiptId: null },
  };
  const channel = s.insert('projectHostedChannels', {
    projectId: s.projectId,
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify(main),
  });
  const directory = mkdtempSync(join(tmpdir(), 'forge-hosted-overlap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = entry => {
    const root = join(directory, entry.id);
    mkdirSync(join(root, '.forge'), { recursive: true });
    writeFileSync(join(root, 'a.txt'), entry.id === lane.id ? 'my edit' : 'peer edit');
    writeFileSync(
      join(root, '.forge/hosted-lane.json'),
      JSON.stringify({
        schema: 1,
        kind: 'forge-hosted-lane-checkout',
        url: 'https://fixture.invalid',
        operationId: randomUUID(),
        selection: {
          schema: 2,
          projectId: s.projectId,
          laneId: entry.id,
          intentId: entry.intentId,
          head: entry.head,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: 'active',
          base: entry.base,
          authority: main.authority,
        },
        state: s.state,
        scope: ['a.txt'],
        materialized: ['a.txt'],
      }),
    );
    return root;
  };
  const exchange = {
    projectId: s.projectId,
    async missing(pins) {
      return pins.filter(pin => !s.objects.has(pin.sha256)).map(pin => pin.sha256);
    },
    async uploadLazyBatch(objects) {
      for (const object of objects) s.put(await object.read());
      return { uploadedObjects: 0, uploadedBytes: 0 };
    },
    async upload(pin, bytes) {
      s.put(bytes);
      return { uploadedObjects: 0, uploadedBytes: 0 };
    },
    async uploadFile() {
      assert.fail('small fixture uses batched upload');
    },
    client: {
      async query(ref, args) {
        const name = getFunctionName(ref);
        if (name === 'projectHostedAgent:capabilities')
          return s.transaction(name, capabilities.capabilities, args);
        if (name === 'projectHostedOverlaps:read') return s.transaction(name, overlaps.read, args);
        if (name === 'projectHostedSaves:progress') return s.call('progress', api.progress, args);
        if (name === 'projectHostedLanes:head') {
          const row = [...s.tables.projectHostedOverlapLanes.values()].find(
            row => row.laneId === args.laneId,
          );
          return { head: row.head, version: 1, sourceVersion: 1, lifecycleVersion: 0 };
        }
        assert.fail(name);
      },
      async mutation(ref, args) {
        const name = getFunctionName(ref);
        if (name === 'projectObjectDownloads:describe')
          return args.digests.map(id => ({ digest: id, size: s.objects.get(id).length, location: 'r2' }));
        if (name === 'projectHostedOverlapDeliveries:record')
          return s.transaction(name, deliveries.record, args);
        if (name === 'projectHostedOverlapAcks:append') return s.transaction(name, acks.append, args);
        if (name === 'projectHostedSaves:prepare') return s.call('prepare', api.prepare, args);
        if (name === 'projectHostedSaves:stage') return s.call('stage', api.stage, args);
        if (name === 'projectHostedSaveJobs:submit') {
          const x = { request: { operationId: args.operationId } };
          const pending = await s.submit(x);
          if (pending.outcome) return JSON.stringify(pending);
          return JSON.stringify(await s.publish(await s.work(x)));
        }
        assert.fail(name);
      },
    },
  };
  const address = { url: 'https://fixture.invalid', projectId: s.projectId };
  return {
    s,
    lane,
    peer,
    channel,
    main,
    exchange,
    transport: entry => new HostedAgentTransport(root(entry), address, exchange),
  };
}

/** Save path changes on a Lane's record. A Lane with none cannot overlap and is read without its peers. */
const trackChange = (s, lane, paths = [delta('a.txt')], intent = 'My change') =>
  s.transaction(
    'track-change',
    {
      _handler: async ctx => {
        const row = await records.readHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          kind: 'lane',
          key: lane.id,
        });
        const current = JSON.parse(row.value);
        await records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: current.version,
          record: {
            ...current,
            head: String(current.version + 1).padStart(64, 'e'),
            version: current.version + 1,
            sourceVersion: current.sourceVersion + 1,
          },
          overlap: { baseSequence: 0, intent, changes: paths },
        });
      },
    },
    {},
  );

test('two separate checkout roots save the same file; second response reports peer and hosted acknowledgement suppresses it', async t => {
  const { s, lane, peer, transport } = await setup(t);
  const first = transport(lane),
    second = transport(peer);
  assert.notEqual(first.root, second.root);
  assert.equal(
    (await first.dispatch('save', { operationId: randomUUID(), message: 'first' })).unacknowledgedOverlaps
      .count,
    0,
  );
  const response = await second.dispatch('save', { operationId: randomUUID(), message: 'second' });
  assert.equal(response.result.outcome.status, 'completed');
  assert.equal(response.unacknowledgedOverlaps.count, 1);
  const notice = response.unacknowledgedOverlaps.items[0];
  assert.equal(notice.file, 'a.txt');
  assert.deepEqual(notice.lanes, [lane.id, peer.id].sort());
  assert.equal(notice.participants.find(p => p.lane === lane.id).intent, 'My change');
  await s.transaction('ack', acks.append, {
    projectId: s.projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      answers: [
        { operationId: randomUUID(), laneId: peer.id, noticeId: notice.noticeId, choice: 'accept-order' },
      ],
    }),
  });
  const status = await second.dispatch('status', { laneId: peer.id });
  assert.equal(status.unacknowledgedOverlaps.count, 0);
  const other = JSON.parse(
    await s.transaction('other', overlaps.read, { projectId: s.projectId, laneId: lane.id }),
  );
  assert.equal(other.unacknowledgedOverlaps.count, 1, 'one participant answer does not answer for the other');
  for (let i = 0; i < 101; i++)
    s.insert('projectHostedOverlapAcks', {
      projectId: s.projectId,
      actor: 'owner',
      id: randomUUID(),
      request: '{}',
      value: '{}',
      laneId: peer.id,
      noticeId: String(i).padStart(64, '0'),
    });
  const bounded = JSON.parse(
    await s.transaction('old-answers', overlaps.read, { projectId: s.projectId, laneId: peer.id }),
  );
  assert.equal(bounded.unacknowledgedOverlaps.count, null);
  assert.deepEqual(
    bounded.unacknowledgedOverlaps.items,
    [],
    'an acknowledgement outside the read window never repeats',
  );
  await s.transaction(
    'close-peer',
    {
      _handler: async ctx => {
        const row = await records.readHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          kind: 'lane',
          key: peer.id,
        });
        const current = JSON.parse(row.value);
        await records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: current.version,
          record: {
            ...current,
            state: 'completed',
            version: current.version + 1,
            lifecycleVersion: current.lifecycleVersion + 1,
          },
        });
      },
    },
    {},
  );
  const closed = JSON.parse(
    await s.transaction('closed-peer', overlaps.read, { projectId: s.projectId, laneId: lane.id }),
  );
  assert.equal(closed.unacknowledgedOverlaps.count, 0);
});

test('a Lane whose saved head just landed stops being an overlap peer, even while its record is still active', async t => {
  // Replay of efa2859d / bcdcc4aa: efa2859d landed, then bcdcc4aa finished and was told efa2859d was open.
  const { s, lane, peer, transport } = await setup(t);
  const landedLane = transport(lane),
    finishing = transport(peer);
  await landedLane.dispatch('save', { operationId: randomUUID(), message: 'efa2859d work' });
  const before = await finishing.dispatch('save', { operationId: randomUUID(), message: 'bcdcc4aa work' });
  assert.equal(before.unacknowledgedOverlaps.count, 1, 'the open peer is named while it is open');
  assert.equal(before.overlapNotice.items[0].with[0].lane, lane.id);
  const row = [...s.tables.projectHostedOverlapLanes.values()].find(item => item.laneId === lane.id);
  const object = { object: { sha256: 'a'.repeat(64), size: 1 }, recipe: null };
  const entry = (laneId, head) => ({
    laneId,
    head,
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: object,
  });
  const receiptId = randomUUID();
  const page = entries => ({
    projectId: s.projectId,
    receiptId,
    kind: 'inputs',
    index: 0,
    digest: 'd'.repeat(64),
    root: 'r'.repeat(64),
    value: JSON.stringify({ schema: 1, kind: 'forge-hosted-compose-page', entries, next: null }),
  });
  // A different head landed for that Lane id: the saved head is still unlanded work.
  s.insert('projectHostedAcceptancePages', page([entry(lane.id, 'f'.repeat(64))]));
  const retire = () =>
    s.transaction(
      'retire',
      { _handler: ctx => landed.retireLandedOverlapLanes(ctx, { projectId: s.projectId, receiptId }) },
      {},
    );
  assert.equal(await retire(), 0);
  assert.equal(
    JSON.parse(await s.transaction('still-open', overlaps.read, { projectId: s.projectId, laneId: peer.id }))
      .unacknowledgedOverlaps.count,
    1,
  );
  // Exact landed head: retired in the accepting transaction, before the completion ledger runs.
  for (const id of [...s.tables.projectHostedAcceptancePages.keys()])
    s.tables.projectHostedAcceptancePages.delete(id);
  s.insert('projectHostedAcceptancePages', page([entry(lane.id, row.head)]));
  assert.equal(await retire(), 1);
  const after = JSON.parse(
    await s.transaction('after-landing', overlaps.read, { projectId: s.projectId, laneId: peer.id }),
  );
  assert.equal(after.unacknowledgedOverlaps.count, 0);
  assert.deepEqual(after.unacknowledgedOverlaps.items, []);
  const retiredRow = [...s.tables.projectHostedOverlapLanes.values()].find(item => item.laneId === lane.id);
  assert.equal(retiredRow.open, false);
  assert.equal(await retire(), 0, 'replaying the retirement changes nothing');
  // Further work in the same Lane (keepOpen) is tracked open again by its next save.
  await s.transaction(
    'saved-again',
    {
      _handler: ctx =>
        tracking.trackHostedOverlapLane(
          ctx,
          s.projectId,
          { ...lane, head: 'e'.repeat(64) },
          { baseSequence: 0, changes: [delta('a.txt')] },
        ),
    },
    {},
  );
  assert.equal(
    [...s.tables.projectHostedOverlapLanes.values()].find(item => item.laneId === lane.id).open,
    true,
  );
});

test('main moves over a saved Lane file; status reports commits and the conflicting path', async t => {
  const { s, lane, channel, main, transport } = await setup(t);
  const client = transport(lane);
  await client.dispatch('save', { operationId: randomUUID(), message: 'save' });
  await s.transaction(
    'main-paths',
    { _handler: ctx => tracking.trackHostedOverlapMain(ctx, s.projectId, 1, ['a.txt', 'unrelated.txt']) },
    {},
  );
  s.patch('projectHostedChannels', channel, {
    selection: JSON.stringify({
      ...main,
      sourceRevision: 1,
      head: 'c'.repeat(64),
      receipt: { ...main.receipt, id: 'main-1' },
    }),
  });
  const status = await client.dispatch('status', { laneId: lane.id });
  assert.deepEqual(status.behindMain, {
    head: 'c'.repeat(64),
    baseHead: lane.base.head,
    baseSequence: 0,
    commits: 1,
    conflictingPaths: ['a.txt'],
    more: 0,
    coverage: 'hosted',
  });
});

test('overlap reads recheck access before disclosing paths', async t => {
  const { s, lane } = await setup(t);
  for (const actor of [null, 'outsider']) {
    await assert.rejects(
      s.transaction('denied', overlaps.read, { projectId: s.projectId, laneId: lane.id }, actor),
      code('PROJECT_UNAVAILABLE'),
    );
  }
  await assert.rejects(
    s.transaction('missing', overlaps.read, { projectId: s.projectId, laneId: randomUUID() }),
    code('NOT_FOUND'),
  );
});

test('reverted bytes clear saved paths; absent metadata stays incomplete and display budgets do not deny source', () => {
  const first = mergeOverlapChanges([], [delta('a.txt')]);
  assert.deepEqual(
    JSON.parse(
      mergeOverlapChanges(JSON.parse(first.changes), [{ path: 'a.txt', before: newFile, after: oldFile }])
        .changes,
    ),
    [],
  );
  const addition = mergeOverlapChanges([], [{ path: 'new', before: null, after: newFile }]);
  assert.deepEqual(
    JSON.parse(
      mergeOverlapChanges(JSON.parse(addition.changes), [{ path: 'new', before: newFile, after: null }])
        .changes,
    ),
    [],
  );
  const huge = boundOverlapChanges(Array.from({ length: 2000 }, (_, i) => delta('p'.repeat(300) + i)));
  assert.equal(huge.complete, false);
  assert(Buffer.byteLength(huge.changes) <= 128 * 1024);
});

test('20 open Lanes x 200 paths use one indexed peer read; history does not enter the budget', async t => {
  const { s, lane } = await setup(t);
  const paths = Array.from({ length: 200 }, (_, i) => delta('src/file-' + i + '.ts'));
  const value = mergeOverlapChanges([], paths);
  const existing = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === lane.id);
  s.patch('projectHostedOverlapLanes', existing._id, { ...value, head: lane.head });
  for (let i = 0; i < 18; i++) {
    const peerId = randomUUID();
    s.insert('projectHostedRecordHeads', {
      projectId: s.projectId,
      kind: 'lane',
      key: peerId,
      parent: randomUUID(),
      status: 'active',
      version: 0,
      recordId: 'synthetic',
    });
    s.insert('projectHostedOverlapLanes', {
      projectId: s.projectId,
      laneId: peerId,
      intentId: randomUUID(),
      actor: 'owner',
      recordVersion: 0,
      intent: 'Synthetic peer',
      head: 'b'.repeat(64),
      baseHead: lane.base.head,
      baseReceiptId: 'main-0',
      baseSequence: 0,
      open: true,
      ...value,
    });
  }
  for (let i = 0; i < 560; i++)
    s.insert('projectHostedOverlapLanes', {
      projectId: s.projectId,
      laneId: randomUUID(),
      intentId: randomUUID(),
      actor: 'owner',
      recordVersion: 0,
      intent: 'Closed peer',
      head: lane.head,
      baseHead: lane.base.head,
      baseReceiptId: 'main-0',
      baseSequence: 0,
      open: false,
      changes: '[]',
      complete: true,
    });
  for (let i = 0; i < 575; i++)
    s.insert('projectHostedAcceptances', {
      projectId: s.projectId,
      receiptId: 'old-' + i,
      submissionId: 'old',
      attemptId: 'old',
      sequence: i,
      value: '{}',
    });
  for (const [kind, count] of [
    ['intent', 600],
    ['save', 2800],
    ['candidate', 2200],
    ['job', 1500],
  ])
    for (let i = 0; i < count; i++)
      s.insert('projectHostedRecordHeads', {
        projectId: s.projectId,
        kind,
        key: 'unselected-' + kind + i,
        parent: '',
        status: 'retained',
        version: 0,
        recordId: 'unselected',
      });
  for (let i = 0; i < 2500; i++)
    s.insert('projectHostedStates', {
      projectId: s.projectId,
      head: 'unselected-' + i,
      size: 0,
      input: '{}',
      output: '{}',
      jobId: 'unselected',
    });
  for (let i = 0; i < 32000; i++)
    s.insert('projectObjects', {
      projectId: s.projectId,
      digest: 'unselected-' + i,
      size: 0,
      nonce: 'synthetic',
      removed: false,
    });
  const before = s.counts.length;
  const response = JSON.parse(
    await s.transaction('scale', overlaps.read, { projectId: s.projectId, laneId: lane.id }),
  );
  const meter = s.counts.at(-1);
  assert.equal(s.counts.length - before, 1, 'one Convex function call');
  assert.equal(
    meter.touched.filter(name => name === 'projectHostedOverlapLanes').length,
    2,
    'one focus lookup and one peer range',
  );
  assert(meter.documents <= 60, JSON.stringify(meter));
  assert(meter.readBytes < 2 * 1024 * 1024);
  assert.equal(meter.writes, 0);
  assert(
    !meter.touched.some(table =>
      ['projectHostedAcceptances', 'projectWorkRecords', 'projectObjects'].includes(table),
    ),
  );
  assert.equal(response.unacknowledgedOverlaps.items.length, 5);
  const peers = [...s.tables.projectHostedOverlapLanes.values()].filter(row => row.open);
  const focus = peers.find(row => row.laneId === lane.id);
  const started = performance.now();
  for (let i = 0; i < 20; i++)
    hostedOverlapAdvice(focus, peers, null, { head: focus.baseHead, sourceRevision: 0 }, new Set());
  const wallMs = (performance.now() - started) / 20;
  assert(wallMs < 50, 'pure overlap comparison under 50 ms: ' + wallMs);
  t.diagnostic(
    JSON.stringify({
      calls: 1,
      indexedPeerReads: 1,
      documents: meter.documents,
      ranges: meter.ranges,
      readBytes: meter.readBytes,
      writes: meter.writes,
      calculationMs: wallMs,
      rssBytes: process.memoryUsage().rss,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});

test('main path summaries bound history and report missing coverage', () => {
  const initial = advanceOverlapMain(null, 575, ['a']);
  assert.equal(initial.coverageAfter, 574);
  const next = advanceOverlapMain(initial, 576, ['b']);
  assert.deepEqual(
    new Map(JSON.parse(next.changes)),
    new Map([
      ['a', 575],
      ['b', 576],
    ]),
  );
  assert.equal(advanceOverlapMain(next, 577, null).coverageAfter, 577);
});

test('MCP fans out returned notices once and does no idle work', async () => {
  const sent = [],
    capabilities = [];
  const notify = hostedOverlapNotifications({
    server: {
      registerCapabilities(value) {
        capabilities.push(value);
      },
    },
    async sendLoggingMessage(message) {
      sent.push(message);
    },
  });
  assert.equal(sent.length, 0);
  const response = { unacknowledgedOverlaps: { items: [{ noticeId: 'one', file: 'a.txt' }] } };
  assert.equal(await notify(response), response);
  await notify(response);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].logger, 'forge-overlap');
  assert.deepEqual(capabilities, [{ logging: {} }]);
});

test('start carries negotiated advice and an unavailable observation preserves the start receipt', async t => {
  const f = agentFixture(t);
  f.caps.overlapVersion = 1;
  const query = f.exchange.client.query;
  let unavailable = false;
  f.exchange.client.query = async (ref, args) => {
    if (getFunctionName(ref) !== 'projectHostedOverlaps:read') return query(ref, args);
    if (unavailable) throw Error('synthetic advice outage');
    return JSON.stringify({
      unacknowledgedOverlaps: { count: 0, items: [], coverage: 'hosted' },
      behindMain: { commits: 0, conflictingPaths: [], more: 0, coverage: 'hosted' },
    });
  };
  const operationId = randomUUID();
  const first = await f.transport().dispatch('start', { operationId, outcome: 'Start advice' });
  assert.equal(first.unacknowledgedOverlaps.coverage, 'hosted');
  unavailable = true;
  const replay = await f.transport().dispatch('start', { operationId, outcome: 'Start advice' });
  assert.equal(replay.result.lane.laneId, first.result.lane.laneId);
  assert.equal(replay.unacknowledgedOverlaps.count, null);
  assert.equal(replay.unacknowledgedOverlaps.coverage, 'unavailable');
});

test('acceptance updates compact main paths in the same publication and retry does not repeat it', async () => {
  const f = await acceptanceFixture();
  const item = await f.makeCandidate([], [], {
    governance: { version: 1, paths: ['src/shared.ts'], ownerInputs: true },
  });
  const { state } = await f.ready(item);
  const accepted = await f.accept(state);
  assert.equal(accepted.status, 'landed');
  const projected = [...f.tables.projectHostedOverlapMain.values()];
  assert.equal(projected.length, 1);
  assert.equal(projected[0].sequence, f.currentMain().sourceRevision);
  assert.deepEqual(JSON.parse(projected[0].changes), [['src/shared.ts', 1]]);
  assert.deepEqual(await f.accept(state), accepted);
  assert.deepEqual([...f.tables.projectHostedOverlapMain.values()], projected);
});

test('unprojected active peers report incomplete coverage', async t => {
  const { s, lane, peer } = await setup(t);
  await trackChange(s, lane);
  const projection = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === peer.id);
  s.tables.projectHostedOverlapLanes.delete(projection._id);
  const observed = JSON.parse(
    await s.transaction('legacy', overlaps.read, { projectId: s.projectId, laneId: lane.id }),
  );
  assert.equal(observed.unacknowledgedOverlaps.coverage, 'hosted-incomplete');
});

test('missing staged lifecycle evidence is unavailable, never an open-peer fallback', async t => {
  const { s, lane, peer } = await setup(t);
  await trackChange(s, lane);
  const row = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === peer.id);
  s.patch('projectHostedOverlapLanes', row._id, { lifecyclePlanId: 'missing-plan' });
  await assert.rejects(
    s.transaction('missing-marker', overlaps.read, { projectId: s.projectId, laneId: lane.id }),
    code('SOURCE_UNAVAILABLE'),
  );
});

test('materialized cascades remove closed path sets from the open index', async () => {
  const f = await lifecycleFixture();
  await f.addLane();
  const request = f.request({ kind: 'intent', intentId: f.intentId, version: 0, cascade: true });
  await f.begin(request);
  await f.drain();
  const projections = [...f.tables.projectHostedOverlapLanes.values()].filter(
    row => row.intentId === f.intentId,
  );
  assert.equal(projections.length, 2);
  assert(projections.every(row => !row.open));
  assert(projections.every(row => row.lifecyclePlanId === undefined));
});

test('overlap negotiation preserves notice support on a notice-aware older server', async t => {
  const f = agentFixture(t);
  f.caps.needsFix = [];
  const query = f.exchange.client.query;
  let rejected = 0;
  f.exchange.client.query = async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedAgent:capabilities' && args.overlapVersion === 1) {
      rejected++;
      throw Error('ArgumentValidationError: extra field `overlapVersion`');
    }
    return query(ref, args);
  };
  const started = await f.transport().dispatch('start', { outcome: 'Notice-aware older server' });
  assert(started.result.lane);
  assert.equal(rejected, 1);
  assert.equal(f.calls.find(call => call.name === 'projectHostedStart:start').args.noticeVersion, 1);
  assert.equal(f.calls.find(call => call.name === 'projectHostedAgent:capabilities').args.resolveVersion, 1);
});

test('a resolve capability refusal retains independently supported overlap advice', async t => {
  const f = agentFixture(t),
    query = f.exchange.client.query;
  let rejected = 0;
  f.exchange.client.query = async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedAgent:capabilities' && args.resolveVersion === 1) {
      rejected++;
      throw Error('ArgumentValidationError: extra field `resolveVersion`');
    }
    return query(ref, args);
  };
  const started = await f.transport().dispatch('start', { outcome: 'Overlap-aware older server' });
  assert(started.result.lane);
  assert.equal(rejected, 1);
  assert.equal(f.calls.find(call => call.name === 'projectHostedAgent:capabilities').args.overlapVersion, 1);
});

test('CLI path: the second save returns a structured notice, delivery and one-command acknowledgement are recorded', async t => {
  const { s, lane, peer, transport } = await setup(t);
  const first = transport(lane),
    second = transport(peer);
  const quiet = await first.dispatch('save', { operationId: randomUUID(), message: 'first' });
  assert.equal(quiet.overlapNotice, undefined, 'no notice without an overlap');
  assert.equal(s.tables.projectHostedOverlapDeliveries.size, 0, 'no overlap, no delivery call');
  const response = await second.dispatch('save', { operationId: randomUUID(), message: 'second' });
  const notice = response.overlapNotice;
  assert.equal(notice.required, true);
  assert.equal(notice.items.length, 1);
  assert.equal(notice.items[0].file, 'a.txt');
  assert.deepEqual(
    notice.items[0].with.map(p => [p.lane, p.intent]),
    [[lane.id, 'My change']],
    'names the other Lane, never this one',
  );
  assert.match(notice.acknowledge, /^nforge agent '.+' overlap-acks '\{.*\}'$/);
  assert.match(notice.routeAround, /"choice":"split"/);
  const banner = overlapBanner(notice);
  assert.match(banner, /OVERLAP NOTICE: ACTION REQUIRED/);
  assert(banner.includes('a.txt') && banner.includes(lane.id) && banner.includes('My change'));
  assert(banner.includes(notice.acknowledge) && banner.includes(notice.routeAround));
  const deliveriesBefore = [...s.tables.projectHostedOverlapDeliveries.values()];
  assert.equal(deliveriesBefore.length, 1);
  const delivered = JSON.parse(deliveriesBefore[0].value);
  assert.equal(delivered.laneId, peer.id);
  assert.equal(delivered.surface, 'save');
  assert.equal(delivered.items[0].noticeId, notice.items[0].noticeId);
  // A repeated observation is not a second delivery.
  await second.dispatch('status', { laneId: peer.id });
  assert.equal(s.tables.projectHostedOverlapDeliveries.size, 1);
  // The printed acknowledge command is one valid call and replays safely.
  const body = JSON.parse(/ overlap-acks '(.*)'$/.exec(notice.acknowledge)[1]);
  for (let i = 0; i < 2; i++) {
    const acked = await second.dispatch('overlap-acks', body);
    assert.equal(acked.result.answers[0].disposition, 'acknowledged');
  }
  assert.equal(s.tables.projectHostedOverlapAcks.size, 1, 'replay records one answer');
  const ack = JSON.parse([...s.tables.projectHostedOverlapAcks.values()][0].value);
  assert.equal(ack.deliveryId, delivered.items[0].deliveryId, 'ack joins its delivery (metric 5.4)');
  const after = await second.dispatch('status', { laneId: peer.id });
  assert.equal(after.unacknowledgedOverlaps.count, 0);
  assert.equal(after.overlapNotice, undefined);
  // The other participant routes around instead; its answer is its own.
  const routed = JSON.parse(
    / overlap-acks '(.*)'$/.exec(
      (await first.dispatch('status', { laneId: lane.id })).overlapNotice.routeAround,
    )[1],
  );
  assert.equal((await first.dispatch('overlap-acks', routed)).result.answers[0].disposition, 'routed-around');
});

test('retained stale active Lanes never hide a live peer from the notice', async t => {
  const { s, lane, peer, transport } = await setup(t);
  // 2026-10-30: 125 active Lane heads; the oldest 51 hid all 32 live peers, so no notice was ever sent.
  const live = [...s.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'lane');
  for (const row of live) s.tables.projectHostedRecordHeads.delete(row._id);
  for (let i = 0; i < 60; i++)
    s.insert('projectHostedRecordHeads', {
      projectId: s.projectId,
      kind: 'lane',
      key: randomUUID(),
      parent: randomUUID(),
      status: 'active',
      version: 0,
      recordId: 'synthetic',
    });
  for (const row of live)
    s.insert('projectHostedRecordHeads', { ...row, _id: undefined, _creationTime: undefined });
  const first = transport(lane),
    second = transport(peer);
  await first.dispatch('save', { operationId: randomUUID(), message: 'first' });
  const response = await second.dispatch('save', { operationId: randomUUID(), message: 'second' });
  assert.equal(response.unacknowledgedOverlaps.count, 1);
  assert.equal(response.overlapNotice.items[0].file, 'a.txt');
});

for (const keepOpen of [false, true])
  test(`accepted input Lanes leave the open overlap index${keepOpen ? ' even when keepOpen leaves them active' : ''}`, async () => {
    const f = await acceptanceFixture();
    const entry = await f.lane();
    const item = await f.makeCandidate([entry], [], {
      governance: { version: 1, paths: ['src/shared.ts'], ownerInputs: true },
    });
    const { state } = await f.ready(item, keepOpen ? { keepOpen: true } : {});
    const overlapRow = () =>
      [...f.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === entry.laneId);
    assert.equal(overlapRow().open, true, 'open before it lands');
    const { receipt } = await f.accept(state);
    assert.equal(overlapRow().open, true, 'the accepting transaction stays constant-size');
    const tasks = f.pendingTasks().filter(task => task.name.endsWith(':complete'));
    assert.equal(tasks.length, 1, 'one scheduled tick even when completion is off; no extra task');
    await f.materialize(receipt.id);
    assert.equal(overlapRow().open, false, 'landed work is no longer open overlap work');
    assert.equal((await f.readLane(entry.laneId)).state, keepOpen ? 'active' : 'completed');
  });

test('overlap reads are O(1): a Lane without saved changes touches no peers, and one read lists a large inbox for ack', async t => {
  const { s, lane, peer } = await setup(t);
  const read = (name, laneId, extra = {}) =>
    s.transaction(name, overlaps.read, { projectId: s.projectId, laneId, ...extra });
  // No saved paths: nothing can overlap, so the peer, head and answer tables are not read at all.
  const idle = JSON.parse(await read('idle', lane.id));
  assert.equal(idle.unacknowledgedOverlaps.count, 0);
  assert.equal(idle.unacknowledgedOverlaps.coverage, 'hosted');
  const idleCount = s.counts.find(count => count.name === 'idle');
  assert(!idleCount.touched.includes('projectHostedOverlapAcks'), 'answers stay unread for an idle Lane');
  assert(idleCount.documents <= 10, `idle read touches ${idleCount.documents} documents`);
  // Twelve shared files: the default read lists five, an ack-sized read lists them all in one call.
  const paths = Array.from({ length: 12 }, (_, i) => delta(`src/shared-${i}.ts`));
  await trackChange(s, lane, paths);
  await trackChange(s, peer, paths, 'Peer change');
  const few = JSON.parse(await read('few', lane.id));
  assert.equal(few.unacknowledgedOverlaps.items.length, 5);
  assert.equal(few.unacknowledgedOverlaps.count, 12);
  const all = JSON.parse(await read('all', lane.id, { items: 50 }));
  assert.equal(all.unacknowledgedOverlaps.items.length, 12);
  assert.equal(s.counts.filter(count => count.name === 'all').length, 1);
});
