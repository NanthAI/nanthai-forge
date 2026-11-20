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

export async function itemWorkFixture({ extra = 0, itemId = randomUUID() } = {}) {
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
  const lane = async state => {
    const record = {
      kind: 'lane',
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
  const open = await lane('active');
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
