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
  assert.equal(set(h).needs, undefined);
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
