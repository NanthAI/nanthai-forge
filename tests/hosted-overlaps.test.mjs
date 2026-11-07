// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { digest } from '../dist/hash.js';
import { assertNoAccountIds } from './account-id-scan.mjs';
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
  recordOverlapLanding,
  driftNudge,
  DRIFT_NUDGE_MIN_LANDINGS,
  DRIFT_LANDING_LOG,
} from '../dist/hosted-overlap.js';
import { hostedOverlapNotifications } from '../dist/mcp-hosted-overlaps.js';
import { rememberOverlapText } from '../dist/hosted-overlap-text.js';
import { finishGates } from '../dist/agent-default-gates.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { mergeNativeText } from '../dist/native-text-merge.js';
import { preEditHosted } from '../dist/agent-edit-hosted.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { overlapBanner, overlapBannerOnce, refusalOverlapBanner } from '../dist/hosted-overlap-notice.js';
const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
const landed = await import(moduleUrl('../convex/projectHostedOverlapLanded.ts'));
const capabilities = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const acks = await import(moduleUrl('../convex/projectHostedOverlapAcks.ts'));
const deliveries = await import(moduleUrl('../convex/projectHostedOverlapDeliveries.ts'));
const oldFile = { blob: 'a'.repeat(64), mode: 'file' };
const newFile = { blob: 'b'.repeat(64), mode: 'file' };
const delta = path => ({
  path,
  before: oldFile,
  after: newFile,
  evidence: { baseBlob: oldFile.blob, ranges: [{ start: 0, end: 1 }], symbols: [] },
});
const code = expected => error => (error.data?.code ?? error.code) === expected;

async function setup(t, options = {}) {
  options = { base: 'original', ...options };
  const file = options.file ?? 'a.txt';
  const s = await saveFixture(options.base ?? 'original', file);
  // These fixtures use synthetic dated Lanes and test open-peer reads, not dormancy (tests/hosted-dormant.test.mjs).
  s.patch('hostedProjects', s.projectId, {
    autonomyPolicy: { ...policyPreset('trusted'), agentDefaults: { dormantAfterDays: 0 } },
  });
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
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(
      join(root, file),
      entry.id === lane.id ? (options.mine ?? 'my edit') : (options.peer ?? 'peer edit'),
    );
    if (options.base)
      rememberOverlapText(`${root}.forge-client`, s.original.sha256, Buffer.from(options.base));
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
        scope: [file],
        materialized: [file],
      }),
    );
    return root;
  };
  const discovery = [];
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
        if (name === 'projectHostedAgent:capabilities') {
          discovery.push(args);
          if (options.legacy && args.overlapEvidenceVersion === 1)
            throw Error('ArgumentValidationError: extra field `overlapEvidenceVersion`');
          return s.transaction(name, capabilities.capabilities, args);
        }
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
        if (name === 'projectHostedSaves:stage') {
          if (options.legacy)
            assert(
              JSON.parse(args.page).changes.every(change => !change.evidence),
              'strict older save API receives no new metadata',
            );
          return s.call('stage', api.stage, args);
        }
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
    discovery,
    transport: entry => {
      const transport = new HostedAgentTransport(root(entry), address, exchange);
      const dispatch = transport.dispatch.bind(transport);
      // Guard (9a19b304): every agent action's output in these fixtures is scanned for raw account ids.
      transport.dispatch = async (action, ...rest) => {
        const reply = await dispatch(action, ...rest);
        assertNoAccountIds(assert, reply, `dispatch ${action}`);
        return reply;
      };
      return transport;
    },
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
          overlap: {
            baseSequence: 0,
            intent,
            changes: paths.map(change => ({
              ...change,
              after: change.after && { ...change.after, blob: digest(lane.id + change.after.blob) },
            })),
          },
        });
      },
    },
    {},
  );

test('two separate checkout roots save the same file; second response reports peer and hosted acknowledgement suppresses it', async t => {
  const { s, lane, peer, transport, discovery } = await setup(t);
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
  // Presence (9c8490a4) rides on the same overlap read: the shared file and similar goal name the
  // first Lane once, as one bounded line; a status read asks for none.
  // Named contract feature (a83b6fd5): the CLI no longer sends presenceVersion.
  assert(discovery.every(args => args.features.includes('agent-presence') && !('presenceVersion' in args)));
  assert.equal(response.presence.notices.length, 1);
  assert.match(response.presence.notices[0], new RegExp(`Lane ${lane.id.slice(0, 8)}`));
  assert(response.presence.notices[0].length <= 240);
  // Only the Lane's author (or the project owner) answers its notices (8809fba5).
  s.insert('projectContributors', { projectId: s.projectId, contributor: 'writer' });
  await s.transaction(
    'foreign-ack',
    acks.append,
    {
      projectId: s.projectId,
      request: JSON.stringify({
        operationId: randomUUID(),
        answers: [
          { operationId: randomUUID(), laneId: peer.id, noticeId: notice.noticeId, choice: 'accept-order' },
        ],
      }),
    },
    'writer',
  );
  assert.equal(
    (await second.dispatch('status', { laneId: peer.id })).unacknowledgedOverlaps.count,
    1,
    "another member's answer leaves the notice unanswered",
  );
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
  assert.equal(status.presence, undefined);
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
  const paths = Array.from({ length: 200 }, (_, i) => ({
    ...delta('src/file-' + i + '.ts'),
    evidence: { baseBlob: oldFile.blob, ranges: [{ start: 2, end: 3 }], symbols: [] },
  }));
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
      changes: JSON.stringify(
        JSON.parse(value.changes).map(c => ({ ...c, after: { ...c.after, blob: digest(peerId) } })),
      ),
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
  // The 50 ms claim is checked on main-thread CPU time. Wall time also counts the time a loaded runner
  // deschedules this process: hosted Linux takes about 5.6 ms per comparison, yet one run read 52 ms
  // (2026-11-07). Wall time stays a diagnostic.
  const started = performance.now(),
    cpu = process.threadCpuUsage();
  for (let i = 0; i < 20; i++)
    hostedOverlapAdvice(focus, peers, null, { head: focus.baseHead, sourceRevision: 0 }, new Set());
  const used = process.threadCpuUsage(cpu),
    cpuMs = (used.user + used.system) / 1000 / 20,
    wallMs = (performance.now() - started) / 20;
  assert(cpuMs < 50, 'pure overlap comparison under 50 ms of CPU: ' + cpuMs);
  t.diagnostic(
    JSON.stringify({
      calls: 1,
      indexedPeerReads: 1,
      documents: meter.documents,
      ranges: meter.ranges,
      readBytes: meter.readBytes,
      writes: meter.writes,
      calculationMs: wallMs,
      calculationCpuMs: cpuMs,
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
  // Exercise an older checkout with no retained range sketch.
  const { s, lane, peer, transport } = await setup(t, { base: null });
  const first = transport(lane),
    second = transport(peer);
  const quiet = await first.dispatch('save', { operationId: randomUUID(), message: 'first' });
  assert.equal(quiet.overlapNotice, undefined, 'no notice without an overlap');
  assert.equal(s.tables.projectHostedOverlapDeliveries.size, 0, 'no overlap, no delivery call');
  const response = await second.dispatch('save', { operationId: randomUUID(), message: 'second' });
  const notice = response.overlapNotice;
  assert.equal(notice.required, false, 'missing ranges are advisory, never a false gate');
  assert.equal(notice.items[0].class, 'advisory');
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
  assert.match(banner, /OVERLAP NOTICE: ADVISORY/);
  assert(banner.includes('a.txt') && banner.includes(lane.id) && banner.includes('My change'));
  assert(!banner.includes('Acknowledge (keep your change'), 'advisory has no required answer step');
  const deliveriesBefore = [...s.tables.projectHostedOverlapDeliveries.values()];
  assert.equal(deliveriesBefore.length, 1);
  const delivered = JSON.parse(deliveriesBefore[0].value);
  assert.equal(delivered.laneId, peer.id);
  assert.equal(delivered.surface, 'save');
  assert.equal(delivered.items[0].noticeId, notice.items[0].noticeId);
  // The delivery list names the actor by handle for members and names nobody for public readers.
  s.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  const listed = JSON.parse(
    await s.call('deliveries', deliveries.list, { projectId: s.projectId, cursor: null }),
  );
  assert.deepEqual(
    listed.page.map(row => row.actor),
    ['synthetic-owner'],
  );
  const project = s.tables.hostedProjects.get(s.projectId);
  s.tables.hostedProjects.set(s.projectId, { ...project, visibility: 'public' });
  const shown = await s.call(
    'deliveries-public',
    deliveries.list,
    { projectId: s.projectId, cursor: null },
    'user_publicReader0001',
  );
  assert.equal(JSON.parse(shown).page.length, 1);
  assert(!shown.includes('"actor"') && !shown.includes('synthetic-owner'), shown);
  s.tables.hostedProjects.set(s.projectId, project);
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

for (const file of ['src/shared.ts', 'notes.md', 'docs/guide.txt']) {
  test(`${file}: disjoint saved hunks produce no automatic notice and pass landing without an answer`, async t => {
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
    const mine = base.replace('line 2\n', 'my edit\n');
    const peerText = base.replace('line 30\n', 'peer edit\n');
    const { s, lane, peer, transport } = await setup(t, { base, mine, peer: peerText, file });
    await transport(lane).dispatch('save', { operationId: randomUUID(), message: 'disjoint first' });
    const second = transport(peer);
    const saved = await second.dispatch('save', { operationId: randomUUID(), message: 'disjoint second' });
    assert.equal(saved.unacknowledgedOverlaps.count, 0);
    assert.equal(saved.unacknowledgedOverlaps.advisoryCount, 0);
    assert.equal(saved.unacknowledgedOverlaps.blockingCount, 0);
    assert.deepEqual(
      finishGates(
        second.root,
        effectiveAgentDefaults({ preflight: 'off' }),
        { laneId: peer.id, head: saved.unacknowledgedOverlaps.head },
        saved,
      ),
      {},
    );
    assert.equal(s.tables.projectHostedOverlapAcks.size, 0, 'no answer was written');
    assert(
      mergeNativeText(Buffer.from(base), Buffer.from(mine), Buffer.from(peerText), file),
      'ordinary landing composition remains clean',
    );
    assert.equal(s.tables.projectHostedOverlapDeliveries.size, 0);
    const observed = await second.dispatch('status', { laneId: peer.id });
    assert.equal(observed.unacknowledgedOverlaps.count, 0);
  });
}

test('intersecting saved hunks block before landing and composition still rejects a real conflict', async t => {
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
  const mine = base.replace('line 2\n', 'my edit\n');
  const peerText = base.replace('line 2\n', 'peer edit\n');
  const { lane, peer, transport } = await setup(t, { base, mine, peer: peerText });
  await transport(lane).dispatch('save', { operationId: randomUUID(), message: 'first intersecting' });
  const second = transport(peer);
  const saved = await second.dispatch('save', { operationId: randomUUID(), message: 'second intersecting' });
  assert.equal(saved.overlapNotice.items[0].class, 'blocking');
  assert.equal(saved.overlapNotice.required, true);
  assert.throws(
    () =>
      finishGates(
        second.root,
        effectiveAgentDefaults({ preflight: 'off' }),
        { laneId: peer.id, head: saved.unacknowledgedOverlaps.head },
        saved,
      ),
    code('OVERLAP_UNANSWERED'),
  );
  assert.equal(mergeNativeText(Buffer.from(base), Buffer.from(mine), Buffer.from(peerText)), null);
});

// Friction c8b842a9 (Lane e88703a8, retry 6a75392f): the land retry printed one advisory notice,
// then refused OVERLAP_UNANSWERED; ack then answered a blocking notice that no banner had shown. A
// save had changed the overlap evidence after the receipt that printed the banner.
test('incident replay: a save turns an advisory overlap blocking; the refusal shows that notice and its exact answer', async t => {
  const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join('');
  const mine = base.replace('line 2\n', 'my edit\n');
  const { s, lane, peer, transport } = await setup(t, {
    base,
    mine,
    peer: base.replace('line 2\n', 'peer edit\n'),
  });
  await transport(lane).dispatch('save', { operationId: randomUUID(), message: 'mine' });
  const second = transport(peer);
  // The first save carries no range evidence (its base text was not retained): advisory.
  const sketches = join(`${second.root}.forge-client`, 'overlap-text');
  rmSync(sketches, { recursive: true, force: true });
  const first = await second.dispatch('save', { operationId: randomUUID(), message: 'no ranges' });
  assert.deepEqual(
    first.overlapNotice.items.map(item => item.class),
    ['advisory'],
  );
  assert.match(
    overlapBannerOnce(first.overlapNotice),
    /OVERLAP NOTICE: ADVISORY/,
    'the banner the agent saw',
  );
  // The retry's save brings range evidence that intersects the other hunk: a blocking notice.
  rememberOverlapText(`${second.root}.forge-client`, s.original.sha256, Buffer.from(base));
  writeFileSync(join(second.root, 'a.txt'), base.replace('line 2\n', 'peer edit again\n'));
  const saved = await second.dispatch('save', { operationId: randomUUID(), message: 'intersecting' });
  const blocking = saved.overlapNotice.items.filter(item => item.class === 'blocking');
  assert.equal(blocking.length, 1);
  assert.notEqual(blocking[0].noticeId, first.overlapNotice.items[0].noticeId, 'a new notice id');
  const reads = s.counts.length;
  const gate = advice =>
    finishGates(
      second.root,
      effectiveAgentDefaults({ preflight: 'off' }),
      { laneId: peer.id, head: advice.unacknowledgedOverlaps.head },
      advice,
    );
  let refusal;
  assert.throws(
    () => gate(saved),
    error => ((refusal = error), code('OVERLAP_UNANSWERED')(error)),
  );
  assert.equal(s.counts.length, reads, 'the refusal reuses the gate read: no added call');
  const notice = refusal.recovery.overlapNotice;
  assert.deepEqual(
    notice.items.map(item => [item.noticeId, item.class, item.file]),
    [[blocking[0].noticeId, 'blocking', 'a.txt']],
    'the refusal carries the blocking notice it judged',
  );
  assert.deepEqual(
    notice.items[0].with.map(p => p.lane),
    [lane.id],
  );
  assert(refusal.message.includes(notice.acknowledge), 'the message names the exact answer command');
  assert(refusal.message.includes(blocking[0].noticeId), 'and the notice it answers');
  assert.equal(refusal.recovery.command, notice.acknowledge);
  // The CLI prints the refusal's banner even after this process showed the earlier advisory one.
  const banner = refusalOverlapBanner(refusal.recovery);
  assert.match(banner, /OVERLAP NOTICE: ACTION REQUIRED/);
  assert(banner.includes('a.txt') && banner.includes(lane.id) && banner.includes(notice.acknowledge));
  assert.equal(refusalOverlapBanner(undefined), '', 'other refusals print nothing extra');
  // The printed command answers exactly that notice; the gate then lets the same head through.
  const body = JSON.parse(/ overlap-acks '(.*)'$/.exec(notice.acknowledge)[1]);
  assert.deepEqual(
    body.answers.map(answer => answer.noticeId),
    [blocking[0].noticeId],
  );
  await second.dispatch('overlap-acks', body);
  const after = await second.dispatch('status', { laneId: peer.id });
  assert.equal(after.unacknowledgedOverlaps.items.filter(item => item.class === 'blocking').length, 0);
  assert.doesNotThrow(() => gate(after));
});

test('range metadata negotiates on existing discovery, and older strict save APIs keep their original pages', async t => {
  const base = 'original\nsecond\nthird\n';
  const modern = await setup(t, { base });
  await modern
    .transport(modern.lane)
    .dispatch('save', { operationId: randomUUID(), message: 'modern metadata' });
  assert.equal(modern.discovery.length, 1, 'no new call on a supported server');
  assert.equal(modern.discovery[0].overlapEvidenceVersion, 1);
  const legacy = await setup(t, { base, legacy: true });
  const result = await legacy
    .transport(legacy.lane)
    .dispatch('save', { operationId: randomUUID(), message: 'legacy metadata' });
  assert.equal(result.result.outcome.status, 'completed');
  assert.equal(
    legacy.discovery.filter(args => args.overlapEvidenceVersion === 1).length,
    1,
    'one named capability fallback, no per-file probes',
  );
  assert.equal(legacy.discovery.at(-1).overlapVersion, 1, 'independent notice support survives');
});

test('hosted path peers use the receipt engine before first save, include answered evidence and reject revoked access', async t => {
  const { s, lane, peer, transport } = await setup(t);
  await trackChange(s, peer, [delta('src/shared.ts')], 'Peer change');
  const client = transport(lane);
  const queriesBefore = s.counts.length;
  const response = await hostedAgentCli(
    client.root,
    'peers',
    { laneId: lane.id, path: 'src/shared.ts', detail: true },
    client.address,
    client,
  );
  assert.equal(
    s.counts.length - queriesBefore,
    1,
    'the CLI performs one query including current authorization',
  );
  assert.equal(response.result.peerEvidence.items.length, 1);
  assert.equal(response.result.peerEvidence.items[0].reason, 'requested-path');
  assert.equal(response.result.peerEvidence.items[0].class, 'advisory');
  assert.equal(response.result.peerEvidence.unsavedEdits, 'unavailable');
  assert.equal(response.result.peerEvidence.scope, 'saved-paths');
  const count = s.counts.at(-1);
  assert(count.documents < 20, JSON.stringify(count));
  assert.equal(count.writes, 0);
  await client.dispatch('overlap-acks', {
    answers: [
      {
        operationId: randomUUID(),
        laneId: lane.id,
        noticeId: response.result.peerEvidence.items[0].noticeId,
        choice: 'accept-order',
      },
    ],
  });
  const answered = await client.dispatch('peers', { laneId: lane.id, path: 'src/shared.ts' });
  assert.equal(answered.result.unacknowledgedOverlaps.count, 0);
  assert.equal(answered.result.peerEvidence.count, 1, 'answered peer evidence remains available to the hook');
  const user = 'revoked';
  await assert.rejects(
    s.transaction(
      'revoked-peers',
      overlaps.read,
      { projectId: s.projectId, laneId: lane.id, path: 'src/shared.ts' },
      user,
    ),
    code('PROJECT_UNAVAILABLE'),
  );
  const before = s.counts.length;
  assert.equal(s.counts.length, before, 'no background observer or idle calls');
});

for (const [files, laneCount] of [
  [3000, 30],
  [29000, 30],
  [29000, 560],
])
  test(`${files} files / ${laneCount} Lanes: path peers are one query and three bounded projection windows`, async t => {
    const { s, lane, peer } = await setup(t);
    const seed = JSON.parse(
      [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane')
        .value,
    );
    const identity = { projectId: s.projectId, actor: 'owner', authorityEpoch: 1 };
    // Projection size depends on changed paths, not the repository inventory.
    const changes = boundOverlapChanges(
      Array.from({ length: files }, (_, i) => delta(i === 0 ? 'src/shared.ts' : `src/${i}.ts`)),
    );
    await trackChange(s, peer, JSON.parse(changes.changes), 'Peer change');
    for (let i = 0; i < laneCount - 2; i++) {
      const entry = { ...seed, id: randomUUID(), intentId: randomUUID() };
      await s.transaction(
        'scale-peer',
        {
          _handler: ctx =>
            records.writeHostedRecord(ctx, {
              ...identity,
              expectedVersion: null,
              record: entry,
              overlap: { baseSequence: 0, intent: 'Scale peer' },
            }),
        },
        {},
      );
      const projection = [...s.tables.projectHostedOverlapLanes.values()].find(
        row => row.laneId === entry.id,
      );
      s.patch('projectHostedOverlapLanes', projection._id, { changes: changes.changes, complete: false });
    }
    const result = JSON.parse(
      await s.transaction('scale-path', overlaps.read, {
        projectId: s.projectId,
        laneId: lane.id,
        path: 'src/shared.ts',
        detail: true,
      }),
    );
    assert.equal(result.peerEvidence.items.length, Math.min(laneCount - 1, 50));
    assert.equal(result.peerEvidence.coverage, 'hosted-incomplete');
    const meter = s.counts.at(-1);
    assert(meter.documents <= (laneCount > 50 ? 180 : 80), JSON.stringify(meter));
    assert(meter.ranges <= 15, JSON.stringify(meter));
    // Thirty Lanes fit below 4.5 MiB; the new 560-Lane case saturates the
    // existing 51-row projection window (each row is at most 128 KiB).
    assert(meter.readBytes < (laneCount > 50 ? 8 : 4.5) * 1024 * 1024, JSON.stringify(meter));
    assert.equal(meter.writes, 0);
    assert(!meter.touched.includes('projectWorkRecords'));
    const beforeHook = s.counts.length;
    const hook = await preEditHosted(
      {
        root: join(tmpdir(), `synthetic-hook-${randomUUID()}`),
        url: 'https://synthetic.test',
        project: s.projectId,
        laneId: lane.id,
        path: 'src/shared.ts',
      },
      'budget',
      (_name, args) => s.transaction('hook-scale', overlaps.read, args),
    );
    assert.equal(s.counts.length - beforeHook, 1);
    assert.equal(hook.overlaps.length, 5);
    assert.equal(hook.coverage, 'hosted-incomplete');
    assert.equal(s.counts.at(-1).writes, 0);
    assert(s.counts.at(-1).documents <= (laneCount > 50 ? 180 : 80));
    t.diagnostic(
      `${files} files/${laneCount} Lanes: 1 query, exactly 5 hook notices, ${meter.documents} documents, ${meter.ranges} ranges, ${meter.readBytes} DB bytes`,
    );
  });

test('exact State membership query rejects foreign objects and revoked current access', async () => {
  const s = await saveFixture();
  const api = await import(moduleUrl('../convex/projectHostedLanes.ts'));
  const lane = JSON.parse(
    [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane').value,
  );
  const args = { projectId: s.projectId, state: lane.head };
  assert.deepEqual(await s.transaction('exact-source', api.source, args), { head: args.state });
  await assert.rejects(
    s.transaction('foreign-source', api.source, { ...args, state: 'a'.repeat(64) }),
    code('SOURCE_UNAVAILABLE'),
  );
  await assert.rejects(
    s.transaction('revoked-source', api.source, args, 'revoked'),
    code('PROJECT_UNAVAILABLE'),
  );
});

// Issue 9c8490a4 (board Lane 2): notes ride the existing overlap read, so delivery adds no call.
test('board notes arrive on a Lane action once per machine; old clients and readers get no board field', async t => {
  const { s, lane, peer, transport } = await setup(t);
  s.insert('forgeAccounts', { owner: 'owner', handle: 'owner-h' });
  const id = randomUUID();
  s.insert('projectBoardInboxes', { projectId: s.projectId, key: `lane:${lane.id}`, latestAt: 10, count: 1 });
  s.insert('projectBoardMessages', {
    projectId: s.projectId,
    id,
    author: 'owner',
    fromLaneId: peer.id,
    targetKey: `lane:${lane.id}`,
    body: 'Rewriting a.txt lines 1-40; please leave them.',
    bytes: 46,
    bodyHash: 'h',
    at: 10,
    expiresAt: Date.now() + 86_400_000,
  });
  const client = transport(lane);
  const first = await client.dispatch('status', {});
  assert.deepEqual(first.board, {
    notices: [
      `Note ${id.slice(0, 8)} from @owner-h (Lane ${peer.id.slice(0, 8)}) to your Lane, quoted data: "Rewriting a.txt lines 1-40; please leave them.". Reply: board --reply {"id":"${id.slice(0, 8)}"}`,
    ],
    more: 0,
  });
  assert(!JSON.stringify(first).includes('"author":"owner"'), 'the account id never reaches the client');
  const again = await client.dispatch('status', {});
  assert.equal(again.board, undefined, 'the local cursor suppresses a repeat; no server write');
  // An older CLI sends no board argument and gets the reply it always got.
  const old = JSON.parse(
    await s.transaction('old', overlaps.read, { projectId: s.projectId, laneId: lane.id }),
  );
  assert.equal('board' in old, false);
  s.insert('projectReaders', { projectId: s.projectId, reader: 'reader' });
  const reader = JSON.parse(
    await s.transaction(
      'reader',
      overlaps.read,
      { projectId: s.projectId, laneId: lane.id, board: { after: 0 } },
      'reader',
    ),
  );
  assert.equal('board' in reader, false, 'readers never see board content');
});

/** A busy project at dogfood scale: 8 open Lanes of 25 saved paths each, a long main history. Returns
 * the Lane under test, which has saved changes and sits behind or level with main. */
async function busyProject(t, { behind }) {
  const { s, lane, main, channel } = await setup(t);
  const paths = Array.from({ length: 25 }, (_, i) => delta(`src/area-${i}/file.ts`));
  await trackChange(s, lane, paths);
  const rows = [...s.tables.projectHostedOverlapLanes.values()];
  const mineRow = rows.find(row => row.laneId === lane.id);
  for (let i = 0; i < 7; i++) {
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
    const own = paths.map((change, n) => ({
      ...change,
      // Two shared paths per peer, the rest private to that peer.
      path: n < 2 ? change.path : `src/peer-${i}/file-${n}.ts`,
      after: { ...change.after, blob: digest(peerId + n) },
    }));
    const { _id, _creationTime, presenceRow, ...template } = mineRow;
    s.insert('projectHostedOverlapLanes', {
      ...template,
      laneId: peerId,
      intentId: randomUUID(),
      actor: 'owner',
      recordVersion: 0,
      intent: 'Synthetic peer',
      head: 'b'.repeat(64),
      ...mergeOverlapChanges([], own),
    });
  }
  // A long main history: 1,500 touched paths, the shape the compact summary keeps.
  const history = advanceOverlapMain(
    null,
    5,
    Array.from({ length: 1500 }, (_, i) => `src/old/module-${i}/index.ts`),
  );
  s.insert('projectHostedOverlapMain', { projectId: s.projectId, ...history });
  // Level with main means based on the current head, so its base sequence is the current revision.
  if (!behind) s.patch('projectHostedOverlapLanes', mineRow._id, { baseSequence: 5 });
  s.patch('projectHostedChannels', channel, {
    selection: JSON.stringify({
      ...main,
      sourceRevision: 5,
      head: behind ? 'c'.repeat(64) : lane.base.head,
    }),
  });
  return { s, lane };
}

const metered = async (s, lane, name) => {
  const response = JSON.parse(
    await s.transaction(name, overlaps.read, { projectId: s.projectId, laneId: lane.id }),
  );
  return { response, meter: s.counts.at(-1) };
};

test('overlap read: a Lane level with main never reads the main path history; a Lane behind main still does', async t => {
  const level = await busyProject(t, { behind: false });
  const { response: levelResponse, meter: levelMeter } = await metered(level.s, level.lane, 'level');
  const behind = await busyProject(t, { behind: true });
  const { response: behindResponse, meter: behindMeter } = await metered(behind.s, behind.lane, 'behind');
  t.diagnostic(
    JSON.stringify({
      level: {
        documents: levelMeter.documents,
        readBytes: levelMeter.readBytes,
        byTable: levelMeter.readBytesByTable,
      },
      behind: {
        documents: behindMeter.documents,
        readBytes: behindMeter.readBytes,
        byTable: behindMeter.readBytesByTable,
      },
    }),
  );
  assert(!levelMeter.touched.includes('projectHostedOverlapMain'), 'level Lane skips the path history');
  assert(
    behindMeter.touched.includes('projectHostedOverlapMain'),
    'a Lane behind main reads the path history',
  );
  assert(
    behindMeter.readBytes - levelMeter.readBytes > 40 * 1024,
    'the 1,500-path history is the difference',
  );
  // Same answer as when the history is present: level means no commits behind, no conflicts, complete.
  assert.equal(levelResponse.behindMain.commits, 0);
  assert.deepEqual(levelResponse.behindMain.conflictingPaths, []);
  assert.equal(levelResponse.behindMain.coverage, 'hosted');
  assert.equal(levelResponse.unacknowledgedOverlaps.count, behindResponse.unacknowledgedOverlaps.count);
  // Behind main with a touched path still reports the conflict.
  const touched = [...behind.s.tables.projectHostedOverlapMain.values()][0];
  behind.s.patch('projectHostedOverlapMain', touched._id, {
    ...advanceOverlapMain(touched, 6, ['src/area-3/file.ts']),
  });
  behind.s.patch('projectHostedChannels', [...behind.s.tables.projectHostedChannels.keys()][0], {
    selection: JSON.stringify({
      ...JSON.parse([...behind.s.tables.projectHostedChannels.values()][0].selection),
      sourceRevision: 6,
    }),
  });
  const { response } = await metered(behind.s, behind.lane, 'behind-conflict');
  assert.deepEqual(response.behindMain.conflictingPaths, ['src/area-3/file.ts']);
});

// Drift nudge (Issue 8dfede85): a Lane behind main by >= N landings on its own saved paths.
async function driftRead(t, landingsOnMain) {
  const { s, lane } = await busyProject(t, { behind: true });
  const row = [...s.tables.projectHostedOverlapMain.values()][0];
  let history = row,
    landings;
  let sequence = 5;
  for (const { paths, who } of landingsOnMain) {
    sequence++;
    history = { ...history, ...advanceOverlapMain({ ...history, landings }, sequence, paths) };
    if (who) {
      landings = recordOverlapLanding(landings, {
        sequence,
        receiptId: randomUUID(),
        laneId: randomUUID(),
        actor: who,
      });
      history = { ...history, landings };
    }
  }
  const { _id, _creationTime, projectId, ...fields } = history;
  s.patch('projectHostedOverlapMain', row._id, fields);
  const channelId = [...s.tables.projectHostedChannels.keys()][0];
  s.patch('projectHostedChannels', channelId, {
    selection: JSON.stringify({
      ...JSON.parse([...s.tables.projectHostedChannels.values()][0].selection),
      sourceRevision: sequence,
    }),
  });
  return { ...(await metered(s, lane, 'drift')), lane, landings };
}

test('drift nudge: behind only on unrelated paths adds nothing and the answer stays byte-identical', async t => {
  const none = await driftRead(t, []);
  const unrelated = await driftRead(t, [
    { paths: ['elsewhere/a.ts'], who: 'owner/calm-fox' },
    { paths: ['elsewhere/b.ts'], who: 'owner/calm-fox' },
    { paths: ['elsewhere/c.ts'], who: 'owner/calm-fox' },
  ]);
  assert(!('nudge' in unrelated.response.behindMain));
  assert.deepEqual(Object.keys(unrelated.response.behindMain), Object.keys(none.response.behindMain));
  assert.deepEqual(unrelated.response.behindMain.conflictingPaths, []);
});

test('drift nudge: none below N own-path landings, named once N is reached, up to 3 plus the sync command', async t => {
  assert.equal(DRIFT_NUDGE_MIN_LANDINGS, 2);
  const one = await driftRead(t, [{ paths: ['src/area-3/file.ts'], who: 'owner/calm-fox' }]);
  assert(!('nudge' in one.response.behindMain), 'one own-path landing is below N');
  assert.deepEqual(one.response.behindMain.conflictingPaths, ['src/area-3/file.ts']);
  // Two landings on one path count once (a later touch hides the earlier one), so the count is a floor.
  const same = await driftRead(t, [
    { paths: ['src/area-3/file.ts'], who: 'owner/calm-fox' },
    { paths: ['src/area-3/file.ts'], who: 'owner/calm-fox' },
  ]);
  assert(!('nudge' in same.response.behindMain));
  const two = await driftRead(t, [
    { paths: ['src/area-3/file.ts'], who: 'owner/calm-fox' },
    { paths: ['elsewhere/a.ts'], who: 'someone' },
    { paths: ['src/area-4/file.ts'], who: 'owner' },
  ]);
  const { nudge } = two.response.behindMain;
  assert.match(nudge, /^Behind main on your own paths: 2 landings changed them since your base: /);
  const entries = JSON.parse(two.landings);
  assert(
    nudge.includes(`${entries[2][1]} (Lane ${entries[2][2]}, owner)`),
    'newest landing named with handle',
  );
  assert(nudge.includes(`${entries[0][1]} (Lane ${entries[0][2]}, owner/calm-fox)`));
  assert(!nudge.includes(entries[1][1]), 'the unrelated landing is not named');
  assert(nudge.includes(`nforge agent . sync '{"laneId":"${two.lane.id}"}'`));
  assert(!nudge.includes('@') && !nudge.includes('.com'), 'public identities only');
  const five = await driftRead(
    t,
    [3, 4, 5, 6, 7].map(n => ({ paths: [`src/area-${n}/file.ts`], who: 'owner/calm-fox' })),
  );
  assert.match(five.response.behindMain.nudge, /5 landings.*; and 2 more\. Sync now:/);
  assert.equal(five.response.behindMain.nudge.split('(Lane ').length - 1, 3, 'at most 3 named');
  // A landing from before the log existed is named by its sequence.
  const unlogged = await driftRead(t, [
    { paths: ['src/area-3/file.ts'] },
    { paths: ['src/area-4/file.ts'], who: 'owner' },
  ]);
  assert.match(unlogged.response.behindMain.nudge, /landing #6/);
});

test('drift nudge: same calls and documents with or without it; bytes grow only by the landing log', async t => {
  const plain = await driftRead(t, [{ paths: ['src/area-3/file.ts'] }, { paths: ['src/area-4/file.ts'] }]);
  const named = await driftRead(t, [
    { paths: ['src/area-3/file.ts'], who: 'owner/calm-fox' },
    { paths: ['src/area-4/file.ts'], who: 'owner/calm-fox' },
  ]);
  assert.equal(named.meter.documents, plain.meter.documents);
  assert.equal(named.meter.ranges, plain.meter.ranges);
  assert(named.meter.readBytes - plain.meter.readBytes < 1024, 'two log entries are a few hundred bytes');
  t.diagnostic(
    JSON.stringify({
      documents: named.meter.documents,
      ranges: named.meter.ranges,
      readBytesWithLog: named.meter.readBytes,
      readBytesWithoutLog: plain.meter.readBytes,
      nudgeBytes: Buffer.byteLength(named.response.behindMain.nudge),
    }),
  );
});

test('drift nudge: landing log is idempotent, bounded, and survives a main path advance', () => {
  let log;
  for (let n = 1; n <= DRIFT_LANDING_LOG + 5; n++)
    log = recordOverlapLanding(log, {
      sequence: n,
      receiptId: randomUUID(),
      laneId: randomUUID(),
      actor: 'a/b-c',
    });
  const entries = JSON.parse(log);
  assert.equal(entries.length, DRIFT_LANDING_LOG);
  assert.equal(entries[0][0], 6);
  assert.equal(
    recordOverlapLanding(log, { sequence: 20, receiptId: randomUUID(), laneId: randomUUID(), actor: 'x' }),
    log,
  );
  const advanced = advanceOverlapMain({ sequence: 1, coverageAfter: 0, changes: '[]', landings: log }, 2, [
    'p',
  ]);
  assert.equal(advanced.landings, log);
  assert(!('landings' in advanceOverlapMain(null, 1, ['p'])));
  assert.equal(driftNudge('lane', new Set([1]), log), null);
  assert.equal(driftNudge('lane', new Set([1, 2]), 'not json').includes('landing #2'), true);
});

test('drift nudge: a landing completion logs receipt, Lane and public actor on the main row once', async t => {
  const { s, lane, transport } = await setup(t);
  await transport(lane).dispatch('save', { operationId: randomUUID(), message: 'work' });
  const row = [...s.tables.projectHostedOverlapLanes.values()].find(item => item.laneId === lane.id);
  s.insert('projectHostedOverlapMain', { projectId: s.projectId, ...advanceOverlapMain(null, 6, ['a']) });
  const receiptId = randomUUID();
  const object = { object: { sha256: 'a'.repeat(64), size: 1 }, recipe: null };
  s.insert('projectHostedAcceptancePages', {
    projectId: s.projectId,
    receiptId,
    kind: 'inputs',
    index: 0,
    digest: 'd'.repeat(64),
    root: 'r'.repeat(64),
    value: JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-compose-page',
      entries: [
        { laneId: lane.id, head: row.head, version: 0, sourceVersion: 0, lifecycleVersion: 0, state: object },
      ],
      next: null,
    }),
  });
  const retire = () =>
    s.transaction(
      'retire',
      {
        _handler: ctx =>
          landed.retireLandedOverlapLanes(
            ctx,
            { projectId: s.projectId, receiptId },
            { commit: 'c'.repeat(64), at: new Date().toISOString(), sequence: 6 },
          ),
      },
      {},
    );
  await retire();
  await retire();
  const main = [...s.tables.projectHostedOverlapMain.values()][0];
  assert.deepEqual(JSON.parse(main.landings), [[6, receiptId.slice(0, 8), lane.id.slice(0, 8), row.actor]]);
  assert.equal(main.changes, advanceOverlapMain(null, 6, ['a']).changes, 'path history untouched');
});

// Issue 9a19b304 (friction 2904bf4f): the behind-main nudge printed the landing actor's account id.
test('drift nudge: a landing by an account logs its Forge handle, never the account id', async t => {
  const { s, lane, transport } = await setup(t);
  await transport(lane).dispatch('save', { operationId: randomUUID(), message: 'work' });
  const subject = 'user_2abcDEFghiJKLmnoPQRstUVwxYZ';
  const row = [...s.tables.projectHostedOverlapLanes.values()].find(item => item.laneId === lane.id);
  s.patch('projectHostedOverlapLanes', row._id, { actor: subject, agent: 'calm-fox' });
  s.insert('forgeAccounts', { owner: subject, handle: 'builder' });
  s.insert('projectHostedOverlapMain', { projectId: s.projectId, ...advanceOverlapMain(null, 6, ['a']) });
  const receiptId = randomUUID();
  const object = { object: { sha256: 'a'.repeat(64), size: 1 }, recipe: null };
  s.insert('projectHostedAcceptancePages', {
    projectId: s.projectId,
    receiptId,
    kind: 'inputs',
    index: 0,
    digest: 'd'.repeat(64),
    root: 'r'.repeat(64),
    value: JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-compose-page',
      entries: [
        { laneId: lane.id, head: row.head, version: 0, sourceVersion: 0, lifecycleVersion: 0, state: object },
      ],
      next: null,
    }),
  });
  await s.transaction(
    'retire',
    {
      _handler: ctx =>
        landed.retireLandedOverlapLanes(
          ctx,
          { projectId: s.projectId, receiptId },
          { commit: 'c'.repeat(64), at: new Date().toISOString(), sequence: 6 },
        ),
    },
    {},
  );
  const main = [...s.tables.projectHostedOverlapMain.values()][0];
  assert.equal(JSON.parse(main.landings)[0][3], 'builder/calm-fox');
  assertNoAccountIds(assert, main.landings, 'landing log');
  const nudge = driftNudge('lane', new Set([6, 7]), main.landings);
  assert(nudge.includes(`(Lane ${lane.id.slice(0, 8)}, builder/calm-fox)`), nudge);
  assertNoAccountIds(assert, nudge, 'nudge');
});

test('drift nudge: log entries written before the fix, with an account id, are named without it', () => {
  const old = JSON.stringify([[6, 'aaaaaaaa', 'bbbbbbbb', 'user_2abcDEFghiJKLmnoPQRstUVwxYZ/calm-fox']]);
  const nudge = driftNudge('lane', new Set([6, 7]), old);
  assert(nudge.includes('aaaaaaaa (Lane bbbbbbbb)'), nudge);
  assertNoAccountIds(assert, nudge, 'legacy nudge');
});
