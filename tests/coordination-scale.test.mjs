// SPDX-License-Identifier: Apache-2.0
import { getWorkRecord, setWorkRecord } from './hosted-fixture.mjs';
import { dispatchCoordination } from '../dist/coordination-dispatch.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { indexedRecord, activityFields } from '../dist/work-hosted-index.js';
import { HOSTED_WORK_INDEX_FORMAT } from '../dist/work-hosted-summary.js';
const coordination = await import(moduleUrl('../convex/projectCoordination.ts'));
const backfill = await import(moduleUrl('../convex/coordinationBackfill.ts'));

function fixture() {
  const f = state([], { keysetPaging: true });
  f.tables.hostedProjects.set('project', { _id: 'project', owner: 'owner' });
  const query = (name, args = {}) => coordination[name]._handler(f.ctx, { projectId: 'project', ...args });
  return { ...f, query };
}
function seedSessions(f, children = false) {
  for (let i = 0; i < 1000; i++) {
    f.tables.projectCoordinationSessions.set(`s${i}`, {
      _id: `s${i}`,
      _creationTime: i,
      projectId: 'project',
      actor: 'owner',
      credentialId: 'private-credential',
      operationId: `operation${i}`,
      sessionId: `s${i}`,
      name: `Worker ${i}`,
      environment: 'test',
      status: children && i ? 'completed' : 'working',
      summary: 'Synthetic',
      sequence: 1,
      lastSeen: Date.now(),
      context: { laneId: `lane${i}` },
      ...(children && i ? { parentSessionId: 's0', kind: 'subagent' } : {}),
    });
  }
}
async function drain(f, name, size, args = {}, afterFirst = () => {}) {
  const rows = [];
  let cursor = null,
    pages = 0;
  do {
    const page = await f.query(name, { ...args, paginationOpts: { cursor, numItems: size } });
    assert.ok(page.page.length <= size);
    rows.push(...page.page);
    cursor = page.continueCursor;
    if (++pages === 1) afterFirst();
    if (page.isDone) break;
    assert.ok(pages < 200);
  } while (true);
  return rows;
}

test('1,000 retained descendants require independent bounded pages; credentials never escape', async () => {
  const f = fixture();
  seedSessions(f, true);
  let queries = 0;
  const original = f.ctx.db.query;
  f.ctx.db.query = table => {
    queries++;
    return original(table);
  };
  const roots = await f.query('sessions', { paginationOpts: { cursor: null, numItems: 1 } });
  assert.equal(roots.page.length, 1);
  assert.deepEqual(roots.page[0].subagents, []);
  assert.ok(queries < 10, `root query expanded children: ${queries}`);
  const children = await drain(f, 'sessions', 50, { parentSessionId: 's0' });
  assert.equal(children.length, 999);
  assert.ok(children.every(row => row.status === 'completed'));
  const cliPage = await dispatchCoordination(
    { query: (_ref, args) => coordination.sessions._handler(f.ctx, args) },
    'project',
    { action: 'sessions', parentSessionId: 's0', pageSize: 1 },
  );
  assert.equal(cliPage.page[0].parentSessionId, 's0');
  assert.equal(new Set(children.map(r => r.sessionId)).size, 999);
  assert.ok(!JSON.stringify([...roots.page, ...children]).includes('private-credential'));
});

test('flat presence reaches a selected Lane beyond page one; heartbeats and inserts do not duplicate older rows', async () => {
  const f = fixture();
  seedSessions(f);
  const rows = await drain(f, 'sessions', 30, { all: true }, () => {
    f.tables.projectCoordinationSessions.get('s0').lastSeen = Date.now() + 1000;
    f.tables.projectCoordinationSessions.set('new', {
      ...f.tables.projectCoordinationSessions.get('s0'),
      _id: 'new',
      sessionId: 'new',
      _creationTime: 2000,
    });
  });
  assert.equal(rows.length, 1000);
  assert.equal(new Set(rows.map(r => r.sessionId)).size, 1000);
  assert.equal(rows.find(r => r.context.laneId === 'lane0').sessionId, 's0');
  assert.equal(
    (await f.query('sessions', { all: true, paginationOpts: { cursor: null, numItems: 1 } })).page[0]
      .sessionId,
    'new',
  );
});

test('5,000 events remain reachable through immutable cursors during new activity inserts', async () => {
  const f = fixture();
  for (let i = 0; i < 5000; i++)
    f.tables.projectCoordinationEvents.set(`e${i}`, {
      _id: `e${i}`,
      _creationTime: i,
      projectId: 'project',
      actor: 'owner',
      operationId: `e${i}`,
      at: i,
      command:
        i === 0
          ? { kind: 'change', source: 'return', laneId: 'selected' }
          : { kind: 'ack', messageId: 'synthetic-message', text: 'Synthetic' },
    });
  const rows = await drain(f, 'recent', 40, {}, () => {
    f.tables.projectCoordinationEvents.set('new', {
      ...f.tables.projectCoordinationEvents.get('e0'),
      _id: 'new',
      operationId: 'new',
      _creationTime: 6000,
    });
  });
  assert.equal(rows.length, 5000);
  assert.equal(new Set(rows.map(r => r.operationId)).size, 5000);
  assert.equal(rows.at(-1).command.laneId, 'selected');
});

test('indexed activity excludes 5,000 old runs; migration is bounded and safe to replay', async () => {
  const f = fixture(),
    now = Date.now();
  f.tables.hostedProjects.get('project').work = { generationId: 'g', backupId: 'b' };
  f.tables.projectWorkGenerations.set('g', {
    _id: 'g',
    projectId: 'project',
    backupId: 'b',
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
  });
  const add = (collection, key, value, at) =>
    setWorkRecord(f.tables, key, {
      _id: key,
      _creationTime: f.tables.projectWorkRecords.size,
      projectId: 'project',
      generationId: 'g',
      collection,
      key,
      parent: '',
      position: 0,
      value: JSON.stringify(value),
      ...(at === undefined ? {} : { activityAt: at }),
    });
  for (let i = 0; i < 5000; i++)
    add('runs', `r${i}`, { viewId: 'v', startedAt: new Date(now - 86400000).toISOString() }, now - 86400000);
  add('views', 'v', { inputs: [{ laneId: 'checked' }] });
  const run = { viewId: 'v', startedAt: new Date(now).toISOString() };
  add('runs', 'recent', run);
  let cursor = null,
    pages = 0;
  do {
    const result = await backfill.activity._handler(f.ctx, { cursor });
    const replay = await backfill.activity._handler(f.ctx, { cursor });
    assert.deepEqual(replay, result);
    pages++;
    if (result.isDone) break;
    cursor = result.cursor;
  } while (pages < 60);
  assert.ok(pages > 50 && pages < 60);
  assert.equal(getWorkRecord(f.tables, 'recent').activityAt, Date.parse(run.startedAt));
  // A count query must use only the timestamp range, never traverse old Lane/run records.
  const original = f.ctx.db.query;
  let runReads = 0;
  f.ctx.db.query = table => {
    const query = original(table),
      withIndex = query.withIndex;
    query.withIndex = (index, build) => {
      if (table === 'projectWorkRecords' && index.includes('collection_and_')) {
        assert.ok(index.endsWith('activityAt') || index.endsWith('key'), index);
      }
      return withIndex(index, build);
    };
    if (table === 'projectWorkRecords') {
      const iterator = query[Symbol.asyncIterator];
      query[Symbol.asyncIterator] = async function* () {
        for await (const row of { [Symbol.asyncIterator]: iterator }) {
          runReads++;
          yield row;
        }
      };
    }
    return query;
  };
  assert.equal((await f.query('counts')).activeLanes, 1);
  assert.equal(runReads, 1);
  assert.equal(indexedRecord('runs', 'r', '', 0, run)[0].activityAt, Date.parse(run.startedAt));
  assert.deepEqual(activityFields('lanes', {}), {});
  f.ctx.auth.getUserIdentity = async () => ({ subject: 'outsider' });
  await assert.rejects(
    f.query('sessions', { all: true, paginationOpts: { cursor: null, numItems: 30 } }),
    /unavailable/,
  );
});
