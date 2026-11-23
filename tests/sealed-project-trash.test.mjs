// SPDX-License-Identifier: Apache-2.0
// Item 41a0df87 "Project trash or delete": trashing a project removes every grant but its owner's and a restore
// brings none back, so the trash marks every other account its sealed sets list (design 5.5,
// docs/security.d/sections/1220-sealed-removal.md). A restored project never gives a removed person back a value.
// Real project lifecycle, contributor and sealed Convex modules on a synthetic hosted project; synthetic keys and
// values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { setup } from './helpers/sealed-hosted.mjs';
import { device, owner } from './helpers/sealed-devices.mjs';

import { forgeSecretId } from '../dist/sealed-format.js';
import { encodeSealedWire } from '../dist/sealed-wire.js';

const lifecycle = await import(moduleUrl('../convex/projectLifecycle.ts'));
const gate = await import(moduleUrl('../convex/sealedSecretGate.ts'));
const markers = await import(moduleUrl('../convex/sealedSecretMarkers.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const VALUE = Buffer.from('synthetic-trash-value-0123456789'),
  ROTATED = Buffer.from('synthetic-trash-rotated-9876543210');
const set = h => [...h.s.tables.sealedSecretSets.values()].find(r => r.active);
const marks = h => (set(h).revoked ?? []).map(id => Buffer.from(id).toString('hex')).sort();
const ids = (...devices) => devices.map(d => d.keys.id.toString('hex')).sort();
/** A write member whose first device joined Development automatically and read its values. */
async function joined(h, t, o, account) {
  const m = device(h, t, account);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  return m;
}
/** The owner's own trash or restore, as the web or an owner device calls it, at the project's current revision. */
function move(h, action, db = h.s.ctx) {
  const project = h.s.tables.hostedProjects.get(h.project);
  return h.s.transaction(() =>
    lifecycle[action]._handler(db, {
      projectId: h.project,
      operationId: randomUUID(),
      expectedRevision: project.revision,
    }),
  );
}
const grants = h => [...h.s.tables.projectContributors.values()].filter(r => r.projectId === h.project);

test('Done-when project trash: trash marks every listed person but the owner, and a restore gives none of them a value back', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const m = await joined(h, t, o, 'fixture-member');
  // A second writer whose join request is still waiting when the project goes to the trash.
  const w = device(h, t, 'fixture-waiting');
  await assert.rejects(w.client.read(), code('SECRETS_WAITING'));
  assert.equal(set(h).joinRequests.length, 1);

  await move(h, 'trash');
  assert.deepEqual(marks(h), ids(m), 'the member is marked; the owner never is');
  assert.equal(set(h).joinRequests, undefined, 'the waiting request is dropped');
  assert.deepEqual(grants(h), [], 'trash revoked the grants');

  await move(h, 'restore');
  assert.equal(h.s.tables.hostedProjects.get(h.project).removal, undefined);
  assert.deepEqual(grants(h), [], 'restore brings no grant back');
  assert.deepEqual(marks(h), ids(m), 'markers outlive the restore');
  await assert.rejects(m.client.read(), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(w.client.read(), code('PROJECT_UNAVAILABLE'));
  // Invited back before the owner re-keys: the marked device still opens nothing, and the marker stays.
  h.s.tables.projectContributors.set('pc-fixture-member', {
    _id: 'pc-fixture-member',
    _creationTime: 1,
    projectId: h.project,
    contributor: 'fixture-member',
  });
  await assert.rejects(m.client.read(), code('SECRETS_ROSTER_REFUSED'));
  assert.deepEqual(marks(h), ids(m));
  // A newcomer waits while the marker names an entry: the owner's read shares nobody.
  const c = device(h, t, 'fixture-newcomer');
  await assert.rejects(c.client.read(), code('SECRETS_WAITING'));
  // The owner sees the marker, an agent cannot write past it, and the owner's next person write removes and re-keys.
  o.notices.length = 0;
  clear(await o.client.read());
  assert(o.notices.some(line => line.includes('nforge secret unshare --marked')));
  await assert.rejects(c.client.read(), code('SECRETS_WAITING'));
  await assert.rejects(o.make({ agent: true }).write('NEW_TOKEN', VALUE), code('SECRETS_REKEY_PENDING'));
  await o.client.write('API_TOKEN', ROTATED);
  assert.equal(set(h).revoked, undefined);
  const state = await o.client.read();
  try {
    assert.equal(state.pin.roster.epoch, 2);
    assert(!state.pin.roster.entries.some(e => e.id.equals(m.keys.id)));
    assert(!state.reply.wraps.some(w => w.recipientId.equals(m.keys.id)));
  } finally {
    clear(state);
  }
  // The re-invited person's old device now opens nothing, including the value written after the restore.
  await assert.rejects(m.client.read(), code('SECRETS_ROSTER_REFUSED'));
});

test('review 1: trash never marks a machine entry (it has no account) and lists each account once', async t => {
  const h = setup(t);
  await owner(h).client.write('API_TOKEN', VALUE);
  const entry = (n, accountId, entryKind = 1) => ({ id: Buffer.alloc(16, n), accountId, entryKind });
  const member = forgeSecretId('account', 'fixture-member');
  const payload = encodeSealedWire({
    roster: {
      entries: [
        entry(1, forgeSecretId('account', h.account)),
        entry(2, member),
        entry(3, member),
        entry(4, Buffer.alloc(0), 2),
      ],
    },
  });
  // The stored row keeps every other field; only its roster is synthetic (the marking reads nothing else).
  const row = set(h);
  row.payload = Uint8Array.from(payload).buffer;
  assert.deepEqual(
    gate.markableAccountIds(row).map(id => Buffer.from(id).toString('hex')),
    [forgeSecretId('account', h.account), member].map(id => Buffer.from(id).toString('hex')),
  );
  await h.s.transaction(() => markers.markTrashedProject(h.s.ctx, h.project, h.account));
  assert.deepEqual(
    marks(h),
    [2, 3].map(n => Buffer.alloc(16, n).toString('hex')),
  );
});

test('cost: trashing a project with no sealed set reads only its three empty set ranges', async t => {
  const h = setup(t);
  const queried = [];
  const db = h.s.ctx.db;
  const counting = {
    ...h.s.ctx,
    db: new Proxy(db, {
      get(target, key) {
        if (key === 'query') return table => (queried.push(table), target.query(table));
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    }),
  };
  await move(h, 'trash', counting);
  assert.equal(h.s.tables.hostedProjects.get(h.project).removal, 'trash');
  assert.equal(queried.filter(name => name === 'sealedSecretSets').length, 3);
  assert(!queried.includes('sealedSecretHistory'));
});
