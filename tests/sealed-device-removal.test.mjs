// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Gate B2 (Item 14314add) M3: ending one device's sign-in from elsewhere, or removing it, marks that sealed device
// alone, so a lost laptop is removed and re-keyed on the next owner write and its rotate list is printed. M1: only an
// owner device removes another account's entry, marker or not. Real sealed, marker and device-credential Convex
// modules on a synthetic hosted project; synthetic keys and values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { server, setup } from './helpers/sealed-hosted.mjs';
import { device, owner } from './helpers/sealed-devices.mjs';
import { deviceKeys } from '../dist/sealed-keys.js';
import { forgeSecretId } from '../dist/sealed-format.js';
import { deviceFingerprint } from '../dist/sealed-join.js';
import { sealedWrite, sealedWriteArgs } from '../dist/sealed-transport.js';
import { createTransition } from '../dist/sealed-transition.js';
import { rotateList } from '../dist/sealed-unshare.js';

const credentials = await import(moduleUrl('../convex/deviceCredentials.ts'));
const markers = await import(moduleUrl('../convex/sealedSecretMarkers.ts'));
const gate = await import(moduleUrl('../convex/sealedSecretGate.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
const VALUE = Buffer.from('synthetic-device-removal-value-0123456789');
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const set = h => [...h.s.tables.sealedSecretSets.values()].find(r => r.active);
const marks = h => (set(h)?.revoked ?? []).map(id => Buffer.from(id).toString('hex')).sort();
const hex = id => Buffer.from(id).toString('hex');
const row = (h, account) =>
  [...h.s.tables.cliCredentials.values()].find(r => r.credentialId === `${account}-device`);

/** Ends a sign-in as `subject`: from the browser (a person, the default) or from that device itself. */
async function end(h, credentialId, { action = 'signout', subject = h.account, fromDevice = false } = {}) {
  for (const table of ['users', 'authLinkEvents']) h.s.tables[table] ??= new Map();
  if (!h.s.tables.users.has(`user-${subject}`))
    h.s.tables.users.set(`user-${subject}`, {
      _id: `user-${subject}`,
      _creationTime: 1,
      accountKey: subject,
    });
  const saved = { ...h.identity };
  for (const key of Object.keys(h.identity)) delete h.identity[key];
  Object.assign(
    h.identity,
    fromDevice ? { subject, forgeCredential: credentialId, forgeSignIn: 'sign-in' } : { subject },
  );
  try {
    return await h.s.transaction(() =>
      credentials.revoke._handler(h.s.ctx, { credentialId, operationId: randomUUID(), action }),
    );
  } finally {
    for (const key of Object.keys(h.identity)) delete h.identity[key];
    Object.assign(h.identity, saved);
  }
}
/** A write member whose device joined Development automatically and read its values. */
async function joined(h, t, o, account) {
  const m = device(h, t, account);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  return m;
}

test("M3: signing a member's lost laptop out from Account settings marks that device; the next owner write removes it, re-keys and prints the rotate list", async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const m = await joined(h, t, o, 'fixture-member'),
    fp = deviceFingerprint(m.keys.id);
  // The join linked the joining device to its own sign-in, and the genesis write linked the owner's.
  assert.deepEqual(
    row(h, 'fixture-member').sealed.map(l => [l.projectId, hex(l.deviceId)]),
    [[h.project, hex(m.keys.id)]],
  );
  assert.deepEqual(
    h.s.tables.cliCredentials.get('device-row').sealed.map(l => hex(l.deviceId)),
    [hex(o.client.keys.id)],
  );
  await end(h, 'fixture-member-device', { subject: 'fixture-member' });
  assert.deepEqual(marks(h), [hex(m.keys.id)]);
  o.notices.length = 0;
  clear(await o.client.read());
  assert(o.notices.some(line => line.includes(`fp ${fp}`) && line.includes('device sign-in ended')));
  o.notices.length = 0;
  await o.client.write('NEXT_TOKEN', VALUE);
  assert(
    o.notices.some(line => line.includes(`Removed fp ${fp}`) && line.includes('could open: API_TOKEN.')),
  );
  assert.equal(set(h).revoked, undefined);
  const state = await o.client.read();
  try {
    assert.equal(state.pin.roster.epoch, 2);
    assert(!state.pin.roster.entries.some(e => e.id.equals(m.keys.id)));
    assert.deepEqual(rotateList(state.pin.roster, state.pin.head), [{ name: 'API_TOKEN', devices: [fp] }]);
  } finally {
    clear(state);
  }
});

test("M3: removing the owner's own second owner device marks it, and the owner's other device removes it", async t => {
  const h = setup(t),
    f = h.f;
  // Synthetic: the owner's first device adds a second owner device of the same account (own-device addition).
  f.name();
  const genesis = sealedWrite(f.reply, randomUUID(), null);
  await h.s.transaction(() =>
    server.write._handler(h.s.ctx, { ...sealedWriteArgs(genesis), kind: 1, projectId: h.project }),
  );
  const second = deviceKeys(forgeSecretId('account', h.account), f.random);
  const base = { headHash: Buffer.from(genesis.headHash), rosterVersion: 1 };
  f.bump();
  f.transition({ added: [f.entry(second, { role: 1, how: 4, addedAtRosterVersion: 2 })] });
  const step = sealedWrite(f.reply, randomUUID(), base);
  assert.equal(
    (
      await h.s.transaction(() =>
        server.write._handler(h.s.ctx, { ...sealedWriteArgs(step), kind: 1, projectId: h.project }),
      )
    ).accepted,
    true,
  );
  // The second device's own sign-in, linked when it wrote or joined (linking itself is the test above).
  h.s.tables.cliCredentials.set('second-row', {
    ...structuredClone(h.s.tables.cliCredentials.get('device-row')),
    _id: 'second-row',
    credentialId: 'second-device',
    sealed: [{ projectId: h.project, deviceId: Uint8Array.from(second.id).buffer }],
  });
  // Review H1: with the second device marked, ending the first one's sign-in too marks nothing more, so one owner
  // device can still read and remove (two owner devices ended one at a time never lock the set).
  await end(h, 'second-device', { action: 'remove' });
  assert.deepEqual(marks(h), [hex(second.id)]);
  await end(h, 'sealed-device');
  assert.deepEqual(marks(h), [hex(second.id)]);
  h.s.tables.cliCredentials.get('device-row').revoked = false;
  assert.equal(h.s.tables.cliCredentials.get('second-row').sealed, undefined);
  const o = owner(h);
  o.notices.length = 0;
  await o.client.write('NEXT_TOKEN', VALUE);
  assert(o.notices.some(line => line.includes(`Removed fp ${deviceFingerprint(second.id)}`)));
  const state = await o.client.read();
  try {
    assert(!state.pin.roster.entries.some(e => e.id.equals(second.id)));
    assert.equal(state.pin.roster.epoch, 2);
  } finally {
    clear(state);
  }
});

test('M3: nforge logout on the device itself, the last owner device and a sign-in without sealed links mark nothing', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const m = await joined(h, t, o, 'fixture-member');
  // The person holds the device: its own sign-out keeps it (its keys stay for its next sign-in).
  await end(h, 'fixture-member-device', { subject: 'fixture-member', fromDevice: true });
  assert.equal(row(h, 'fixture-member').revoked, true);
  assert.deepEqual(marks(h), []);
  // Removing that signed-out device later still marks it.
  await end(h, 'fixture-member-device', { subject: 'fixture-member', action: 'remove' });
  assert.deepEqual(marks(h), [hex(m.keys.id)]);
  // The set's only owner device is never marked: no device could act on it, and its own reads would refuse it.
  await end(h, 'sealed-device');
  assert.deepEqual(marks(h), [hex(m.keys.id)]);
  // Cost: a sign-in that never used sealed secrets reads no sealed set when it ends.
  const reader = device(h, t, 'fixture-reader');
  const tables = [];
  const ctx = h.s.ctx,
    db = ctx.db;
  ctx.db = new Proxy(db, {
    get(target, key) {
      if (key === 'query') return table => (tables.push(table), target.query(table));
      const member = Reflect.get(target, key);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  try {
    await end(h, 'fixture-reader-device', { subject: 'fixture-reader', action: 'remove' });
  } finally {
    ctx.db = db;
  }
  assert(reader);
  assert(!tables.includes('sealedSecretSets'));
});

test('M3: a link names only its own account, drops that device’s waiting join request, and stays bounded', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const kept = await joined(h, t, o, 'fixture-kept');
  const waiting = device(h, t, 'fixture-waiting');
  await assert.rejects(waiting.client.read(), code('SECRETS_WAITING'));
  // A link a client claimed for another person's device marks nothing.
  assert.equal(
    gate.markersForEndedDevice(set(h), forgeSecretId('account', 'fixture-other'), [kept.keys.id]),
    null,
  );
  // Ending the waiting device's sign-in drops its join request; it had no entry to mark.
  await end(h, 'fixture-waiting-device', { subject: 'fixture-waiting' });
  assert.equal(set(h).joinRequests, undefined);
  assert.deepEqual(marks(h), []);
  // The credential row is read on every call, so its links are bounded: past the bound a new link is refused.
  const ownerRow = h.s.tables.cliCredentials.get('device-row');
  ownerRow.sealed = Array.from({ length: markers.SEALED_LINKS }, (_, i) => ({
    projectId: h.project,
    deviceId: Uint8Array.from(Buffer.alloc(16, i + 1)).buffer,
  }));
  const head = set(h).headHash;
  await assert.rejects(o.client.write('NEXT_TOKEN', VALUE), code('SECRETS_NOT_ALLOWED'));
  assert.deepEqual(set(h).headHash, head);
  // Review L2: at the bound, links to deleted projects are dropped first, so the bound never fills for good.
  ownerRow.sealed = Array.from({ length: markers.SEALED_LINKS }, (_, i) => ({
    projectId: `fixture-deleted-${i}`,
    deviceId: Uint8Array.from(o.client.keys.id).buffer,
  }));
  await o.client.write('NEXT_TOKEN', VALUE);
  assert.deepEqual(
    h.s.tables.cliCredentials.get('device-row').sealed.map(l => [l.projectId, hex(l.deviceId)]),
    [[h.project, hex(o.client.keys.id)]],
  );
  // An existing link is never re-written: the owner's write in a linked project patches no credential row.
  ownerRow.sealed = [{ projectId: h.project, deviceId: Uint8Array.from(o.client.keys.id).buffer }];
  const before = structuredClone(ownerRow);
  await o.client.write('NEXT_TOKEN', VALUE);
  assert.deepEqual(h.s.tables.cliCredentials.get('device-row'), before);
});

test('M3: more linked projects than one step marks are marked in scheduled steps', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const m = await joined(h, t, o, 'fixture-member');
  const member = row(h, 'fixture-member');
  // Earlier linked projects (since emptied) come first, so this project is past the first step.
  member.sealed = [
    ...Array.from({ length: markers.DEVICE_MARK_PAGE }, (_, i) => ({
      projectId: `fixture-gone-${i}`,
      deviceId: Uint8Array.from(m.keys.id).buffer,
    })),
    ...member.sealed,
  ];
  const before = h.s.scheduled.length;
  await end(h, 'fixture-member-device', { subject: 'fixture-member' });
  assert.deepEqual(marks(h), []);
  const steps = h.s.scheduled.slice(before);
  assert.equal(steps.length, 1);
  await h.s.transaction(() => markers.markSignIn._handler(h.s.ctx, steps[0].args));
  assert.deepEqual(marks(h), [hex(m.keys.id)]);
  assert.equal(h.s.scheduled.length, before + 1, 'the last step schedules nothing more');
});

test("M1: a write member's step that removes another account's entry is refused, marker or not", async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const a = await joined(h, t, o, 'fixture-a'),
    b = await joined(h, t, o, 'fixture-b');
  const state = await a.client.read();
  try {
    const delta = {
      added: [],
      removed: [b.keys.id],
      roles: [],
      droppedFormer: [],
      newSharingMode: null,
      newChecksPointer: null,
      supersede: null,
      epochBumped: 1,
    };
    for (const revoked of [[], [b.keys.id]])
      assert.throws(
        () => createTransition(state.pin.roster, delta, a.keys, { revoked }),
        code('SECRETS_ROSTER_REFUSED'),
      );
    // An owner device still removes it.
    const ownerState = await o.client.read();
    try {
      assert.doesNotThrow(() =>
        createTransition(ownerState.pin.roster, delta, o.client.keys, { revoked: [b.keys.id] }),
      );
    } finally {
      clear(ownerState);
    }
  } finally {
    clear(state);
  }
});

test('M3 review M1: a device linked before links existed records itself on its next read, so signing it out marks it', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const m = await joined(h, t, o, 'fixture-member');
  // As before this change: listed in the roster, no link on its sign-in.
  delete row(h, 'fixture-member').sealed;
  clear(await m.client.read(true));
  assert.deepEqual(
    row(h, 'fixture-member').sealed.map(l => [l.projectId, hex(l.deviceId)]),
    [[h.project, hex(m.keys.id)]],
  );
  // Linked: the next read carries no flag and makes no link call.
  const reply = await m.transport.read({ kind: 1 });
  assert.equal(reply.unlinked, undefined);
  // A link names only a device entry of the caller's own account.
  delete row(h, 'fixture-member').sealed;
  assert.deepEqual(await m.transport.link({ kind: 1, deviceId: Uint8Array.from(o.client.keys.id).buffer }), {
    linked: false,
  });
  assert.equal(row(h, 'fixture-member').sealed, undefined);
  clear(await m.client.read());
  await end(h, 'fixture-member-device', { subject: 'fixture-member' });
  assert.deepEqual(marks(h), [hex(m.keys.id)]);
  // Review M3: signed in again before an owner acts, the device is told Forge marked it.
  row(h, 'fixture-member').revoked = false;
  await assert.rejects(
    m.client.read(),
    e => e.code === 'SECRETS_ROSTER_REFUSED' && /Forge marked this device for removal/.test(e.message),
  );
});
