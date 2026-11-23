// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { ConvexLaneTransport } from '../dist/hosted-lane-transport.js';
import { journalSegmentText, journalTablePins } from '../dist/journal-segment.js';
import { encodeArchiveBytes } from '../dist/landing-capsule-bytes.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { syncFixture, code } from './hosted-sync-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const api = await import(moduleUrl('../convex/projectHostedUndo.ts'));
const files = (s, head) => JSON.parse(s.objects.get(head)).files;
const request = (s, lane, target = {}) => ({
  kind: 'undo',
  operationId: randomUUID(),
  authorityEpoch: 1,
  laneId: lane.laneId,
  expected: s.pins(lane),
  ...target,
});
const undo = (s, input, actor = 'owner') =>
  s
    .call('undo', api.undo, { projectId: s.projectId, request: JSON.stringify(input) }, actor)
    .then(JSON.parse);
const saves = (s, lane) =>
  [...s.tables.projectHostedRecordHeads.values()]
    .filter(row => row.kind === 'save' && row.parent === lane.laneId)
    .map(row => row.key);
const main = s => [...s.tables.projectHostedChannels.values()][0].selection;
const jobCount = s =>
  [...s.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'job').length;

test('undo reuses a retained 100-file State in one mutation and replay keeps a later Lane head', async () => {
  const s = await syncFixture({
      baselineFiles: Array.from({ length: 98 }, (_, i) => [`f-${i}.txt`, `original ${i}\n`]),
    }),
    start = await s.lane(s.baseline);
  const first = await s.save(
    start,
    files(s, start.head).map((file, i) =>
      i < 40 ? s.file(file.path, `first version of ${file.path}\n`) : file,
    ),
  );
  const second = await s.save(first, [
    ...files(s, first.head).filter(file => file.path !== 'a.txt'),
    s.file('a.txt', 'second save\n'),
  ]);
  const before = {
    objects: s.objects.size,
    jobs: jobCount(s),
    states: s.tables.projectHostedStates.size,
    main: main(s),
    calls: s.counts.length,
  };
  const op = request(s, second);
  const started = performance.now();
  const receipt = await undo(s, op);
  const [io] = s.counts.slice(before.calls);
  assert.equal(s.counts.length, before.calls + 1);
  assert.equal(receipt.operationId, op.operationId);
  assert.equal(receipt.from.head, second.head);
  assert.equal(receipt.lane.head, first.head);
  assert.equal(receipt.lane.sourceVersion, second.sourceVersion + 1);
  assert.equal(files(s, receipt.lane.head).length, 100);
  assert.equal(s.objects.size, before.objects);
  assert.equal(jobCount(s), before.jobs);
  assert.equal(s.tables.projectHostedStates.size, before.states);
  assert.equal(main(s), before.main);
  console.log(
    '100-file Lane undo fixture',
    JSON.stringify({
      calls: 1,
      ranges: io.ranges,
      documents: io.documents,
      readBytes: io.readBytes,
      writes: io.writes,
      writeBytes: io.writeBytes,
      r2ObjectsWritten: 0,
      fixtureWallMs: Math.round(performance.now() - started),
      processMaxRssKiB: process.resourceUsage().maxRSS,
    }),
  );

  const [firstSave, secondSave] = saves(s, start);
  const redo = await undo(s, request(s, receipt.lane, { saveId: secondSave }));
  assert.equal(redo.lane.head, second.head);
  const restored = await undo(s, request(s, redo.lane, { saveId: firstSave }));
  assert.equal(restored.lane.head, first.head);
  assert.equal(restored.restored.saveId, firstSave);
  assert.deepEqual(await undo(s, op), receipt, 'unknown result returns the original receipt');
  assert.equal((await s.readLane(start.laneId)).entry.version, restored.lane.version);
  await assert.rejects(undo(s, { ...op, saveId: firstSave }), code('WORK_OPERATION_CHANGED'));
  await assert.rejects(undo(s, request(s, second)), code('WORK_STALE'));
});

for (const overlap of [false, true])
  test(`undo with ${overlap ? 'overlapping' : 'disjoint'} accepted work composes from the exact saved State`, async () => {
    const s = await syncFixture();
    const start = await s.lane(s.baseline);
    const first = await s.save(start, [s.file('a.txt', 'Lane line\nb\nc\n'), s.hidden]);
    const peerFiles = overlap
      ? [s.file('a.txt', 'Peer line\nb\nc\n'), s.hidden]
      : [s.baseFile, s.hidden, s.file('peer.txt', 'accepted peer work\n')];
    const peerMain = s.state(peerFiles, [s.baseline.sha256]);
    s.register(peerMain);
    s.moveMain(peerMain.sha256);
    const accepted = main(s);
    const second = await s.save(first, [s.file('a.txt', 'Second Lane save\nb\nc\n'), s.hidden]);
    const restored = await undo(s, request(s, second));
    assert.equal(restored.lane.head, first.head);
    assert.equal(main(s), accepted);
    const entry = (await s.readLane(start.laneId)).entry;
    const composition = s.selection([entry], [], {
      expectedMain: { head: peerMain.sha256, receiptId: 'main-1' },
    });
    await s.prepare(composition);
    await s.stage(composition);
    await s.submit(composition);
    const result = (await s.publish(await s.work(composition))).outcome.result.result;
    if (overlap) {
      assert.equal(result.status, 'conflict');
      const conflict = JSON.parse(s.objects.get(result.conflicts.sha256));
      assert.deepEqual(
        conflict.paths.map(file => file.path),
        ['a.txt'],
      );
    } else {
      assert.equal(result.status, 'clean');
      assert.deepEqual(
        files(s, result.head).find(file => file.path === 'peer.txt'),
        peerFiles.at(-1),
      );
    }
    assert.equal(main(s), accepted);
  });

test('undo refuses a save from another Lane and a contributor writing someone else’s Lane', async () => {
  const s = await syncFixture(),
    start = await s.lane(s.baseline),
    other = await s.lane(s.baseline);
  await s.save(other, [s.file('a.txt', 'other\n'), s.hidden]);
  const [saveId] = saves(s, other);
  s.insert('projectContributors', { projectId: s.projectId, contributor: 'writer' });
  await assert.rejects(undo(s, request(s, start, { saveId })), code('NOT_FOUND'));
  await assert.rejects(undo(s, request(s, start, { version: 0 }), 'writer'), code('PROJECT_UNAVAILABLE'));
  assert.equal((await s.readLane(start.laneId)).entry.head, start.head);
});

test('undo restores an archived Lane version through the same exact Lane guard', async () => {
  const s = await syncFixture(),
    original = await s.lane(s.baseline),
    current = await s.save(original, [s.file('a.txt', 'new save\n'), s.hidden]);
  const header = [...s.tables.projectHostedRecords.values()].find(
    row => row.kind === 'lane' && row.key === original.laneId && row.version === 0,
  );
  const body = s.tables.projectHostedRecordBodies.get(header.bodyId);
  const segment = {
    protocol: 1,
    kind: 'forge-journal-segment',
    projectId: s.projectId,
    scope: 'records',
    from: 0,
    through: 0,
    tables: {
      projectHostedRecords: [canonicalPayload(header)],
      projectHostedRecordBodies: [canonicalPayload(body)],
    },
  };
  const { pointer } = encodeArchiveBytes(journalSegmentText(segment), 0, journalTablePins(segment.tables));
  const position = `${s.projectId}:${header._creationTime.toFixed(6).padStart(23, '0')}:${header._id}`;
  const index = { scope: segment.scope, from: 0, through: 0, pointer };
  s.insert('projectJournalSegments', {
    projectId: s.projectId,
    key: pointer.sha256,
    scope: index.scope,
    from: index.from,
    through: index.through,
    category: 'record',
    recordKind: 'lane',
    firstPosition: position,
    lastPosition: position,
    value: canonicalPayload(index),
  });
  s.patch('hostedProjects', s.projectId, { journalRevision: 1 });
  s.patch('projectHostedRecords', header._id, { journalSegment: pointer.sha256 });
  s.tables.projectHostedRecordBodies.delete(header.bodyId);

  const op = request(s, current, { version: 0 });
  await assert.rejects(undo(s, op), error => error.data?.undoHistory === true);
  assert(![...s.tables.projectHostedOperations.values()].some(row => row.operationId === op.operationId));
  const applyArchived = input =>
    s
      .call('undoArchive', api.archived, {
        projectId: s.projectId,
        request: JSON.stringify(input),
        segments: [canonicalPayload({ sha256: pointer.sha256, segment })],
      })
      .then(JSON.parse);
  const restored = await applyArchived(op);
  assert.equal(restored.lane.head, original.head);
  assert.deepEqual(await undo(s, op), restored, 'replay needs no archived bytes');
  await assert.rejects(applyArchived(request(s, current, { version: 0 })), code('WORK_STALE'));
});

async function undoCheckout(t) {
  const s = agentFixture(t, { base: { 'a.txt': 'earlier\n' }, lane: { 'a.txt': 'saved\n' } });
  s.caps.features = ['lane-undo'];
  const original = structuredClone(s.lane);
  await checkoutHostedLane(
    s.root,
    {
      operationId: randomUUID(),
      url: s.address.url,
      projectId: s.address.projectId,
      laneId: original.laneId,
    },
    new ConvexLaneTransport(s.exchange),
  );
  const send = s.exchange.client.mutation;
  const receipts = new Map();
  t.mock.method(s.exchange.client, 'mutation', async (ref, input) => {
    if (getFunctionName(ref) !== 'projectHostedUndo:undo') return send(ref, input);
    const asked = JSON.parse(input.request);
    if (!receipts.has(asked.operationId)) {
      assert.equal(asked.expected.head, s.lane.head);
      assert.equal(asked.expected.version, s.lane.version);
      Object.assign(s.lane, {
        head: s.main.head,
        version: s.lane.version + 1,
        sourceVersion: s.lane.sourceVersion + 1,
      });
      receipts.set(asked.operationId, {
        operationId: asked.operationId,
        at: '2026-01-01T00:00:00.000Z',
        lane: structuredClone(s.lane),
        from: { laneId: asked.laneId, ...asked.expected },
        restored: { head: s.main.head, version: 0 },
      });
    }
    const receipt = receipts.get(asked.operationId);
    assert.equal(asked.expected.head, receipt.from.head);
    return JSON.stringify(receipt);
  });
  return { s, original, receipts };
}

test('forge_task undo returns the hosted receipt and leaves clashing local edits in place', async t => {
  const { s, original } = await undoCheckout(t);
  const tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, _config, call) {
          tools.set(name, call);
        },
      },
      s.transport(),
    ),
  );
  const operationId = randomUUID();
  const call = () =>
    tools.get('forge_task')(
      { command: { action: 'undo', operationId } },
      {
        signal: new AbortController().signal,
      },
    );
  const path = join(s.root, 'a.txt');
  writeFileSync(path, 'local edit\n');
  const blocked = await call();
  const { error } = JSON.parse(blocked.content[0].text);
  assert.equal(blocked.isError, true);
  assert.equal(error.code, 'WORK_CONFLICT');
  assert.equal(error.recovery.sourceCompleted, true);
  assert.equal(error.recovery.operationId, operationId);
  assert.equal(error.recovery.completed.lane.head, s.main.head);
  assert.equal(error.recovery.blockers[0].path, 'a.txt');
  assert.equal(readFileSync(path, 'utf8'), 'local edit\n');
  assert.equal(readHostedLaneCheckout(s.root).selection.head, original.head);
  writeFileSync(path, 'saved\n');
  const finished = await call();
  assert.equal(finished.isError, undefined);
  assert.equal(JSON.parse(finished.content[0].text).result.lane.head, s.main.head);
  assert.equal(readFileSync(path, 'utf8'), 'earlier\n');
});

test('undo replay cannot install an obsolete State after a blocked local apply', async t => {
  const { s, original } = await undoCheckout(t);
  const transport = s.transport();
  const operationId = randomUUID();
  const call = () => transport.dispatch('undo', { operationId });
  const path = join(s.root, 'a.txt');
  writeFileSync(path, 'local edit\n');
  await assert.rejects(call(), code('WORK_CONFLICT'));
  writeFileSync(path, 'saved\n');
  Object.assign(s.lane, { head: original.head, version: 2, sourceVersion: 2 });
  await assert.rejects(call(), error => {
    assert.equal(error.code, 'WORK_STALE');
    assert.equal(error.recovery.completed.lane.head, s.main.head);
    assert.equal(error.recovery.superseded.current.version, 2);
    return true;
  });
  assert.equal(readFileSync(path, 'utf8'), 'saved\n');
  assert.deepEqual(readHostedLaneCheckout(s.root).selection, original);
});

test('hosted-only undo starts fresh after a newer save and an explicit replay returns the original receipt', async t => {
  const { s, original, receipts } = await undoCheckout(t);
  const transport = s.transport();
  const command = { laneId: original.laneId, apply: false };
  Object.assign(s.lane, { version: 1, sourceVersion: 1 });
  const first = await transport.dispatch('undo', command);
  assert.equal(first.result.from.version, 1, 'hosted-only uses the exact server pins');
  Object.assign(s.lane, { head: original.head, version: 3, sourceVersion: 3 });
  const before = s.calls.length;
  const second = await transport.dispatch('undo', command);
  assert.equal(second.result.from.version, 3);
  assert.equal(receipts.size, 2);
  assert.equal(s.calls.slice(before).filter(call => call.name === 'projectHostedLanes:select').length, 1);
  const replay = await transport.dispatch('undo', { ...command, operationId: first.operationId });
  assert.deepEqual(replay.result, first.result);
  assert.deepEqual(readHostedLaneCheckout(s.root).selection, original);
});
