// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Shared synthetic data for the CLI reader and the rendered Item Work route.
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const work = await import(moduleUrl('../convex/projectItemWork.ts'));
const initiativeWork = await import(moduleUrl('../convex/projectInitiativeWork.ts'));
const rebuild = await import(moduleUrl('../convex/projectInitiativeWorkRebuild.ts'));
const fold = await import(moduleUrl('../convex/projectInitiativeWorkFold.ts'));
const workIndex = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
const hash = 'a'.repeat(64),
  other = 'b'.repeat(64),
  at = '2026-01-01T00:00:00.000Z';

export async function itemWorkFixture({
  extra = 0,
  extraOpen = 0,
  itemId = randomUUID(),
  initiativeId = randomUUID(),
  details = false,
} = {}) {
  const s = recordsFixture(),
    auth = await s.setup();
  const as = subject => {
    s.ctx.auth = { getUserIdentity: async () => (subject ? { subject } : null) };
  };
  as('owner');
  await s.ctx.db.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  await s.ctx.db.insert('accountHandles', { owner: 'owner', handle: 'synthetic-owner' });
  const put = record =>
    s.run('put', () => records.writeHostedRecord(s.ctx, { ...auth, record, expectedVersion: null }));
  await put({
    kind: 'intent',
    id: itemId,
    version: 0,
    at,
    outcome: 'Synthetic outcome',
    constraints: '',
    creatorAccountId: 'owner',
    assigneeAccountIds: [],
    base: { head: hash, receiptId: randomUUID() },
    status: 'active',
  });
  const lane = async (state, authorship) => {
    const record = {
      kind: 'lane',
      ...authorship,
      id: randomUUID(),
      version: 0,
      at,
      intentId: itemId,
      actor: 'owner',
      base: { head: hash, receiptId: randomUUID() },
      head: other,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state,
      authorityEpoch: 1,
    };
    await put(record);
    return record;
  };
  const abandoned = await lane('abandoned');
  for (let i = 0; i < extra; i++) await lane('abandoned');
  const stamped = await lane('completed');
  const noted = await lane('completed');
  const open = await lane(
    'active',
    details
      ? { authorship: { kind: 'agent' }, agentRun: 'cobalt-fox', agentClient: 'codex:gpt-6.2-sol' }
      : undefined,
  );
  for (let i = 0; i < extraOpen; i++) await lane('active');
  // A landing since 3a733ee8 writes a note per Intent; an older one left only the overlap row's stamp.
  const noteReceipt = randomUUID(),
    stampReceipt = randomUUID();
  await s.ctx.db.insert('projectIntentLandingNotes', {
    projectId: auth.projectId,
    intentId: itemId,
    receiptId: noteReceipt,
    kind: 'landed',
    at,
    laneIds: [noted.id],
    commit: 'c'.repeat(64),
    sequence: 42,
    actor: 'owner',
    landedBy: { by: 'queue', review: 'none' },
  });
  const overlap = [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === stamped.id);
  const stamp = { landed: { receiptId: stampReceipt, commit: 'd'.repeat(64), laneHead: other, at } };
  if (overlap) await s.ctx.db.patch(overlap._id, stamp);
  else
    await s.ctx.db.insert('projectHostedOverlapLanes', {
      projectId: auth.projectId,
      laneId: stamped.id,
      intentId: itemId,
      actor: 'owner',
      head: other,
      baseHead: hash,
      baseReceiptId: randomUUID(),
      baseSequence: 1,
      recordVersion: 0,
      open: false,
      changes: '[]',
      complete: true,
      ...stamp,
    });
  const dependencyId = randomUUID();
  const followUpId = randomUUID();
  const settledBlockerId = randomUUID();
  let generationId;
  let position = 0;
  const planning = async (id, fields, text) => {
    const value = { id, kind: 'issue', status: 'open', ...fields };
    const entry = {
      projectId: auth.projectId,
      generationId,
      key: id,
      parent: '',
      position: position++,
      value: JSON.stringify(value),
    };
    for (const collection of ['planningSearch', 'planningItems'])
      await s.ctx.db.insert('projectPlanningRecords', {
        ...entry,
        collection,
        ...(collection === 'planningSearch'
          ? {
              planning: {
                text: text ?? value.title,
                open: ['proposed', 'open', 'in-progress'].includes(value.status),
                kind: value.kind,
                status: value.status,
                initiativeId: value.initiativeId ?? '',
              },
            }
          : {}),
      });
  };
  const addLandingNote = (sequence, overrides = {}) =>
    s.ctx.db.insert('projectIntentLandingNotes', {
      projectId: auth.projectId,
      intentId: itemId,
      receiptId: randomUUID(),
      kind: 'landed',
      at,
      laneIds: [open.id],
      commit: other,
      sequence,
      actor: 'owner',
      ...overrides,
    });
  if (details) {
    const project = await s.ctx.db.get(auth.projectId);
    const backupId = project.work?.backupId ?? 'backup';
    generationId = await s.ctx.db.insert('projectWorkGenerations', {
      projectId: auth.projectId,
      backupId,
      format: 11,
      status: 'ready',
      initialRevision: 0,
      revision: 0,
      nextBatch: 0,
      metadata: '{"schema":24}',
    });
    await s.ctx.db.patch(auth.projectId, {
      work: {
        operationId: randomUUID(),
        initialRevision: 0,
        revision: 0,
        ...project.work,
        generationId,
        backupId,
      },
    });
    for (const [id, fields] of [
      [
        itemId,
        {
          title: 'Synthetic outcome',
          initiativeId,
          relations: [
            { kind: 'depends-on', id: dependencyId },
            { kind: 'related', id: followUpId },
          ],
        },
      ],
      [initiativeId, { kind: 'initiative', title: 'Parser release' }],
      [dependencyId, { status: 'closed', title: 'Define the wire format' }],
      [
        settledBlockerId,
        {
          status: 'closed',
          initiativeId,
          title: 'Document compatibility',
          relations: [{ kind: 'depends-on', id: itemId }],
        },
      ],
      [
        followUpId,
        {
          title: 'Cover retry cases',
          body: `Split from ${itemId.slice(0, 8)}.
`,
          relations: [
            { kind: 'related', id: itemId },
            { kind: 'depends-on', id: itemId },
          ],
        },
      ],
    ])
      await planning(id, fields);
    await put({
      kind: 'save',
      id: randomUUID(),
      version: 0,
      at,
      laneId: open.id,
      actor: 'owner',
      operationId: randomUUID(),
      expectedHead: other,
      expectedSourceVersion: 0,
      head: other,
      sourceVersion: 0,
      changes: { sha256: hash, size: 0 },
    });
    const candidateId = randomUUID();
    const root = { sha256: hash, size: 0 };
    await put({
      kind: 'candidate',
      id: candidateId,
      intentId: itemId,
      version: 0,
      at,
      base: { head: hash, receiptId: randomUUID() },
      inputs: root,
      dependencies: root,
      algorithm: 'fixture',
      result: { status: 'clean', head: 'c'.repeat(64) },
      governance: { version: 1, paths: ['src/parser.ts', 'tests/parser.test.mjs'], ownerInputs: true },
    });
    // The Work read projects only these acceptance fields.
    await s.ctx.db.insert('projectHostedAcceptances', {
      projectId: auth.projectId,
      receiptId: noteReceipt,
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: 42,
      value: JSON.stringify({
        at,
        snapshot: { revision: 42 },
        candidate: { id: candidateId, head: 'c'.repeat(64) },
        check: { runId: randomUUID() },
      }),
    });
  }
  const addUnrelatedLanes = async count => {
    // Same project's Lane-head index, but parents outside the selected Item's Intent chain.
    const recordId = [...s.tables.projectHostedRecords.keys()][0];
    for (let i = 0; i < count; i++)
      await s.ctx.db.insert('projectHostedRecordHeads', {
        projectId: auth.projectId,
        kind: 'lane',
        key: randomUUID(),
        parent: randomUUID(),
        status: 'active',
        version: 0,
        recordId,
      });
  };
  const readRaw = (args = {}, name = 'read') =>
    s.call(name, work.read, { projectId: auth.projectId, itemId, ...args });
  const read = async (...args) => JSON.parse(await readRaw(...args));
  const readInitiativeRaw = (args = {}, name = 'initiative') =>
    s.call(name, initiativeWork.read, { projectId: auth.projectId, initiativeId, ...args });
  const workTasks = [];
  const workHandlers = {
    'projectInitiativeWorkRebuild:advance': rebuild.advance,
    'projectInitiativeWorkRebuild:refresh': rebuild.refresh,
    'projectInitiativeWorkFold:fold': fold.fold,
    'projectWorkIndexStore:sweep': workIndex.sweep,
  };
  const schedule = s.ctx.scheduler.runAfter;
  s.ctx.scheduler.runAfter = async (delay, ref, args) => {
    const name = getFunctionName(ref);
    if (!(name in workHandlers)) return schedule(delay, ref, args);
    workTasks.push({ name, args });
    return `work-${workTasks.length}`;
  };
  const drainWork = async () => {
    while (workTasks.length) {
      const { name, args } = workTasks.shift();
      await s.call(name, workHandlers[name], args);
    }
  };
  const rebuildInitiative = async (id = initiativeId) => {
    await s.call('backfill', rebuild.backfill, { projectId: auth.projectId, initiativeId: id });
    await drainWork();
  };
  const foldInitiative = args => s.call('fold', fold.fold, { projectId: auth.projectId, ...args });
  const publishWork = generationId =>
    s.call('publishWork', workIndex.publish, {
      projectId: auth.projectId,
      generationId,
      owner: 'owner',
      batches: 0,
    });
  return {
    ...s,
    auth,
    as,
    itemId,
    initiativeId,
    dependencyId,
    followUpId,
    settledBlockerId,
    planning,
    addLandingNote,
    readInitiativeRaw,
    rebuildInitiative,
    foldInitiative,
    publishWork,
    drainWork,
    workTasks,
    put,
    open,
    noted,
    stamped,
    abandoned,
    noteReceipt,
    stampReceipt,
    read,
    readRaw,
    addUnrelatedLanes,
  };
}
