// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Design 5.5 removal: server-owned markers when a person leaves the project, the re-key on a person's next
// write, `unshare --marked`, and the rotate list derived from signed records. Real sealed and contributor
// Convex modules on a synthetic hosted project; synthetic keys and values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { setup } from './helpers/sealed-hosted.mjs';
import { device, owner } from './helpers/sealed-devices.mjs';
import { deviceFingerprint } from '../dist/sealed-join.js';
import { forgeSecretId } from '../dist/sealed-format.js';
import { encodeSealedWire } from '../dist/sealed-wire.js';
import { droppableFormers, markerNotice, removeMarked, rotateList } from '../dist/sealed-unshare.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { markedEntries } from '../dist/sealed-roster.js';
import { SealedClient } from '../dist/sealed-client.js';

const contributors = await import(moduleUrl('../convex/projectContributors.ts'));
const gate = await import(moduleUrl('../convex/sealedSecretGate.ts'));
const actorNames = await import(moduleUrl('../convex/projectActorNames.ts'));
const code = expected => error => (error.code ?? error.data?.code) === expected;
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const VALUE = Buffer.from('synthetic-removal-value-0123456789'),
  OTHER = Buffer.from('synthetic-other-value-0123456789'),
  ROTATED = Buffer.from('synthetic-rotated-value-9876543210');
const set = h => [...h.s.tables.sealedSecretSets.values()].find(r => r.active);
const marks = h => (set(h).revoked ?? []).map(id => Buffer.from(id).toString('hex')).sort();
/** A write member whose first device joined Development automatically and read its values. */
async function joined(h, t, o, account) {
  const m = device(h, t, account);
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  clear(await m.client.read());
  return m;
}
const removePerson = (h, contributor) =>
  contributors.remove._handler(h.s.ctx, { projectId: h.project, contributor });

test('Done-when removal: a person who leaves is marked, the next person write removes and re-keys, and the rotate list follows', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  await o.client.write('OTHER_TOKEN', OTHER);
  const m = await joined(h, t, o, 'fixture-member'),
    fp = deviceFingerprint(m.keys.id);
  // Removing the person from the project marks their entry in the same mutation; their read is refused at once.
  await removePerson(h, 'fixture-member');
  assert.deepEqual(marks(h), [m.keys.id.toString('hex')]);
  await assert.rejects(m.client.read(), code('PROJECT_UNAVAILABLE'));
  // Every holder sees it on its next read, with the fingerprint and the command.
  o.notices.length = 0;
  clear(await o.client.read());
  assert(
    o.notices.some(line => line.includes(`fp ${fp}`) && line.includes('nforge secret unshare --marked')),
  );
  // An agent never removes anyone: its write is refused with the next step, and nothing is written.
  const before = set(h).headHash;
  await assert.rejects(o.make({ agent: true }).write('NEW_TOKEN', VALUE), code('SECRETS_REKEY_PENDING'));
  assert.deepEqual(set(h).headHash, before);
  // A person's next write removes and re-keys first, in its own write, then makes its change.
  const calls = h.calls.length;
  o.notices.length = 0;
  await o.client.write('API_TOKEN', ROTATED);
  assert.deepEqual(
    h.calls.slice(calls).map(c => c.action),
    ['read', 'write', 'read', 'write'],
  );
  assert(
    o.notices.some(
      line => line.includes(`Removed fp ${fp}`) && line.includes('could open: API_TOKEN, OTHER_TOKEN.'),
    ),
  );
  assert.equal(set(h).revoked, undefined);
  const state = await o.client.read();
  try {
    assert.equal(state.pin.roster.epoch, 2);
    assert(!state.pin.roster.entries.some(e => e.id.equals(m.keys.id)));
    assert(!state.reply.wraps.some(w => w.recipientId.equals(m.keys.id)));
    assert.equal(state.secrets.find(s => s.name === 'API_TOKEN').value.equals(ROTATED), true);
    // Derived from the signed roster and head: the rotated value is off the list, the unchanged one stays.
    assert.deepEqual(rotateList(state.pin.roster, state.pin.head), [{ name: 'OTHER_TOKEN', devices: [fp] }]);
  } finally {
    clear(state);
  }
  // Coming back to the project does not bring the device back: it opens nothing written after its removal.
  h.s.tables.projectContributors.set('pc-fixture-member', {
    _id: 'pc-fixture-member',
    _creationTime: 1,
    projectId: h.project,
    contributor: 'fixture-member',
  });
  await assert.rejects(m.client.read(), code('SECRETS_ROSTER_REFUSED'));
  // Changing the last value the removed device could open empties the list.
  await o.client.write('OTHER_TOKEN', ROTATED);
  const after = await o.client.read();
  try {
    assert.deepEqual(rotateList(after.pin.roster, after.pin.head), []);
  } finally {
    clear(after);
  }
});

test('removing a direct grant does not mark a person who still writes through a linked team', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const m = await joined(h, t, o, 'fixture-member');
  for (const table of ['teams', 'teamMembers', 'projectTeams']) h.s.tables[table] ??= new Map();
  h.s.tables.hostedProjects.get(h.project).teamLinks = 1;
  h.s.tables.teams.set('crew', { _id: 'crew', owner: 'fixture-owner', name: 'crew' });
  h.s.tables.teamMembers.set('crew-m', {
    _id: 'crew-m',
    teamId: 'crew',
    member: 'fixture-member',
    handle: null,
  });
  h.s.tables.projectTeams.set('crew-link', {
    _id: 'crew-link',
    projectId: h.project,
    teamId: 'crew',
    role: 'write',
  });
  await removePerson(h, 'fixture-member');
  assert.deepEqual(marks(h), []);
  clear(await m.client.read());
  // A team that gives read only does not keep the entry.
  h.s.tables.projectTeams.get('crew-link').role = 'read';
  h.s.tables.projectContributors.set('pc-again', {
    _id: 'pc-again',
    _creationTime: 1,
    projectId: h.project,
    contributor: 'fixture-member',
  });
  await removePerson(h, 'fixture-member');
  assert.deepEqual(marks(h), [m.keys.id.toString('hex')]);
});

test('unshare --marked removes every marked entry in one write, and automatic sharing waits until it has', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const a = await joined(h, t, o, 'fixture-a'),
    b = await joined(h, t, o, 'fixture-b');
  await removePerson(h, 'fixture-a');
  await removePerson(h, 'fixture-b');
  // A newcomer's request waits while removals are pending: the holder's read shares nobody.
  const c = device(h, t, 'fixture-c');
  await assert.rejects(c.client.read(), code('SECRETS_WAITING'));
  clear(await o.client.read());
  await assert.rejects(c.client.read(), code('SECRETS_WAITING'));
  await assert.rejects(removeMarked(o.make({ agent: true })), code('PERSON_REQUIRED'));
  const calls = h.calls.length;
  const done = await removeMarked(o.client);
  assert.deepEqual(
    h.calls.slice(calls).map(x => x.action),
    ['read', 'write'],
  );
  assert.deepEqual(done.removed.sort(), [deviceFingerprint(a.keys.id), deviceFingerprint(b.keys.id)].sort());
  assert.deepEqual(done.rotate, ['API_TOKEN']);
  // A repeat after an unknown outcome removes nothing. Its read is the holder's next run, which now shares the
  // newcomer: the removals are done.
  assert.deepEqual(await removeMarked(o.client), { removed: [], rotate: [] });
  const read = await c.client.read();
  try {
    assert(read.secrets.some(s => s.name === 'API_TOKEN' && s.value.equals(VALUE)));
  } finally {
    clear(read);
  }
});

test('Gate B2 L5: a removal drops former signers nothing needs, keeps the device just removed, and a reader with an older pin accepts the step', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const a = await joined(h, t, o, 'fixture-a'),
    b = await joined(h, t, o, 'fixture-b');
  await removePerson(h, 'fixture-a');
  await removeMarked(o.client);
  const read = async () => {
    const state = await o.client.read();
    try {
      return {
        former: state.pin.roster.former.map(e => e.deviceId.toString('hex')),
        rotate: rotateList(state.pin.roster, state.pin.head),
        reply: state.reply,
      };
    } finally {
      clear(state);
    }
  };
  // The removed device could still open API_TOKEN, so the rotate list needs it: it stays a former signer.
  assert.deepEqual((await read()).former, [a.keys.id.toString('hex')]);
  // The value changes after its removal: nothing needs the old entry any more.
  await o.client.write('API_TOKEN', ROTATED);
  const older = await o.client.pins.load(h.project, 1); // a reader whose pin still lists the old former signer
  await removePerson(h, 'fixture-b');
  await removeMarked(o.client);
  const after = await read();
  // The old entry is dropped; the device removed in this step stays (a retry after an unknown outcome finds it).
  assert.deepEqual(after.former, [b.keys.id.toString('hex')]);
  assert.deepEqual(after.rotate, [{ name: 'API_TOKEN', devices: [deviceFingerprint(b.keys.id)] }]);
  // Every reader walks the dropping step: the one with the older pin and a fresh read from the owner's own pin.
  clear(verifySealedReply(after.reply, older.pin, o.client.request()));
});

test('Gate B2 L5 a former signer a head record names, or a live value still needs, is never dropped', () => {
  const id = n => Buffer.alloc(16, n),
    former = (n, lastEpoch) => ({ deviceId: id(n), signPub: Buffer.alloc(32, n), lastEpoch }),
    roster = { former: [former(1, 1), former(2, 1), former(3, 5)] },
    // id(1) authored a name whose value was changed after its removal; id(3)'s epoch still covers API_TOKEN.
    head = {
      names: [
        { kind: 1, name: 'OLD', changedBy: id(1), valueEpoch: 3 },
        { kind: 1, name: 'API_TOKEN', changedBy: id(9), valueEpoch: 5 },
        { kind: 3, name: 'GONE', changedBy: id(2), valueEpoch: 1 },
      ],
    };
  // id(1) is named (kept), id(2) authored only a deleted name (a head record still names it: kept), id(3) covers a value.
  assert.deepEqual(droppableFormers(roster, head), []);
  head.names.splice(2, 1); // the deleted-name record goes
  assert.deepEqual(droppableFormers(roster, head), [id(2)]);
});

test('Gate B2 L7 a device whose pin is trust on first use does not write or remove as an owner', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  await joined(h, t, o, 'fixture-m');
  await removePerson(h, 'fixture-m');
  const tofuOwner = () => {
    const client = o.make(),
      read = client.read.bind(client);
    client.read = async (...args) => {
      const state = await read(...args);
      if (state) state.pin = { ...state.pin, confirmed: 'tofu' };
      return state;
    };
    return client;
  };
  const before = set(h).headHash;
  await assert.rejects(tofuOwner().write('OTHER_TOKEN', OTHER), code('SECRETS_CODE_NEEDED'));
  await assert.rejects(removeMarked(tofuOwner()), code('SECRETS_CODE_NEEDED'));
  assert.deepEqual(set(h).headHash, before, 'nothing was written');
  // The same owner on its own confirmed pin still writes and removes.
  await o.client.write('OTHER_TOKEN', OTHER);
  assert.equal(set(h).revoked, undefined, 'the confirmed owner removed the marked device first');
});

test('a marker that names no entry asks for nothing; a marked device can neither read nor remove itself', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  set(h).revoked = [Uint8Array.from(randomBytes(16)).buffer];
  o.notices.length = 0;
  await o.client.write('NEXT_TOKEN', OTHER);
  assert(!o.notices.some(line => line.includes('Forge asks to remove')));
  set(h).revoked = [Uint8Array.from(o.client.keys.id).buffer];
  const head = set(h).headHash;
  await assert.rejects(o.client.write('LAST_TOKEN', VALUE), code('SECRETS_ROSTER_REFUSED'));
  await assert.rejects(removeMarked(o.client), code('SECRETS_ROSTER_REFUSED'));
  assert.deepEqual(set(h).headHash, head);
});

test('server markers: only the leaving account is marked, once, and its waiting join request goes', async t => {
  const h = setup(t),
    o = owner(h);
  await o.client.write('API_TOKEN', VALUE);
  const kept = await joined(h, t, o, 'fixture-kept');
  const leaving = device(h, t, 'fixture-leaving');
  await assert.rejects(leaving.client.read(), code('SECRETS_WAITING'));
  assert.equal(set(h).joinRequests.length, 1);
  // A person with no entry: nothing to mark, but their waiting request is dropped.
  await removePerson(h, 'fixture-leaving');
  assert.equal(set(h).revoked, undefined);
  assert.equal(set(h).joinRequests, undefined);
  // Marking is idempotent and never touches another account's entry.
  const row = { ...set(h), revoked: [Uint8Array.from(kept.keys.id).buffer] };
  assert.equal(gate.markersForRemovedAccount(row, forgeSecretId('account', 'fixture-kept')), null);
  assert.equal(gate.markersForRemovedAccount(row, forgeSecretId('account', 'fixture-nobody')), null);
  const owned = gate.markersForRemovedAccount(set(h), forgeSecretId('account', h.account));
  assert.deepEqual(
    owned.revoked.map(id => Buffer.from(id).toString('hex')),
    [o.client.keys.id.toString('hex')],
  );
  // A malformed stored join request (no account) is kept rather than guessed at.
  const odd = { ...set(h), joinRequests: [{ deviceId: new ArrayBuffer(16), request: wire({}), at: 1 }] };
  assert.equal(
    gate.markersForRemovedAccount(odd, forgeSecretId('account', 'fixture-kept')).joinRequests.length,
    1,
  );
});
const wire = value => Uint8Array.from(encodeSealedWire(value)).buffer;

test('review 1: a share signed before the person left stores nothing, so the removal cannot be undone by it', async t => {
  const h = setup(t),
    notices = [];
  await owner(h).client.write('API_TOKEN', VALUE);
  const m = device(h, t, 'fixture-member');
  await assert.rejects(m.client.read(), code('SECRETS_WAITING'));
  // The holder reads the waiting request, then the person is removed before its share write arrives.
  let raced = false;
  const racing = {
    ...h.transport,
    write: async input => {
      if (input.transition && !raced) {
        raced = true;
        await removePerson(h, 'fixture-member');
      }
      return h.transport.write(input);
    },
  };
  const holder = new SealedClient(h.project, h.account, h.pins.store.load(), h.pins, racing, false, line =>
    notices.push(line),
  );
  const state = await holder.read();
  try {
    assert(raced, 'the holder signed and sent the share');
    assert(!state.pin.roster.entries.some(e => e.id.equals(m.keys.id)));
  } finally {
    clear(state);
  }
  assert(notices.some(line => line.includes('retries on the next run')));
  const stored = set(h);
  assert.equal(stored.joinRequests, undefined);
  assert.equal(stored.revoked, undefined);
  assert.equal(stored.rosterVersion, 1);
});

test('review 2 and Gate B2 M3: holders act on a marker of another device of their own account, never on themselves or a machine', () => {
  const id = n => Buffer.alloc(16, n),
    own = id(1),
    other = id(2);
  const entry = (n, accountId, entryKind = 1) => ({
    id: id(n),
    accountId,
    entryKind,
    role: entryKind === 2 ? 3 : 1,
  });
  const roster = {
    entries: [entry(10, own), entry(11, own), entry(12, other), entry(13, Buffer.alloc(0), 2)],
    former: [],
  };
  const revoked = [id(11), id(12), id(13)];
  const marked = markedEntries(roster, revoked, id(10));
  // Device 11 is another device of the holder's own account whose sign-in ended (a lost laptop).
  assert.deepEqual(
    marked.remove.map(e => e.id[0]),
    [11, 12],
  );
  assert.deepEqual(
    marked.ignored.map(e => e.id[0]),
    [13],
  );
  const notice = markerNotice(roster, revoked, id(10));
  assert.match(notice, /Forge asks to remove 2 Development entries/);
  assert.match(notice, /a machine, which it never should; nothing is done about it/);
  // A marker on the holder itself is never acted on (verification refuses the holder first).
  assert.deepEqual(markedEntries(roster, [id(10)], id(10)).remove, []);
});

test('cost: removing a reader reads no sealed set; removing a write member reads each kind once', async t => {
  const h = setup(t);
  await owner(h).client.write('API_TOKEN', VALUE);
  const tables = [];
  const ctx = {
    ...h.s.ctx,
    db: new Proxy(h.s.ctx.db, {
      get(target, key) {
        if (key === 'query') return table => (tables.push(table), target.query(table));
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    }),
  };
  await actorNames.retainMembership(ctx, h.project, 'fixture-reader', h.account);
  assert(!tables.includes('sealedSecretSets'));
  device(h, t, 'fixture-member');
  tables.length = 0;
  await actorNames.retainMembership(ctx, h.project, 'fixture-member', h.account);
  assert.equal(tables.filter(name => name === 'sealedSecretSets').length, 3);
});
