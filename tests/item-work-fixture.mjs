// SPDX-License-Identifier: Apache-2.0
// Shared synthetic data for the CLI reader and the rendered Item Work route.
import { randomUUID } from 'node:crypto';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const work = await import(moduleUrl('../convex/projectItemWork.ts'));
const hash = 'a'.repeat(64),
  other = 'b'.repeat(64),
  at = '2026-01-01T00:00:00.000Z';

export async function itemWorkFixture({ extra = 0, itemId = randomUUID(), details = false } = {}) {
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
  const stamped = await lane('completed');
  for (let i = 0; i < extra; i++) await lane('abandoned');
  const noted = await lane('completed');
  const open = await lane(
    'active',
    details
      ? { authorship: { kind: 'agent' }, agentRun: 'cobalt-fox', agentClient: 'codex:gpt-6.2-sol' }
      : undefined,
  );
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
  const initiativeId = randomUUID();
  const dependencyId = randomUUID();
  const followUpId = randomUUID();
  if (details) {
    const project = await s.ctx.db.get(auth.projectId);
    const backupId = project.work?.backupId ?? 'backup';
    const generationId = await s.ctx.db.insert('projectWorkGenerations', {
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
    ]) {
      for (const collection of ['planningSearch', 'planningItems'])
        await s.ctx.db.insert('projectPlanningRecords', {
          projectId: auth.projectId,
          generationId,
          collection,
          key: id,
          parent: '',
          position: 0,
          value: JSON.stringify({ id, kind: 'issue', status: 'open', ...fields }),
        });
    }
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
  return {
    ...s,
    auth,
    as,
    itemId,
    initiativeId,
    dependencyId,
    followUpId,
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
