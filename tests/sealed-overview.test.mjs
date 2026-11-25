// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Secrets page's server read (Item 41a0df87, slice 4): sealedSecrets:overview derives names, holders, the take-out
// and rotate rows and waiting proposals from stored records and returns no bytes; the project's needs-you counter
// moves in the same writes that add or clear a marker, a rotate row or a proposal. Real sealed and contributor Convex
// modules on a synthetic hosted project; synthetic keys and values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { server, setup } from './helpers/sealed-hosted.mjs';
import { device, owner } from './helpers/sealed-devices.mjs';
import { rotateList } from '../dist/sealed-unshare.js';
import { verifySealedReply } from '../dist/sealed-verify.js';

const contributors = await import(moduleUrl('../convex/projectContributors.ts'));
const fields = await import(moduleUrl('../convex/sealedSecretOverviewFields.ts'));
const needsMe = await import(moduleUrl('../convex/projectNeedsMe.ts'));
const init = await import(moduleUrl('../convex/sealedSecretNeedsInit.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const VALUE = Buffer.from('synthetic-overview-value-0123456789'),
  OTHER = Buffer.from('synthetic-other-value-0123456789'),
  ROTATED = Buffer.from('synthetic-rotated-value-9876543210');
const overview = (h, args = {}) => server.overview._handler(h.s.ctx, { projectId: h.project, ...args });
const counter = h => h.s.tables.hostedProjects.get(h.project).secretsNeeds;
const set = h => [...h.s.tables.sealedSecretSets.values()].find(r => r.active && r.kind === 1);
/** Every key of a value, recursively: a page of names never carries bytes. */
function carriesBytes(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (value && typeof value === 'object') return Object.values(value).some(carriesBytes);
  return false;
}
async function joined(h, t, o, account) {
  const m = device(h, t, account);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  return m;
}

test('slice 4: removal, re-key and a new value move the take-out and rotate rows and the project counter together', async t => {
  const h = setup(t),
    o = owner(h);
  h.s.tables.forgeAccounts.set('fa-1', {
    _id: 'fa-1',
    _creationTime: 1,
    owner: 'fixture-member',
    handle: 'dana',
  });
  await o.client.write('API_TOKEN', VALUE);
  await o.client.write('OTHER_TOKEN', OTHER);
  await joined(h, t, o, 'fixture-member');
  assert.equal(counter(h), undefined, 'idle: nothing waits, nothing is stored on the project row');
  // The person leaves: one take-out row, naming their public handle kept on the marker, and the counter is 1.
  await contributors.remove._handler(h.s.ctx, { projectId: h.project, contributor: 'fixture-member' });
  assert.equal(counter(h), 1);
  assert.equal(set(h).needs, 1);
  let read = await overview(h);
  assert.equal(read.status, 'ok');
  assert.equal(read.needs, 1);
  const development = read.sets.find(s => s.kind === 1);
  assert.equal(development.takeOut.length, 1);
  assert.equal(development.takeOut[0].handle, 'dana');
  assert.equal(development.takeOut[0].left, true);
  assert.equal(development.takeOut[0].codes.length, 1);
  assert.deepEqual(
    development.names.page.map(n => n.name),
    ['API_TOKEN', 'OTHER_TOKEN'],
  );
  assert.equal(development.rotate.total, 0, 'nothing is on the rotate list until the marker is taken out');
  assert.equal(carriesBytes(read), false);
  // The needs read carries the counter to write members only.
  const needs = await needsMe.read._handler(h.s.ctx, { projectId: h.project });
  assert.equal(needs.secrets, 1);
  // The owner's next write removes the entry and re-keys: the marker row goes, two rotate rows (and the handle) stay.
  await o.client.write('API_TOKEN', ROTATED);
  read = await overview(h);
  const after = read.sets.find(s => s.kind === 1);
  assert.equal(after.takeOut.length, 0);
  assert.deepEqual(
    after.rotate.page.map(r => r.name),
    ['OTHER_TOKEN'],
  );
  assert.equal(after.rotate.page[0].devices[0].handle, 'dana');
  assert.equal(counter(h), 1, 'one name left to rotate');
  // The page's rotate rows are the CLI's rotate list on the same signed records.
  const state = await o.client.read();
  const pin = state.pin;
  assert.deepEqual(
    after.rotate.page.map(r => r.name),
    rotateList(pin.roster, pin.head).map(r => r.name),
  );
  clear(state);
  // A new value takes the last name off the list and the counter back to zero, which is not stored.
  await o.client.write('OTHER_TOKEN', ROTATED);
  assert.equal(counter(h), undefined);
  assert.equal(set(h).needs, 0, 'a counted set stores its zero, so an uncounted row is told apart');
  assert.equal((await needsMe.read._handler(h.s.ctx, { projectId: h.project })).secrets, undefined);
});

test('slice 4: the overview refuses an outsider, shows a reader nothing, and its return shape has no bytes field', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const outsider = device(h, t, 'fixture-outsider', { member: false });
  await assert.rejects(
    outsider.as(() => overview(h)),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.doesNotMatch(JSON.stringify(fields.overviewResult.json), /"bytes"|"any"/);
  const result = await overview(h);
  assert.equal(result.sets[0].names.page[0].name, 'API_TOKEN');
  assert.equal(carriesBytes(result), false);
  assert.equal(result.sets[0].people.page[0].role, 'owner');
  assert.equal(result.sets[0].people.page[0].computers.length, 1);
});

/** A set row and project row as stored before slice 4: no per-set `needs`, no project counter. */
function legacy(h) {
  delete set(h).needs;
  delete h.s.tables.hostedProjects.get(h.project).secretsNeeds;
}
const project = h => h.s.tables.hostedProjects.get(h.project);

test('slice 4 review: the initialiser counts work pending at rollout (dry run first, replay writes nothing) and a later write never subtracts an uncounted total', async t => {
  const h = setup(t),
    o = owner(h);
  h.s.tables.forgeAccounts.set('fa-1', {
    _id: 'fa-1',
    _creationTime: 1,
    owner: 'fixture-member',
    handle: 'dana',
  });
  await o.client.write('API_TOKEN', VALUE);
  await o.client.write('OTHER_TOKEN', OTHER);
  await joined(h, t, o, 'fixture-member');
  await contributors.remove._handler(h.s.ctx, { projectId: h.project, contributor: 'fixture-member' });
  assert.equal(counter(h), 1);
  legacy(h);
  assert.equal(counter(h), undefined, 'the top bar shows nothing for work the page lists');
  // Dry run: counts what it would change and writes nothing.
  const writes = h.io.writes;
  const dry = await init.initialise._handler(h.s.ctx, { apply: false });
  assert.deepEqual(dry, {
    projects: 1,
    sets: 1,
    setsChanged: 1,
    projectsChanged: 1,
    needsTotal: 1,
    next: null,
  });
  assert.equal(h.io.writes, writes);
  assert.equal(counter(h), undefined);
  assert.equal(set(h).needs, undefined);
  // Apply: the set row and the project counter now hold the pending total.
  assert.deepEqual(await init.initialise._handler(h.s.ctx, { apply: true }), dry);
  assert.equal(set(h).needs, 1);
  assert.equal(counter(h), 1);
  // Replay: nothing differs, so nothing is written.
  const before = h.io.writes;
  assert.deepEqual(await init.initialise._handler(h.s.ctx, { apply: true }), {
    projects: 1,
    sets: 1,
    setsChanged: 0,
    projectsChanged: 0,
    needsTotal: 1,
    next: null,
  });
  assert.equal(h.io.writes, before);
  // The next write moves the counter from what it holds: the person is taken out, two names stay to rotate.
  await o.client.write('API_TOKEN', ROTATED);
  assert.equal(counter(h), 1, 'one name left to rotate');
  assert.equal(set(h).needs, 1);
  await o.client.write('OTHER_TOKEN', ROTATED);
  assert.equal(counter(h), undefined);
  assert.equal(set(h).needs, 0);
});

test('slice 4 review: the first write on an uncounted row adds its whole total, never subtracting what was never counted', async t => {
  const h = setup(t),
    o = owner(h);
  h.s.tables.forgeAccounts.set('fa-1', {
    _id: 'fa-1',
    _creationTime: 1,
    owner: 'fixture-member',
    handle: 'dana',
  });
  await o.client.write('API_TOKEN', VALUE);
  await o.client.write('OTHER_TOKEN', OTHER);
  await joined(h, t, o, 'fixture-member');
  await contributors.remove._handler(h.s.ctx, { projectId: h.project, contributor: 'fixture-member' });
  legacy(h);
  // The owner's write takes the person out and re-keys: API_TOKEN is replaced, OTHER_TOKEN waits to rotate.
  await o.client.write('API_TOKEN', ROTATED);
  assert.equal(set(h).needs, 1);
  assert.equal(counter(h), 1, 'the pending name is counted by this write, not lost');
});

test('slice 4 review: the initialiser pages by project, repairs a wrong counter and refuses a bad limit', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  // A second project holding a copy of the same set row.
  const second = 'fixture-project-2';
  h.s.tables.hostedProjects.set(second, { ...structuredClone(project(h)), _id: second });
  h.s.tables.sealedSecretSets.set('copy', { ...structuredClone(set(h)), _id: 'copy', projectId: second });
  project(h).secretsNeeds = 5;
  const first = await init.initialise._handler(h.s.ctx, { apply: true, limit: 1 });
  assert.equal(first.projects, 1);
  assert.equal(first.projectsChanged, 1);
  assert.equal(counter(h), undefined, 'a counter above the measured zero is repaired');
  assert.notEqual(first.next, null);
  const rest = await init.initialise._handler(h.s.ctx, { apply: true, limit: 1, after: first.next });
  assert.equal(rest.projects, 1);
  // A full page may have more behind it, so the walk ends on the call that finds nothing.
  const end = await init.initialise._handler(h.s.ctx, { apply: true, limit: 1, after: rest.next });
  assert.deepEqual([end.projects, end.next], [0, null]);
  await assert.rejects(init.initialise._handler(h.s.ctx, { apply: false, limit: 17 }), code('BAD_ARGUMENT'));
});

test('fcfc7e62 removing a name closes its rotate task in the same write: Needs you drops to 0', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  await o.client.write('OTHER_TOKEN', OTHER);
  await joined(h, t, o, 'fixture-member');
  await contributors.remove._handler(h.s.ctx, { projectId: h.project, contributor: 'fixture-member' });
  await o.client.write('API_TOKEN', ROTATED);
  assert.equal(counter(h), 1, 'OTHER_TOKEN waits to be rotated');
  assert.equal((await overview(h)).sets[0].rotate.total, 1);
  // The owner removes the name instead of rotating it: the task, the page and the counter clear together.
  await o.client.write('OTHER_TOKEN', null);
  assert.equal(counter(h), undefined);
  assert.equal(set(h).needs, 0);
  const read = await overview(h);
  assert.equal(read.needs, 0);
  assert.equal(read.sets[0].rotate.total, 0);
  assert.deepEqual(
    read.sets[0].names.page.map(n => n.name),
    ['API_TOKEN'],
  );
});

test('fcfc7e62 a device given its name shows it in the holder list; an unnamed older entry shows its code alone', async t => {
  const h = setup(t),
    o = owner(h, { deviceName: 'MacBook Air' });
  await o.client.write('API_TOKEN', VALUE);
  let people = (await overview(h)).sets[0].people.page[0];
  assert.deepEqual(
    people.computers.map(c => c.name),
    ['MacBook Air'],
    'the first device signs its given name into its roster entry',
  );

  // A joining device carries its given name in its own request, so the entry a holder signs for it is named.
  const m = device(h, t, 'fixture-member', { deviceName: 'dana-laptop' });
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  const state = await o.client.read();
  assert.deepEqual(state.pin.roster.entries.map(e => e.displayName).sort(), ['MacBook Air', 'dana-laptop']);
  clear(state);
  // Before names were passed on, a genesis said "this device": that is a placeholder, not a given name.
  const old = setup(t);
  await old.client.write('API_TOKEN', VALUE);
  assert.equal(
    (await overview(old)).sets[0].people.page[0].computers[0].name,
    'synthetic',
    'the sign-in name stands in for the placeholder, taken in the device’s own write',
  );
  // A set stored before that: the placeholder is never shown, the code stands alone until the device writes again.
  delete set(old).entryNames;
  people = (await overview(old)).sets[0].people.page[0];
  assert.equal(people.computers[0].name, undefined, 'no "this device" in the list');
});
