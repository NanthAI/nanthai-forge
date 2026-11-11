// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { hasJournalHistory } from '../dist/landing-capsule-client.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { encodeArchiveBytes } from '../dist/landing-capsule-bytes.js';
import { journalSegmentText, journalTablePins } from '../dist/journal-segment.js';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
const api = await import(moduleUrl('../convex/projectCoordination.ts'));
const read = await import(moduleUrl('../convex/projectJournalRead.ts'));
const cold = await import(moduleUrl('../convex/projectJournalCoordination.ts'));
const rows = await import(moduleUrl('../convex/projectJournalCoordinationRows.ts'));
const device = await import(moduleUrl('../convex/deviceStore.ts'));
const people = await import(moduleUrl('../convex/publicPeople.ts'));
async function fixture(t) {
  const f = state([], { keysetPaging: true });
  f.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 0,
    owner: 'owner',
    name: 'Synthetic',
    key: 'synthetic',
    visibility: 'private',
    revision: 0,
  });
  const original = [];
  for (let i = 0; i < 90; i++) {
    const kind = i % 3 === 0 ? 'message' : 'change',
      laneId = `lane${i % 3}`;
    const row = {
      _id: `event${String(i).padStart(4, '0')}`,
      _creationTime: Math.floor(i / 3),
      projectId: 'project',
      operationId: randomUUID(),
      actor: 'owner',
      at: i,
      kind,
      laneId,
      intentId: 'intent',
      command:
        kind === 'message'
          ? { kind, text: `Message ${i}`, context: { laneId } }
          : { kind, source: 'work', laneId, intentId: 'intent' },
    };
    f.tables.projectCoordinationEvents.set(row._id, row);
    original.push(row);
  }
  const objects = new Map();
  const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
  Object.assign(process.env, synthetic);
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  let gets = 0,
    onGet = () => {};
  t.mock.method(globalThis, 'fetch', async url => {
    gets++;
    onGet();
    const body = objects.get(new URL(url).pathname.split('/').at(-1));
    assert(body);
    return new Response(body);
  });
  const relocate = () => {
    // Contiguous source windows, then one index/object per Lane/Intent/recipient group.
    for (let offset = 0; offset < original.length; offset += 30) {
      const groups = new Map();
      for (const row of original.slice(offset, offset + 30))
        if (row.kind === 'change') {
          const group = groups.get(row.laneId) ?? [];
          group.push(row);
          groups.set(row.laneId, group);
        }
      for (const [laneId, selected] of groups) {
        const keys = selected.map(row =>
          rows.coordinationJournalKey('project', [row._creationTime, row._id]),
        );
        const segment = {
          protocol: 1,
          kind: 'forge-journal-segment',
          projectId: 'project',
          scope: `coordination:${laneId}:${offset}`,
          from: selected[0]._creationTime,
          through: selected.at(-1)._creationTime,
          startKey: keys[0],
          endKey: keys.at(-1),
          tables: { projectCoordinationEvents: selected.map(row => canonicalPayload(row)) },
        };
        const encoded = encodeArchiveBytes(
          journalSegmentText(segment),
          segment.through,
          journalTablePins(segment.tables),
        );
        const index = {
          scope: segment.scope,
          from: segment.from,
          through: segment.through,
          startKey: segment.startKey,
          endKey: segment.endKey,
          keys,
          pointer: encoded.pointer,
        };
        objects.set(encoded.pointer.sha256, encoded.body);
        const id = `segment${offset}${laneId}`;
        f.tables.projectJournalSegments.set(id, {
          _id: id,
          _creationTime: offset,
          projectId: 'project',
          category: 'coordination',
          scope: segment.scope,
          from: segment.from,
          through: segment.through,
          laneId,
          intentId: 'intent',
          firstPosition: segment.startKey,
          lastPosition: segment.endKey,
          key: id,
          value: canonicalPayload(index),
        });
        for (const row of selected) f.tables.projectCoordinationEvents.delete(row._id);
      }
    }
    f.tables.hostedProjects.get('project').journalRevision = 1;
  };
  const call = async (name, args) => {
    const [file, method] = name.split(':');
    if (file === 'projectCoordination') {
      try {
        return await api[method]._handler(f.ctx, { projectId: 'project', ...args });
      } catch (error) {
        if (hasJournalHistory(error)) return error.data;
        throw error;
      }
    }
    assert.fail(name);
  };
  const actionCtx = {
    auth: f.ctx.auth,
    runQuery: (ref, args) => {
      const name = getFunctionName(ref);
      if (name === 'projectJournalRead:read') return read.read._handler(f.ctx, args);
      if (name === 'deviceStore:authorize') return device.authorize._handler(f.ctx, args);
      if (name === 'publicPeople:resolve') return people.resolve._handler(f.ctx, args);
      assert.fail(name);
    },
  };
  const page = async (method, args) => {
    const raw = await call(`projectCoordination:${method}`, args);
    return raw.journalHistory
      ? JSON.parse(
          await cold.history._handler(actionCtx, {
            projectId: 'project',
            query: `projectCoordination:${method}`,
            request: canonicalPayload(args),
          }),
        )
      : raw;
  };
  const all = async (method, scope = {}) => {
    const result = [];
    let cursor = null;
    for (let n = 0; n < 50; n++) {
      const next = await page(method, { ...scope, paginationOpts: { cursor, numItems: 7 } });
      result.push(...next.page);
      if (next.isDone) return result;
      assert.notEqual(next.continueCursor, cursor);
      cursor = next.continueCursor;
    }
    assert.fail('bounded fixture did not complete');
  };
  return {
    ...f,
    original,
    relocate,
    all,
    page,
    onGet: fn => {
      onGet = fn;
    },
    gets: () => gets,
  };
}
for (const method of ['feed', 'recent'])
  test(`coordination ${method} merges archived detail and live messages across timestamp ties and pages`, async t => {
    const h = await fixture(t),
      before = await h.all(method);
    h.relocate();
    const after = await h.all(method);
    assert.deepEqual(after, before);
    assert.equal(new Set(after.map(row => row._id)).size, 90);
    assert.equal(h.tables.projectCoordinationEvents.size, 30);
    assert(h.gets() > 0);
  });
test('archived coordination retains indexed Lane/Intent feed scope without exposing object pins', async t => {
  const h = await fixture(t),
    lane = await h.all('feed', { laneId: 'lane1' }),
    intent = await h.all('feed', { intentId: 'intent' });
  h.relocate();
  assert.deepEqual(await h.all('feed', { laneId: 'lane1' }), lane);
  assert.deepEqual(await h.all('feed', { intentId: 'intent' }), intent);
  const reply = await h.page('feed', { laneId: 'lane1', paginationOpts: { cursor: null, numItems: 7 } });
  assert(!JSON.stringify(reply).includes('journal-segments'));
  assert(!JSON.stringify(reply).includes('pointer'));
  assert(!JSON.stringify(reply).includes('signature'));
});

test('coordination archive actions recheck access after GET and refuse inaccessible projects before fetching', async t => {
  const h = await fixture(t);
  h.relocate();
  h.onGet(() => h.caller('stranger'));
  const input = { paginationOpts: { cursor: null, numItems: 7 } };
  await assert.rejects(
    h.page('feed', input),
    error => (error.code ?? error.data?.code) === 'PROJECT_UNAVAILABLE',
  );
  const gets = h.gets();
  await assert.rejects(
    h.page('feed', input),
    error => (error.code ?? error.data?.code) === 'PROJECT_UNAVAILABLE',
  );
  assert.equal(h.gets(), gets);
});

test('coordination-only credentials retain archived feed access through the same scope', async t => {
  const h = await fixture(t);
  h.relocate();
  const credentialId = randomUUID();
  h.tables.cliCredentials.set('coordination-token', {
    _id: 'coordination-token',
    _creationTime: 0,
    credentialId,
    name: 'Synthetic',
    tokenHash: 'a'.repeat(64),
    issuedAt: 0,
    owner: 'owner',
    scope: 'coordination',
    revoked: false,
    expiresAt: Date.now() + 60000,
  });
  h.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: credentialId });
  const reply = await h.page('feed', { paginationOpts: { cursor: null, numItems: 7 } });
  assert.equal(reply.page.length, 7);
  assert(h.gets() > 0);
});

test('archived coordination receipts replay exact published detail without recreating it or fetching R2', async t => {
  const h = await fixture(t),
    write = await import(moduleUrl('../convex/coordinationWrite.ts'));
  const original = h.original.find(row => row.command.kind === 'change');
  h.tables.projectCoordinationEvents.delete(original._id);
  const { command, ...envelope } = original;
  const { digest } = await import('../dist/state/hash.js');
  h.tables.projectJournalReceipts.set('receipt', {
    _id: 'receipt',
    _creationTime: 0,
    projectId: 'project',
    operationId: original.operationId,
    hash: digest(write.canonical(command)),
    envelope: JSON.stringify(envelope),
  });
  const replay = await write.eventByOperation(h.ctx, 'project', original.operationId, command);
  assert.deepEqual(replay, original);
  assert.equal(h.gets(), 0);
  await assert.rejects(
    write.eventByOperation(h.ctx, 'project', original.operationId, { ...command, source: 'return' }),
    error => (error.code ?? error.data?.code) === 'WORK_OPERATION_CHANGED',
  );
});
