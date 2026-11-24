// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { previewPlanningRollup, summarizeRollupDryRun } from '../dist/planning-rollup-preview.js';
import { successorIntentId } from '../dist/hosted-intent-chain.js';
import { moduleUrl } from './convex-module.mjs';
import { recordsFixture } from './hosted-records-fixture.mjs';

const { page, approvedDevRollup } = await import(moduleUrl('../convex/projectPlanRollupPreview.ts'));
const exact = await import(moduleUrl('../convex/projectPlanRollupExact.ts'));
const { addPlanLane, removePlanLanes } = await import(moduleUrl('../convex/projectPlanLaneMarks.ts'));
const { verifiedItemMembership } = await import(moduleUrl('../convex/projectItemMembershipVersion.ts'));
const row = (id, fields) => ({
  id,
  kind: 'issue',
  status: 'open',
  version: 1,
  work: 'none',
  checked: 0,
  unchecked: 0,
  ...fields,
});

test('dry run folds from leaves and reports transition counts without moving pins, Proposed Items or a cycle', () => {
  const result = previewPlanningRollup([
    row('group', { kind: 'initiative' }),
    row('parent', { status: 'in-progress', initiativeId: 'group' }),
    row('middle', { pinned: true, status: 'closed', parentId: 'parent', initiativeId: 'group' }),
    row('leaf', { work: 'completed', status: 'in-progress', parentId: 'middle', initiativeId: 'group' }),
    row('proposed', { status: 'proposed', work: 'completed' }),
    row('stopped', { kind: 'initiative' }),
    row('a', { parentId: 'b', initiativeId: 'stopped' }),
    row('b', { parentId: 'a' }),
  ]);
  assert.deepEqual(
    result.changes.map(change => change.id),
    ['leaf', 'parent', 'group'],
  );
  assert.deepEqual(result.transitions, { 'issue:in-progress:closed': 2, 'initiative:open:closed': 1 });
  assert.equal(result.cyclicItems, 2);
  assert.equal(result.blockedInitiatives, 1);
  assert.equal(result.pinned, 1);
  assert.equal(result.proposed, 1);
});

test('unknown child facts cannot close an ancestor or its Initiative, and duplicate roots invalidate the preview', () => {
  const rows = [
    row('initiative', { kind: 'initiative' }),
    row('parent', { initiativeId: 'initiative', work: 'completed' }),
    row('child', { parentId: 'parent', status: 'closed', incomplete: true }),
    row('unrelated', { work: 'completed' }),
  ];
  const result = previewPlanningRollup(rows);
  assert.deepEqual(
    result.changes.map(change => change.id),
    ['unrelated'],
  );
  assert.equal(result.incompleteRows, 1);
  assert.equal(result.blockedInitiatives, 1);
  assert.throws(() => previewPlanningRollup([...rows, rows[0]]), /duplicate planning roots/);
});

async function fixture() {
  const s = recordsFixture();
  const { projectId } = await s.setup();
  const backupId = 'synthetic-backup';
  const generationId = await s.ctx.db.insert('projectWorkGenerations', {
    projectId,
    backupId,
    format: 11,
    status: 'ready',
    revision: 1,
    initialRevision: 1,
    nextBatch: 0,
    metadata: '{"schema":24}',
  });
  await s.ctx.db.patch(projectId, {
    work: { backupId, generationId, operationId: 'synthetic-index', initialRevision: 1, revision: 1 },
  });
  const headId = await s.ctx.db.insert('projectWorkHeads', { projectId, backupId, revision: 2 });
  const put = async (id, fields) => {
    const row = {
      projectId,
      generationId,
      key: id,
      parent: '',
      position: 0,
      value: JSON.stringify({
        id,
        kind: 'issue',
        status: 'open',
        version: 1,
        body: '',
        title: 'Synthetic private title',
        ...fields,
      }),
    };
    await s.ctx.db.insert('projectPlanningRecords', { ...row, collection: 'planningItems' });
    await s.ctx.db.insert('projectPlanningRecords', { ...row, collection: 'planningSearch' });
  };
  const intent = (key, status, planningItemId) =>
    s.ctx.db.insert('projectHostedRecordHeads', {
      projectId,
      kind: 'intent',
      key,
      status,
      version: 1,
      parent: '',
      recordId: 'synthetic-work-pointer',
      ...(planningItemId ? { planningItemId } : {}),
    });
  const read = (extra = {}) => s.call('preview', page, { projectId, after: '', ...extra });
  return { ...s, projectId, generationId, read, put, intent, headId };
}

test('verified roll-up uses the open-Lane tally across earlier Intents and latest completion without a history walk', async t => {
  const s = await fixture();
  t.mock.property(process, 'env', {
    ...process.env,
    CONVEX_CLOUD_URL: 'https://benevolent-wildebeest-974.convex.cloud',
  });
  await s.put('a', {});
  await s.intent('a', 'abandoned', 'a');
  let id = 'a';
  for (let i = 0; i < 23; i++) await s.intent((id = successorIntentId(id)), 'abandoned', 'a');
  await s.intent(successorIntentId(id), 'completed', 'a');
  const earlier = successorIntentId('a');
  const lane = await s.ctx.db.insert('projectHostedRecordHeads', {
    projectId: s.projectId,
    kind: 'lane',
    key: 'earlier-lane',
    parent: earlier,
    status: 'active',
    version: 1,
    recordId: 'synthetic-lane-pointer',
    planningItemId: 'a',
  });
  const mark = await addPlanLane(s.ctx, s.projectId, { id: 'a', kind: 'issue', status: 'open', position: 0 });
  await s.put('b', { intentIds: ['a'] });
  await s.put('c', { intentIds: [earlier] });
  const legacy = await s.read();
  assert.equal(legacy.rows[0].work, 'active');
  const legacyCost = s.counts.at(-1);

  await s.ctx.db.patch(s.projectId, {
    itemLaneMembership: verifiedItemMembership,
    planLaneMarkCoverage: { generationId: s.generationId, cursor: null },
  });
  const indexed = await s.read();
  const indexedCost = s.counts.at(-1);
  assert.deepEqual(
    indexed.rows.map(({ id, work }) => [id, work]),
    [
      ['a', 'active'],
      ['b', 'active'],
      ['c', 'active'],
    ],
  );
  assert.equal(indexed.intentKeys, 4);
  assert(indexedCost.documents < legacyCost.documents);
  assert(indexedCost.readBytes < legacyCost.readBytes);
  t.diagnostic(
    `legacy ${legacyCost.documents} docs/${legacyCost.readBytes} bytes; verified ${indexedCost.documents} docs/${indexedCost.readBytes} bytes`,
  );

  await removePlanLanes(s.ctx, mark, [undefined]);
  await s.ctx.db.patch(lane, { status: 'completed' });
  const settled = await s.read();
  assert.equal(settled.rows[0].work, 'completed');
  assert.notEqual(settled.rows[0].workStamp, indexed.rows[0].workStamp, 'the tally is fenced for apply');
  assert.equal(settled.rows[1].work, 'completed', 'an Item-root link keeps its successor completion');
  assert.equal(settled.rows[2].work, 'abandoned', 'a bare Intent does not borrow a foreign Item tally');
});

test('exact preview and drift I/O do not grow with 1,300 unrelated Plan roots', async t => {
  const s = await fixture();
  const id = randomUUID();
  const args = { projectId: s.projectId, itemId: id };
  t.mock.property(process, 'env', { ...process.env, CONVEX_CLOUD_URL: 'https://other.convex.cloud' });
  await assert.rejects(s.call('deny', exact.preview, args), { code: 'HOSTED_ACTION_UNSUPPORTED' });
  t.mock.restoreAll();
  t.mock.property(process, 'env', { ...process.env, CONVEX_CLOUD_URL: approvedDevRollup });
  await s.put(id, { body: '## Done when\n- [x] Synthetic evidence' });
  await s.ctx.db.insert('projectWorkDataRecords', {
    projectId: s.projectId,
    generationId: s.generationId,
    collection: '_workStorePlanCounts',
    key: 'counts',
    parent: '',
    position: 0,
    value: JSON.stringify({ scopeThrough: null }),
  });
  const scan = async () => {
    const p = await s.call('exact preview', exact.preview, args);
    const previewCost = s.counts.at(-1).readBytes;
    assert.equal(p.move?.rule, 'checklistDone');
    const r = await s.call('exact drift', exact.applyApproved, {
      projectId: s.projectId,
      generation: p.generation,
      operationId: randomUUID(),
      move: { ...p.move, version: p.move.version + 1 },
    });
    assert.equal(r.reason, 'item-changed');
    return [previewCost, s.counts.at(-1).readBytes, s.counts.at(-1).writeBytes];
  };
  const small = await scan();
  for (let i = 0; i < 1300; i++) await s.put(`unrelated-${i}`, {});
  const large = await scan();
  assert.deepEqual(large.slice(0, 2), small.slice(0, 2));
  assert(large[2] < 1024, 'one compact retained drift receipt');
  t.diagnostic(
    `1,300 roots: ${large[0]} B preview, ${large[1]} B drift read, ${large[2]} B receipt write (fixture document bytes)`,
  );
});

test('dry-run pages are read only, fence the Work head, and omit bodies and pin identities', async t => {
  const s = await fixture();
  t.mock.property(process, 'env', {
    ...process.env,
    CONVEX_CLOUD_URL: 'https://other.convex.cloud',
  });
  await assert.rejects(s.read(), { code: 'HOSTED_ACTION_UNSUPPORTED' });
  assert.equal(s.counts.at(-1).documents, 0);
  t.mock.restoreAll();
  t.mock.property(process, 'env', {
    ...process.env,
    CONVEX_CLOUD_URL: 'https://benevolent-wildebeest-974.convex.cloud',
  });
  await s.put('a', {
    body: '## Done when\n- [~] moved\n```md\n- [ ] example\n```\n- [x] finished',
    statusPin: { by: 'synthetic-pin-author', at: '2026-01-01T00:00:00.000Z' },
  });
  await s.put('b', { kind: 'initiative', body: '## Done when\n- [ ] initiative gate' });
  await s.put('c', { payload: true, body: '' });
  await s.intent('a', 'completed');
  const successorId = successorIntentId('a');
  const successor = await s.intent(successorId, 'active');
  await s.ctx.db.insert('projectHostedRecordHeads', {
    projectId: s.projectId,
    kind: 'lane',
    key: 'successor-lane',
    parent: successorId,
    status: 'active',
    version: 1,
    recordId: 'synthetic-lane-pointer',
  });
  for (let i = 100; i < 152; i++) await s.put(`item-${i}`, {});
  const first = await s.read();
  assert.equal(first.rootsRead, 50);
  assert.equal(first.fence.revision, 2, 'fence uses the Work head, not the older projection generation');
  assert.deepEqual(
    first.rows
      .slice(0, 3)
      .map(({ id, pinned, work, checked, unchecked }) => ({ id, pinned, work, checked, unchecked })),
    [
      { id: 'a', pinned: true, work: 'active', checked: 1, unchecked: 0 },
      { id: 'b', pinned: undefined, work: 'none', checked: 0, unchecked: 1 },
      { id: 'c', pinned: undefined, work: 'unknown', checked: 0, unchecked: 1 },
    ],
  );
  assert(!JSON.stringify(first).includes('synthetic-pin-author'));
  assert(!JSON.stringify(first).includes('Synthetic private title'));
  assert.equal(s.counts.at(-1).writes, 0);
  const second = await s.read({ after: first.after, expected: first.fence });
  assert.equal(second.after, null);
  assert.equal(new Set([...first.rows, ...second.rows].map(item => item.id)).size, 55);
  assert.deepEqual(summarizeRollupDryRun([first, second]), {
    transitions: {},
    wouldChange: 0,
    complete: false,
    rootsRead: 55,
    cyclicItems: 0,
    blockedInitiatives: 0,
    incompleteRows: 1,
    pinned: 1,
    proposed: 0,
  });
  assert.throws(() => summarizeRollupDryRun([second]), /missing, repeated, or stale page/);
  assert.throws(() => summarizeRollupDryRun([first]), /did not read every page/);
  await s.ctx.db.patch(successor, { status: 'completed' });
  const changedWork = await s.read({ expected: first.fence });
  assert.notEqual(
    changedWork.rows[0].workStamp,
    first.rows[0].workStamp,
    'a canonical Work edit invalidates evidence even before a planning version',
  );
  await s.ctx.db.patch(s.headId, { revision: 3 });
  await assert.rejects(s.read({ after: first.after, expected: first.fence }), { code: 'WORK_STALE' });
});
