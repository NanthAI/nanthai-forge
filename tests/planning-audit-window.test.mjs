// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getDocumentSize } from 'convex/values';
import { setup } from './hosted-planning-fixture.mjs';
import { meterReads } from './hosted-read-set.mjs';
import { moduleUrl } from './convex-module.mjs';

const { command, executeCommand } = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const { itemHistory } = await import(moduleUrl('../convex/projectHostedPlanning.ts'));
const { workRecordWriter, finishWorkRecordWrites } = await import(
  moduleUrl('../convex/projectWorkRecordWriter.ts')
);

async function fixture(t) {
  const s = await setup(t);
  await s.ctx.db.patch(s.projectId, { workStore: 'records', workStoreWriters: ['planning'] });
  const itemId = randomUUID();
  let at = Date.parse('2026-11-18T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const send = fields => {
    t.mock.timers.setTime((at += 1000));
    const operationId = randomUUID();
    return s.transaction(() =>
      command._handler(s.ctx, {
        projectId: s.projectId,
        operationId,
        command: JSON.stringify({ itemId, ...fields, operationId }),
      }),
    );
  };
  const put = (expectedVersion, fields) => send({ action: 'put-planning-item', expectedVersion, ...fields });
  const history = (limit, cursor) =>
    itemHistory
      ._handler(s.ctx, {
        projectId: s.projectId,
        itemId,
        limit,
        cursor: cursor ?? null,
      })
      .then(JSON.parse);
  const rows = () => [...s.tables.projectPlanningAudit.values()].filter(row => row.itemId === itemId);
  const withoutRows = async read => {
    const held = rows();
    held.forEach(row => s.tables.projectPlanningAudit.delete(row._id));
    try {
      return await read();
    } finally {
      held.forEach(row => s.tables.projectPlanningAudit.set(row._id, row));
    }
  };
  const compare = async (limit, cursor) => {
    const warm = await history(limit, cursor);
    const exact = await withoutRows(() => history(limit, cursor));
    assert.deepEqual(warm, exact);
    return warm;
  };
  const cost = async read => {
    const meter = meterReads(s.ctx);
    try {
      return await meter.cost(read);
    } finally {
      meter.restore();
    }
  };
  return { ...s, itemId, send, put, history, rows, withoutRows, compare, cost };
}

test('The bounded audit window keeps exact History events and cursors across checkbox edits, decisions, shelving and restore', async t => {
  const s = await fixture(t);
  await s.put(0, { kind: 'issue', title: 'Audit Item', body: '## Done when\n- [ ] Compare outputs\n' });
  await s.put(1, { body: '## Done when\n- [x] Compare outputs\n' });
  const comment = await s.send({
    action: 'comment-planning-item',
    text: 'Keep both reads exact.',
    decision: true,
  });
  await s.put(3, { status: 'archived' });
  await s.put(4, { status: 'open' });
  assert.deepEqual(
    s.rows().map(row => row.version),
    [1, 2, 3, 4, 5],
  );
  const all = await s.compare(25);
  assert(all.events.some(row => row.kind === 'version' && row.decisionCommentId === comment.operationId));
  const small = await s.compare(3);
  assert(small.nextCursor);
  await s.compare(3, small.nextCursor);
  await s.compare(50);
  const canonical = [...s.tables.projectHostedRecords.values()].find(
    row => row.kind === 'issue' && row.key === s.itemId && row.version === 5,
  );
  const staged = { ...canonical, lifecyclePlanId: 'fixture-plan' };
  delete staged._id;
  delete staged._creationTime;
  await s.ctx.db.insert('projectHostedRecords', staged);
  await s.compare(3);
  // Mismatching summary data cannot pin a page through a broken operation chain.
  const row = s.rows().find(row => row.version === 4);
  await s.ctx.db.patch(row._id, {
    value: JSON.stringify({ ...JSON.parse(row.value), operationId: randomUUID() }),
  });
  await s.compare(3);
});

test('History attributes a retained roll-up version to Forge in both readers', async t => {
  const s = await fixture(t);
  await s.put(0, { kind: 'issue', title: 'Follow Work', status: 'in-progress' });
  const operationId = randomUUID();
  await s.transaction(async () => {
    const writer = workRecordWriter(s.ctx);
    await executeCommand(
      writer,
      {
        projectId: s.projectId,
        operationId,
        command: JSON.stringify({
          action: 'put-planning-item',
          operationId,
          itemId: s.itemId,
          expectedVersion: 1,
          status: 'closed',
          reason: 'Done: linked work finished',
        }),
      },
      'owner',
      { server: true, fromRollup: true },
    );
    await finishWorkRecordWrites(writer);
  });
  assert(s.rows().some(row => row.version === 2));
  const page = await s.compare(3);
  const event = page.events.find(event => event.id === operationId);
  assert.deepEqual([event.actor, event.actorKind, event.model], ['Forge', 'system', null]);
});

test('Wide snapshots are not reread for a covered three- or 25-event page; older pages stay exact', async t => {
  const s = await fixture(t);
  const body = 'Synthetic paragraphs with ordinary retained text.\n'.repeat(810);
  await s.put(0, { kind: 'issue', title: 'Wide audit item', body });
  for (let v = 1; v < 41; v++) await s.put(v, { title: `Update ${v}` });
  assert.deepEqual(
    s.rows().map(row => row.version),
    Array.from({ length: 32 }, (_, i) => i + 10),
  );
  assert(s.rows().every(row => getDocumentSize(row) <= 4096));
  for (const limit of [3, 25]) {
    const warm = await s.cost(() => s.history(limit));
    const cold = await s.withoutRows(() => s.cost(() => s.history(limit)));
    assert(warm.bytes < cold.bytes / 2, `limit ${limit}: ${warm.bytes} vs ${cold.bytes}`);
    t.diagnostic(`limit ${limit}, fixture read bytes: exact ${cold.bytes}, summary ${warm.bytes}`);
    await s.compare(limit);
  }
  // Move past the kept window using only the endpoint's issued cursors.
  let page = await s.compare(25);
  assert(page.nextCursor);
  page = await s.compare(25, page.nextCursor);
  assert.equal(page.events.at(-1).version, 1);
  assert.equal(page.nextCursor, null);
  await s.compare(50);
});

test('An oversized diff leaves no summary, and a missed writer does not certify a page', async t => {
  const s = await fixture(t);
  await s.put(0, { kind: 'issue', title: 'Gap in audit' });
  const body = Array.from({ length: 32 }, (_, i) => `- [ ] Task ${i}: ${'content '.repeat(24)}`).join('\n');
  await s.put(1, { body });
  assert.deepEqual(
    s.rows().map(row => row.version),
    [1],
  );
  await s.put(2, { title: 'After large diff' });
  assert.deepEqual(
    s.rows().map(row => row.version),
    [1, 3],
  );
  await s.compare(3);
  const absent = s.rows().find(row => row.version === 3);
  await s.ctx.db.delete(absent._id);
  await s.put(3, { title: 'After a missed version' });
  await s.compare(3);
});
