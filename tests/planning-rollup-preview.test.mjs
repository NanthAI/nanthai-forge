// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { previewPlanningRollup, summarizeRollupDryRun } from '../dist/planning-rollup-preview.js';
import { successorIntentId } from '../dist/hosted-intent-chain.js';
import { moduleUrl } from './convex-module.mjs';
import { recordsFixture } from './hosted-records-fixture.mjs';

const { page } = await import(moduleUrl('../convex/projectPlanRollupPreview.ts'));
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
  const put = (id, fields) =>
    s.ctx.db.insert('projectPlanningRecords', {
      projectId,
      generationId,
      collection: 'planningItems',
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
    });
  const intent = (key, status) =>
    s.ctx.db.insert('projectHostedRecordHeads', {
      projectId,
      kind: 'intent',
      key,
      status,
      version: 1,
      parent: '',
      recordId: 'synthetic-work-pointer',
    });
  const read = (extra = {}) => s.call('preview', page, { projectId, after: '', ...extra });
  return { ...s, read, put, intent, headId };
}

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
  const successor = await s.intent(successorIntentId('a'), 'active');
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
