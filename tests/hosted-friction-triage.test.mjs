// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { recordsFixture } from './hosted-context-records-fixture.mjs';

const code = expected => error => error.code === expected;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-friction-triage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const s = recordsFixture(),
    calls = [];
  const call = async (ref, args) => {
    const name = getFunctionName(ref);
    calls.push(name);
    return s.invoke(name, args);
  };
  const transport = new HostedAgentTransport(
    join(directory, 'checkout'),
    { url: 'https://fixture.invalid', projectId: 'project' },
    { projectId: 'project', client: { query: call, mutation: call } },
  );
  return { ...s, transport, calls };
}
const file = (s, title, extra = {}) =>
  s.transport.dispatch('friction', { title, detail: `${title} detail`, area: 'cli', ...extra });

test('friction-list pages newest first, filters by status, and triage dismisses or links an Issue', async t => {
  const s = fixture(t);
  const ids = [];
  for (const title of ['alpha', 'beta', 'gamma']) ids.push((await file(s, title)).result.id);
  const list = (input = {}) => s.transport.dispatch('friction-list', input).then(r => r.result);

  s.calls.length = 0;
  const open = await list();
  assert.deepEqual(s.calls, ['projectHostedFriction:read'], 'one call per read');
  assert.deepEqual(
    open.items.map(item => item.title),
    ['gamma', 'beta', 'alpha'],
  );
  assert.equal(open.nextCursor, null);
  assert.deepEqual(Object.keys(open.items[0]).sort(), ['area', 'at', 'detail', 'id', 'status', 'title']);

  const issue = randomUUID();
  const dismissed = await s.transport.dispatch('friction-triage', {
    frictionIds: [ids[1]],
    status: 'dropped',
    reason: 'zsh echo in the builder shell, not Forge',
  });
  assert.equal(dismissed.result.kind, 'triage');
  await s.transport.dispatch('friction-triage', {
    frictionIds: [ids[0]],
    status: 'planned',
    planningItemId: issue,
  });
  assert.deepEqual(
    (await list()).items.map(item => item.title),
    ['gamma'],
  );
  const drop = (await list({ status: 'dropped' })).items;
  assert.equal(drop.length, 1);
  assert.equal(drop[0].reason, 'zsh echo in the builder shell, not Forge');
  const planned = (await list({ status: 'planned' })).items;
  assert.equal(planned[0].planningItemId, issue);
  assert.equal((await list({ status: 'all' })).items.length, 3);
  assert.deepEqual(
    (await list({ status: 'all', search: 'ALPHA' })).items.map(item => item.title),
    ['alpha'],
  );
  assert.equal((await list({ status: 'all', area: 'other' })).items.length, 0);

  // Reopening restores it; a replay of the same operation changes nothing.
  const operationId = randomUUID(),
    reopen = { operationId, frictionIds: [ids[1]], status: 'open' };
  const first = await s.transport.dispatch('friction-triage', reopen);
  const writes = s.counts().writes;
  assert.deepEqual(await s.transport.dispatch('friction-triage', reopen), first);
  assert.equal(s.counts().writes, writes);
  await assert.rejects(
    s.transport.dispatch('friction-triage', { ...reopen, status: 'dropped', reason: 'x' }),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.equal((await list()).items.length, 2);
});

test('friction-list is bounded and paged; triage rejects unknown ids and incomplete commands', async t => {
  const s = fixture(t);
  for (let i = 0; i < 5; i++) await file(s, `item ${i}`);
  const first = (await s.transport.dispatch('friction-list', { limit: 2 })).result;
  assert.equal(first.items.length, 2);
  assert.equal(first.scanned, 2);
  assert.ok(first.nextCursor);
  const second = (await s.transport.dispatch('friction-list', { limit: 2, cursor: first.nextCursor })).result;
  assert.deepEqual(
    [...first.items, ...second.items].map(item => item.title),
    ['item 4', 'item 3', 'item 2', 'item 1'],
  );
  await assert.rejects(s.transport.dispatch('friction-list', { limit: 101 }), code('BAD_ARGUMENT'));
  await assert.rejects(s.transport.dispatch('friction-list', { extra: 1 }), code('BAD_ARGUMENT'));

  const id = first.items[0].id;
  const writes = s.counts().writes;
  for (const [input, expected] of [
    [{ frictionIds: [id], status: 'dropped' }, 'BAD_ARGUMENT'],
    [{ frictionIds: [id], status: 'fixed' }, 'BAD_ARGUMENT'],
    [{ frictionIds: [id], status: 'planned' }, 'BAD_ARGUMENT'],
    [{ frictionIds: [], status: 'open' }, 'BAD_ARGUMENT'],
    [{ frictionIds: Array.from({ length: 51 }, randomUUID), status: 'open' }, 'BAD_ARGUMENT'],
    [{ frictionIds: [randomUUID()], status: 'dropped', reason: 'unknown' }, 'NOT_FOUND'],
  ])
    await assert.rejects(s.transport.dispatch('friction-triage', input), code(expected));
  assert.equal(s.counts().writes, writes, 'a refused triage writes nothing');
});

test('friction-list {id} and triage take a full id or an 8+ character prefix in one indexed read', async t => {
  const s = fixture(t);
  const ids = [];
  for (const title of ['alpha', 'beta', 'gamma']) ids.push((await file(s, title)).result.id);
  const list = (input = {}) => s.transport.dispatch('friction-list', input).then(r => r.result);

  s.calls.length = 0;
  const byPrefix = await list({ id: ids[0].slice(0, 8), status: 'all' });
  assert.deepEqual(s.calls, ['projectHostedFriction:read'], 'one call');
  assert.deepEqual(
    byPrefix.items.map(item => item.id),
    [ids[0]],
  );
  assert.equal(byPrefix.scanned, 1);
  assert.equal(byPrefix.nextCursor, null);
  assert.deepEqual(
    (await list({ id: ids[1] })).items.map(item => item.title),
    ['beta'],
  );
  await assert.rejects(list({ id: 'abc' }), code('BAD_ARGUMENT'));
  await assert.rejects(list({ id: 'deadbeef' }), code('NOT_FOUND'));
  // Two ids sharing a prefix: the short form is refused with the candidates, a longer one resolves.
  const one = 'aaaaaaaa-0000-4000-8000-000000000001',
    two = 'aaaaaaaa-0000-4000-8000-000000000002';
  await file(s, 'one', { operationId: one });
  await file(s, 'two', { operationId: two });
  await assert.rejects(
    list({ id: 'aaaaaaaa' }),
    error => error.code === 'BAD_ARGUMENT' && error.message.includes(two),
  );
  assert.deepEqual(
    (await list({ id: 'aaaaaaaa-0000-4000-8000-000000000002' })).items.map(item => item.id),
    [two],
  );
  assert.deepEqual(
    await list({ id: 'aaaaaaaa-0000-4000-8000-00000000000' }).catch(error => error.code),
    'BAD_ARGUMENT',
  );

  // Triage by prefix stores the full id; an unknown prefix writes nothing.
  const done = await s.transport.dispatch('friction-triage', {
    frictionIds: [ids[2].slice(0, 12)],
    status: 'dropped',
    reason: 'by prefix',
  });
  assert.deepEqual(done.result.frictionIds, [ids[2]]);
  assert.equal((await list({ id: ids[2].slice(0, 8) })).items[0].status, 'dropped');
  const writes = s.counts().writes;
  await assert.rejects(
    s.transport.dispatch('friction-triage', { frictionIds: ['deadbeef'], status: 'open' }),
    code('NOT_FOUND'),
  );
  assert.equal(s.counts().writes, writes);
});
