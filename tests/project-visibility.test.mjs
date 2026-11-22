// SPDX-License-Identifier: Apache-2.0
// Item 966cb821: the owner person changes a project's visibility in a browser; an agent or any device credential never
// does. Going public needs the typed name; the listing follows; a retry with the same operation id reconciles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { state, projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const { setVisibility } = await import(moduleUrl('../convex/projectVisibility.ts'));
const code = expected => error => (error.data?.code ?? error.code) === expected;
// The account wrapper refuses a device first (AUTH_SCOPE_DENIED); the handler's own person check is the second line.
const personOnly = error =>
  ['AUTH_SCOPE_DENIED', 'PROJECT_UNAVAILABLE'].includes(error.data?.code ?? error.code);
const person = { subject: 'owner' };
const device = { subject: 'owner', forgeCredential: 'synthetic-device' };

function fixture(visibility, identity = person) {
  const s = state([]);
  s.tables.hostedProjects.set(
    'project',
    projectRow({ _id: 'project', owner: 'owner', name: 'Synthetic project', visibility }),
  );
  s.tables.cliCredentials.set('device', {
    _id: 'device',
    credentialId: 'synthetic-device',
    owner: 'owner',
    name: 'test',
    tokenHash: 'synthetic-hash',
    issuedAt: 1_700_000_000_000,
    expiresAt: 4_102_444_800_000,
    revoked: false,
    scope: 'cli',
  });
  s.ctx.auth.getUserIdentity = async () => identity;
  const set = (input, who = identity) => {
    s.ctx.auth.getUserIdentity = async () => who;
    return setVisibility._handler(s.ctx, {
      projectId: 'project',
      operationId: 'op-1',
      expectedRevision: 1,
      ...input,
    });
  };
  const project = () => s.tables.hostedProjects.get('project');
  const listing = () => [...s.tables.projectPublic.values()];
  return { ...s, set, project, listing };
}

test('a device credential, even the owner’s own, can never change visibility in either direction', async () => {
  for (const [from, to, confirm] of [
    ['private', 'public', 'Synthetic project'],
    ['public', 'private', undefined],
  ]) {
    const f = fixture(from);
    await assert.rejects(f.set({ visibility: to, ...(confirm ? { confirm } : {}) }, device), personOnly);
    assert.equal(f.project().visibility, from);
    assert.equal(f.listing().length, 0);
  }
});

test('another signed-in person cannot change the visibility of a project they do not own', async () => {
  const f = fixture('public');
  await assert.rejects(
    f.set({ visibility: 'private' }, { subject: 'stranger' }),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.equal(f.project().visibility, 'public');
});

test('making a project public needs its exact name typed; the listing follows', async () => {
  const f = fixture('private');
  await assert.rejects(f.set({ visibility: 'public' }), code('BAD_ARGUMENT'));
  await assert.rejects(f.set({ visibility: 'public', confirm: 'synthetic' }), code('BAD_ARGUMENT'));
  assert.equal(f.project().visibility, 'private');
  await f.set({ visibility: 'public', confirm: ' Synthetic project ' });
  assert.equal(f.project().visibility, 'public');
  assert.deepEqual(
    f.listing().map(row => row.listed),
    [true],
  );
});

test('making a project private needs no typing and stops its listing, keeping its stars', async () => {
  const f = fixture('public');
  f.tables.projectPublic.set('row', {
    _id: 'row',
    _creationTime: 1,
    projectId: 'project',
    owner: 'owner',
    listed: true,
    stars: 3,
  });
  await f.set({ visibility: 'private' });
  assert.equal(f.project().visibility, 'private');
  assert.deepEqual(
    f.listing().map(row => [row.listed, row.stars]),
    [[false, 3]],
  );
});

test('a retry with the same operation id changes nothing more; a changed retry is refused', async () => {
  const f = fixture('private');
  const input = { visibility: 'public', confirm: 'Synthetic project' };
  await f.set(input);
  f.project().visibility = 'private';
  await f.set(input);
  assert.equal(f.project().visibility, 'private');
  await assert.rejects(f.set({ visibility: 'private' }), code('WORK_OPERATION_CHANGED'));
});

test('a stale confirmation is refused, and a change advances the revision so an unused one cannot apply later', async () => {
  const f = fixture('private');
  const input = { visibility: 'public', confirm: 'Synthetic project' };
  await f.set(input);
  assert.equal(f.project().revision, 2);
  await f.set({ visibility: 'private', operationId: 'op-2', expectedRevision: 2 });
  assert.equal(f.project().revision, 3);
  // A "Make public" confirmed at revision 1 (another tab, never sent until now) no longer applies.
  await assert.rejects(f.set({ ...input, operationId: 'op-3' }), code('WORK_STALE'));
  assert.equal(f.project().visibility, 'private');
  // Its own earlier operation still reconciles after the change, answering as the first time.
  await f.set(input);
  assert.equal(f.project().visibility, 'private');
});

test('a trashed project cannot change visibility', async () => {
  const f = fixture('public');
  f.project().removal = 'trash';
  await assert.rejects(f.set({ visibility: 'private' }), code('PROJECT_UNAVAILABLE'));
});
