// SPDX-License-Identifier: Apache-2.0
// Reactions on planning comments (Item 9a3d6f5f): only the project's planning writers react, a retried toggle never
// flips twice, a read returns counts and the viewer's own marks, never who else reacted, a reaction names a comment
// that exists on that Item, and agents never react (security review C1-11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';

const reactions = await import(moduleUrl('../convex/planningReactions.ts'));
const item = '00000000-0000-4000-8000-000000000001',
  comment = '00000000-0000-4000-8000-000000000002';
const denied = error => (error.data?.code ?? error.code) === 'PROJECT_UNAVAILABLE';
function fixture(subject = 'owner', identity = {}) {
  const s = state([]);
  s.tables.hostedProjects.set(
    'project',
    projectRow({ _id: 'project', name: 'synthetic', revision: 1, workStore: 'records' }),
  );
  s.tables.projectHostedRecordHeads.set('head-comment', {
    _id: 'head-comment',
    _creationTime: 1,
    projectId: 'project',
    kind: 'comment',
    key: comment,
    parent: item,
    status: 'comment',
    version: 1,
    recordId: 'record-comment',
  });
  s.ctx.auth.getUserIdentity = async () => (subject ? { subject, ...identity } : null);
  return s;
}
const toggle = (s, on, kind = '+1') =>
  reactions.toggle._handler(s.ctx, { projectId: 'project', itemId: item, commentId: comment, kind, on });
const read = s => reactions.forItem._handler(s.ctx, { projectId: 'project', itemId: item });

test('a writer’s reaction toggles once per state asked for, and the read shows counts with the viewer’s own', async () => {
  const s = fixture();
  assert.deepEqual(await toggle(s, true), { on: true });
  assert.deepEqual(await toggle(s, true), { on: true }, 'a retried add keeps one reaction');
  await toggle(s, true, 'rocket');
  const seen = await read(s);
  assert.equal(seen.complete, true);
  assert.deepEqual(
    seen.counts.sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      { commentId: comment, kind: '+1', count: 1, mine: true },
      { commentId: comment, kind: 'rocket', count: 1, mine: true },
    ],
  );
  assert.ok(
    seen.counts.every(entry => !('actor' in entry)),
    'no reader learns who reacted',
  );
  await toggle(s, false);
  await toggle(s, false);
  assert.deepEqual(
    (await read(s)).counts.map(entry => entry.kind),
    ['rocket'],
  );
});

test('people without planning write access cannot react, and a signed-out read is refused', async () => {
  const stranger = fixture('stranger');
  await assert.rejects(toggle(stranger, true), denied);
  await assert.rejects(read(stranger), denied);
  await assert.rejects(read(fixture(null)), denied);
  const s = fixture();
  await assert.rejects(
    reactions.toggle._handler(s.ctx, {
      projectId: 'project',
      itemId: 'x',
      commentId: comment,
      kind: '+1',
      on: true,
    }),
    error => (error.data?.code ?? error.code) === 'BAD_ARGUMENT',
  );
});

test('a reaction must name a comment on that Item; one left on a comment that is gone can still be taken off', async () => {
  const s = fixture();
  const other = '00000000-0000-4000-8000-000000000003';
  const notFound = error => (error.data?.code ?? error.code) === 'NOT_FOUND';
  await assert.rejects(
    reactions.toggle._handler(s.ctx, {
      projectId: 'project',
      itemId: item,
      commentId: other,
      kind: '+1',
      on: true,
    }),
    notFound,
    'an unknown comment gets no reaction row',
  );
  await assert.rejects(
    reactions.toggle._handler(s.ctx, {
      projectId: 'project',
      itemId: other,
      commentId: comment,
      kind: '+1',
      on: true,
    }),
    notFound,
    'a comment on another Item is refused',
  );
  assert.equal(s.tables.planningReactions.size, 0);
  await toggle(s, true);
  s.tables.projectHostedRecordHeads.delete('head-comment');
  assert.deepEqual(await toggle(s, false), { on: false });
  assert.equal(s.tables.planningReactions.size, 0);
});

test('agents never react: a device credential is refused, as for stars', async () => {
  const device = fixture('owner', { forgeCredential: 'credential-1' });
  device.tables.cliCredentials.set('device', {
    _id: 'device',
    credentialId: 'credential-1',
    owner: 'owner',
    name: 'test',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600000,
    revoked: false,
    scope: 'cli',
  });
  await assert.rejects(
    toggle(device, true),
    error => (error.data?.code ?? error.code) === 'AUTH_SCOPE_DENIED',
  );
  assert.equal(device.tables.planningReactions.size, 0);
});
