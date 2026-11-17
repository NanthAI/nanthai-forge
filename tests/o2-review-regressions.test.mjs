// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { v } from 'convex/values';
import { state } from './hosted-fixture.mjs';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { moduleUrl } from './convex-module.mjs';
const { internalMutation } = await import(moduleUrl('../convex/server.ts'));
const { finishWorkRecordWrites } = await import(moduleUrl('../convex/projectWorkRecordWriter.ts'));
const { PLAN_ROWS, decodePlanPage } = await import(moduleUrl('../convex/projectPlanRows.ts'));

test('the real mutation wrapper permits planning flushes inside handlers and after insert, edit and removal', async () => {
  const s = state([]);
  const projectId = 'project',
    generationId = 'generation';
  const item = {
    id: randomUUID(),
    kind: 'issue',
    status: 'open',
    title: 'Preserve planning projection',
    version: 1,
    body: '',
    intentIds: [],
    at: '2026-11-17T00:00:00.000Z',
    operationId: randomUUID(),
    request: 'a'.repeat(64),
    previousVersion: 0,
    provenance: 'user-declared-local',
  };
  const entry = indexedRecord('planningItems', item.id, '', 0, item).find(
    r => r.collection === 'planningSearch',
  );
  let id;
  const insert = internalMutation({
    args: {},
    returns: v.null(),
    handler: async ctx => {
      id = await ctx.db.insert('projectPlanningRecords', { ...entry, projectId, generationId });
      assert.equal(
        await finishWorkRecordWrites(ctx),
        true,
        'planning preparation must see its registered writer and flush before deciding completion',
      );
      return null;
    },
  });
  const edit = internalMutation({
    args: {},
    returns: v.null(),
    handler: async ctx => {
      const root = await ctx.db.get(id);
      await ctx.db.patch(id, {
        value: JSON.stringify({ ...JSON.parse(root.value), title: 'Updated planning projection' }),
      });
      return null;
    },
  });
  const remove = internalMutation({
    args: {},
    returns: v.null(),
    handler: async ctx => {
      await ctx.db.delete(id);
      return null;
    },
  });
  const pages = () => [...s.tables.projectWorkDataRecords.values()].filter(r => r.collection === PLAN_ROWS);
  const rows = () => pages().flatMap(r => decodePlanPage(r.value, r.parent));
  await insert._handler(s.ctx, {});
  assert.equal(s.tables.projectPlanningRecords.size, 1);
  assert.equal(pages().length, 1, 'the production wrapper must flush its inner Work writer');
  assert.equal(rows()[0].id, item.id);
  assert.equal(rows()[0].title, item.title);
  await edit._handler(s.ctx, {});
  assert.equal(rows()[0].title, 'Updated planning projection');
  await remove._handler(s.ctx, {});
  assert.equal(s.tables.projectPlanningRecords.size, 0);
  assert.equal(pages().length, 0);
});
