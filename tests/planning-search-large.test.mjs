// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { getDocumentSize } from 'convex/values';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { installPlanningSearch } from './planning-search-fixture.mjs';
import {
  planningSearchEntries,
  planningSearchRowBytes,
  planningSearchTerms,
} from '../dist/planning-search.js';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { assembleIndexValue } from '../dist/work-index-value.js';
const search = await import(moduleUrl('../convex/projectHostedPlanningSearch.ts'));
const prepare = await import(moduleUrl('../convex/projectHostedPlanningPrepare.ts'));
const run = async (s, text, extra = {}) =>
  JSON.parse(
    await search.search._handler(s.ctx, {
      projectId: s.projectId,
      ...planningSearchTerms(text),
      status: 'active',
      limit: 50,
      cursor: null,
      ...extra,
    }),
  );
const add = async (s, patch) => {
  const item = s.item(patch);
  await s.send(item);
  return item;
};

test('large accepted titles keep source bytes and every search row below the physical document limit', async t => {
  const s = await setup(t);
  installPlanningSearch(s);
  const title = 't'.repeat(600000) + ' endneedle';
  const item = await add(s, { title });
  const matches = await run(s, 'endneedle');
  assert.equal(matches.items[0].id, item.itemId);
  assert.equal(matches.items[0].titleLength, title.length);
  assert.equal(matches.items[0].titleTruncated, true);
  assert.equal(matches.items[0].title.length, 400);
  const original = (await s.read()).data.planningItems.find(i => i.id === item.itemId);
  assert.equal(original.title, title);
  for (const row of s.tables.projectWorkRecords.values())
    if (row.collection.startsWith('planningSearch')) assert(planningSearchRowBytes(row) <= 1048576);
});

test('oversized legacy text has unique paged matches, whole-word boundaries and stale-fragment retirement', async t => {
  const s = await setup(t);
  installPlanningSearch(s);
  const generation = [...s.tables.projectWorkGenerations.values()].find(g => g.status === 'ready');
  const item = {
    ...s.item(),
    id: randomUUID(),
    version: 1,
    at: '2026-01-01',
    body: ('needle '.repeat(3000) + 'boundaryword ').repeat(60),
  };
  const entries = planningSearchEntries(item, 0);
  assert(entries.length > 2);
  assert(entries.every(row => planningSearchRowBytes(row) <= 1048576));
  const payloadKey = JSON.parse(entries[0].value).payloadKey;
  for (const row of entries)
    await s.ctx.db.insert('projectWorkRecords', {
      ...row,
      projectId: s.projectId,
      generationId: generation._id,
    });
  let cursor = null,
    ids = [],
    pages = 0;
  do {
    const result = await run(s, 'boundaryword', { limit: 5, cursor });
    ids.push(...result.items.map(i => i.id));
    cursor = result.nextCursor;
    assert(++pages < 100);
  } while (cursor);
  assert.deepEqual(ids, [item.id]);
  const root = [...s.tables.projectWorkRecords.values()].find(
    r => r.collection === 'planningSearch' && r.key === item.id,
  );
  const newer = planningSearchEntries({ ...item, version: 2, body: 'replacement' }, 0)[0];
  await s.ctx.db.patch(root._id, newer);
  assert.equal((await run(s, 'boundaryword')).items.length, 0);
  const store = await import(moduleUrl('../convex/projectWorkIndexStore.ts'));
  await store.retirePayload._handler(s.ctx, {
    projectId: s.projectId,
    generationId: generation._id,
    collection: 'planningSearch',
    key: item.id,
    payloadKey,
  });
  assert(![...s.tables.projectWorkRecords.values()].some(r => r.parent === payloadKey));
  assert.equal((await run(s, 'replacement')).items[0].id, item.id);
});

test('legacy Unicode preparation bounds output across pages and replays partial-item pages', async t => {
  const s = await setup(t);
  installPlanningSearch(s);
  const generation = [...s.tables.projectWorkGenerations.values()].find(g => g.status === 'ready');
  delete generation.planningSearchVersion;
  const item = {
    ...s.item(),
    id: randomUUID(),
    version: 1,
    at: '2026-01-01',
    body: ('漢'.repeat(10) + ' ').repeat(250000) + ' finalneedle',
  };
  for (const row of indexedRecord('planningItems', item.id, '', 0, item))
    if (row.collection.startsWith('planningItems'))
      await s.ctx.db.insert('projectWorkRecords', {
        ...row,
        projectId: s.projectId,
        generationId: generation._id,
      });
  let cursor = null,
    pages = 0,
    processed = 0;
  do {
    const input = {
      projectId: s.projectId,
      owner: 'owner',
      generationId: generation._id,
      operationId: randomUUID(),
      cursor,
    };
    const result = JSON.parse(await prepare.page._handler(s.ctx, input));
    assert(result.indexedBytes <= 4000000);
    assert.deepEqual(JSON.parse(await prepare.page._handler(s.ctx, input)), result);
    processed += result.processed;
    cursor = result.nextCursor;
    assert(++pages < 10);
  } while (cursor);
  assert(pages > 1);
  assert.equal(processed, 1);
  assert.equal((await run(s, 'finalneedle')).items[0].id, item.id);
  for (const row of s.tables.projectWorkRecords.values())
    if (row.collection.startsWith('planningSearch')) assert(planningSearchRowBytes(row) <= 1048576);
});

test('duplicate hints preserve near-limit friction filing and replay without oversized documents', async t => {
  const s = await setup(t);
  installPlanningSearch(s);
  const existing = await add(s, { title: 'sync recovery', body: 'Existing duplicate' });
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  const command = { operationId: randomUUID(), title: 'sync', detail: 'x', area: 'sync' };
  const oldRecord = {
    ...command,
    id: command.operationId,
    kind: 'capture',
    request: 'a'.repeat(64),
    at: new Date().toISOString(),
    count: 1,
  };
  const oldRow = {
    projectId: s.projectId,
    actor: 'owner',
    id: command.operationId,
    request: oldRecord.request,
    value: JSON.stringify(oldRecord),
  };
  command.detail = 'x'.repeat(1 + 1048576 - getDocumentSize(oldRow) - 16);
  const insert = s.ctx.db.insert;
  s.ctx.db.insert = async (table, value) => {
    assert(getDocumentSize(value) <= 1048576, `${table} exceeds the physical document limit`);
    return insert(table, value);
  };
  const friction = await import(moduleUrl('../convex/projectHostedFriction.ts'));
  const input = { projectId: s.projectId, request: JSON.stringify(command) };
  const result = JSON.parse(await friction.capture._handler(s.ctx, input));
  assert(result.likelyDuplicates.items.some(item => item.id === existing.itemId));
  assert.equal(result.detail, command.detail);
  assert.equal(s.tables.projectHostedFriction.size, 1);
  assert.equal(s.tables.projectHostedFrictionHints.size, 1);
  assert.deepEqual(JSON.parse(await friction.capture._handler(s.ctx, input)), result);
  assert.equal(s.tables.projectHostedFrictionHints.size, 1);
});

test('large planning membership arrays stay in original payloads and every derived row remains bounded', () => {
  const item = {
    id: randomUUID(),
    kind: 'issue',
    title: 'Large membership',
    body: 'sync',
    status: 'open',
    version: 1,
    at: '2026-01-01',
    intentIds: Array(50000).fill(randomUUID()),
  };
  const entries = indexedRecord('planningItems', item.id, '', 0, item);
  assert(entries.every(row => planningSearchRowBytes(row) <= 1048576));
  const original = assembleIndexValue(
    'planningItems',
    JSON.parse(entries[0].value),
    entries.filter(row => row.collection === 'planningItems:payload'),
  );
  assert.deepEqual(original.intentIds, item.intentIds);
});
