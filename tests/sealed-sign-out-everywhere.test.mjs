// SPDX-License-Identifier: Apache-2.0
// Gate B2 (Item 14314add) M3 follow-up, owner 2026-11-23: "Sign out everywhere" marks every sealed device of the
// account in its linked projects (the issuer is a browser session, which holds no sealed device), never the set's
// last unmarked owner device, so a lost laptop is re-keyed on the next owner write. Real sealed, marker and
// sign-out sweep Convex modules on a synthetic hosted project; synthetic keys and values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { server, setup } from './helpers/sealed-hosted.mjs';
import { device, owner } from './helpers/sealed-devices.mjs';
import { deviceKeys } from '../dist/sealed-keys.js';
import { forgeSecretId } from '../dist/sealed-format.js';
import { deviceFingerprint } from '../dist/sealed-join.js';
import { sealedWrite, sealedWriteArgs } from '../dist/sealed-transport.js';
import { rotateList } from '../dist/sealed-unshare.js';

const credentials = await import(moduleUrl('../convex/deviceCredentials.ts'));
const sweep = await import(moduleUrl('../convex/deviceEndAll.ts'));
const markers = await import(moduleUrl('../convex/sealedSecretMarkers.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
const VALUE = Buffer.from('synthetic-sign-out-everywhere-value-0123');
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const set = h => [...h.s.tables.sealedSecretSets.values()].find(r => r.active);
const hex = id => Buffer.from(id).toString('hex');
const marks = h => (set(h)?.revoked ?? []).map(id => hex(id)).sort();
const credential = (h, id) => [...h.s.tables.cliCredentials.values()].find(r => r.credentialId === id);
const markSteps = (h, from) =>
  h.s.scheduled.slice(from).filter(e => getFunctionName(e.fn) === 'sealedSecretMarkers:markSignIn');

/** The account's synthetic users row: the sweep moves its sign-out epoch, and a device sign-out reads it. */
function user(h, account) {
  for (const table of ['users', 'authLinkEvents']) h.s.tables[table] ??= new Map();
  if (![...h.s.tables.users.values()].some(u => u.accountKey === account))
    h.s.tables.users.set(`user-${account}`, {
      _id: `user-${account}`,
      _creationTime: 1,
      accountKey: account,
      emailVerified: false,
    });
}
/** Runs the account's sign-out sweep (its first page in the starting mutation) and returns the scheduled steps. */
async function everywhere(h, account, options) {
  user(h, account);
  const from = h.s.scheduled.length;
  await h.s.transaction(() => sweep.endAccountDevices(h.s.ctx, account, undefined, options));
  return markSteps(h, from);
}
const run = (h, step) => h.s.transaction(() => markers.markSignIn._handler(h.s.ctx, step.args));

test("M3 follow-up: Sign out everywhere marks the member's laptop, signed out earlier or not, skips a later sign-in, and the next owner write re-keys", async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const m = device(h, t, 'fixture-member'),
    fp = deviceFingerprint(m.keys.id);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  // `nforge logout` on the laptop marked nothing and kept its link (the person held it then).
  user(h, 'fixture-member');
  h.identity.subject = 'fixture-member';
  h.identity.forgeCredential = 'fixture-member-device';
  await h.s.transaction(() =>
    credentials.revoke._handler(h.s.ctx, {
      credentialId: 'fixture-member-device',
      operationId: randomUUID(),
    }),
  );
  Object.assign(h.identity, { subject: h.account, forgeCredential: 'sealed-device' });
  assert.equal(credential(h, 'fixture-member-device').revoked, true);
  assert.deepEqual(marks(h), []);
  // A sign-in issued after the start (its epoch read in its own transaction) is not swept.
  h.s.tables.cliCredentials.set('later-row', {
    ...structuredClone(credential(h, 'fixture-member-device')),
    _id: 'later-row',
    credentialId: 'fixture-member-later',
    revoked: false,
    signOutEpoch: 1,
  });
  // Review M2: an older signed-out sign-in of the same device in the same project is marked once, in the same step.
  h.s.tables.cliCredentials.set('older-row', {
    ...structuredClone(credential(h, 'fixture-member-device')),
    _id: 'older-row',
    credentialId: 'fixture-member-older',
  });
  const steps = await everywhere(h, 'fixture-member', { markSealed: true });
  assert.deepEqual(
    steps.map(s => [s.args.everywhere, s.args.links.map(l => [l.projectId, hex(l.deviceId)])]),
    [[true, [[h.project, hex(m.keys.id)]]]],
  );
  assert.equal(credential(h, 'fixture-member-later').revoked, false);
  for (const step of steps) await run(h, step);
  assert.deepEqual(marks(h), [hex(m.keys.id)]);
  // The owner's account was not signed out: its device is untouched, and its next write removes and re-keys.
  o.notices.length = 0;
  await o.client.write('NEXT_TOKEN', VALUE);
  assert(
    o.notices.some(line => line.includes(`Removed fp ${fp}`) && line.includes('could open: API_TOKEN.')),
  );
  const state = await o.client.read();
  try {
    assert.equal(state.pin.roster.epoch, 2);
    assert(!state.pin.roster.entries.some(e => e.id.equals(m.keys.id)));
    assert.deepEqual(rotateList(state.pin.roster, state.pin.head), [{ name: 'API_TOKEN', devices: [fp] }]);
  } finally {
    clear(state);
  }
});

/** Synthetic: the owner's first device adds a second owner device of its own account, and optionally an owner
 * device of another account; each of the owner's two devices has its own linked sign-in. */
async function twoOwnerDevices(h, { coOwner = false, ownMember = false } = {}) {
  const f = h.f;
  f.name();
  const genesis = sealedWrite(f.reply, randomUUID(), null);
  await h.s.transaction(() =>
    server.write._handler(h.s.ctx, { ...sealedWriteArgs(genesis), kind: 1, projectId: h.project }),
  );
  const second = deviceKeys(forgeSecretId('account', h.account), f.random);
  const other = coOwner ? deviceKeys(forgeSecretId('account', 'fixture-co-owner'), f.random) : null;
  const member = ownMember ? deviceKeys(forgeSecretId('account', h.account), f.random) : null;
  f.bump();
  f.transition({
    added: [
      f.entry(second, { role: 1, how: 4, addedAtRosterVersion: 2 }),
      ...(member ? [f.entry(member, { role: 2, how: 4, addedAtRosterVersion: 2 })] : []),
      ...(other
        ? [
            f.entry(other, {
              accountId: forgeSecretId('account', 'fixture-co-owner'),
              accountHandle: 'fixture-co-owner',
              role: 1,
              how: 6,
              addedAtRosterVersion: 2,
            }),
          ]
        : []),
    ],
  });
  const step = sealedWrite(f.reply, randomUUID(), {
    headHash: Buffer.from(genesis.headHash),
    rosterVersion: 1,
  });
  const written = await h.s.transaction(() =>
    server.write._handler(h.s.ctx, { ...sealedWriteArgs(step), kind: 1, projectId: h.project }),
  );
  assert.equal(written.accepted, true);
  h.s.tables.cliCredentials.set('second-row', {
    ...structuredClone(h.s.tables.cliCredentials.get('device-row')),
    _id: 'second-row',
    credentialId: 'second-device',
    sealed: [{ projectId: h.project, deviceId: Uint8Array.from(second.id).buffer }],
  });
  if (member)
    h.s.tables.cliCredentials.set('member-row', {
      ...structuredClone(h.s.tables.cliCredentials.get('device-row')),
      _id: 'member-row',
      credentialId: 'member-device',
      sealed: [{ projectId: h.project, deviceId: Uint8Array.from(member.id).buffer }],
    });
  const first = h.s.tables.cliCredentials.get('device-row').sealed.map(l => hex(l.deviceId));
  return { owned: [...first, hex(second.id)].sort(), other, member };
}
/** The sweep's links, each run as its own step in `order` (any split of the pairs gives the same marks). */
async function runSplit(h, steps, order) {
  const links = steps.flatMap(s => s.args.links);
  for (const l of order === 'reversed' ? links.reverse() : links)
    await run(h, { args: { owner: h.account, links: [l], everywhere: true } });
}

test('M3 follow-up: when the account holds every owner device, Sign out everywhere marks none of them in either step order (no coin-flip lockout)', async t => {
  for (const order of ['swept', 'reversed']) {
    const h = setup(t);
    const { member } = await twoOwnerDevices(h, { ownMember: true });
    const steps = await everywhere(h, h.account, { markSealed: true });
    assert.equal(steps.length, 1, order);
    assert.equal(steps[0].args.links.length, 3, order);
    await runSplit(h, steps, order);
    // Review L4: its own member-role device is still marked, since its owner devices stay to act on it.
    assert.deepEqual(marks(h), [hex(member.id)], order);
  }
});

test("M3 follow-up: when another account's owner device is already marked, the account's owner devices stay unmarked", async t => {
  const h = setup(t);
  const { other } = await twoOwnerDevices(h, { coOwner: true });
  const row = set(h);
  row.revoked = [Uint8Array.from(other.id).buffer];
  for (const s of await everywhere(h, h.account, { markSealed: true })) await run(h, s);
  assert.deepEqual(marks(h), [hex(other.id)]);
});

test("M3 follow-up: with another account's owner device unmarked, Sign out everywhere marks both of the account's owner devices", async t => {
  for (const order of ['swept', 'reversed']) {
    const h = setup(t);
    const { owned, other } = await twoOwnerDevices(h, { coOwner: true });
    const steps = await everywhere(h, h.account, { markSealed: true });
    await runSplit(h, steps, order);
    assert.deepEqual(marks(h), owned, order);
    assert(!marks(h).includes(hex(other.id)), order);
    // Every step re-reads the set: running one again marks nothing more.
    for (const s of steps) await run(h, s);
    assert.deepEqual(marks(h), owned, order);
  }
});

test('M3 follow-up: a sweep without markSealed (an operator suspension) signs devices out and marks no sealed device', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const m = device(h, t, 'fixture-member');
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  assert.deepEqual(await everywhere(h, 'fixture-member'), []);
  assert.equal(credential(h, 'fixture-member-device').revoked, true);
  assert.deepEqual(marks(h), []);
});

test('M3 follow-up review L3: a sweep past one page keeps marking: the next page step carries markSealed and marks its rows', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const m = device(h, t, 'fixture-member');
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  // 100 sign-ins without links fill the first page; the 101st holds the laptop's link.
  const linked = credential(h, 'fixture-member-device');
  const link = linked.sealed;
  delete linked.sealed;
  for (let i = 0; i < 100; i++)
    h.s.tables.cliCredentials.set(`filler-${i}`, {
      ...structuredClone(linked),
      _id: `filler-${i}`,
      credentialId: `fixture-member-filler-${i}`,
      ...(i === 99 ? { sealed: link } : {}),
    });
  const from = h.s.scheduled.length;
  assert.deepEqual(await everywhere(h, 'fixture-member', { markSealed: true }), []);
  const pages = h.s.scheduled.slice(from).filter(e => getFunctionName(e.fn) === 'deviceEndAll:next');
  assert.equal(pages.length, 1);
  assert.equal(pages[0].args.markSealed, true);
  const before = h.s.scheduled.length;
  await h.s.transaction(() => sweep.next._handler(h.s.ctx, pages[0].args));
  const steps = markSteps(h, before);
  assert.equal(steps.length, 1);
  for (const step of steps) await run(h, step);
  assert.deepEqual(marks(h), [hex(m.keys.id)]);
});
