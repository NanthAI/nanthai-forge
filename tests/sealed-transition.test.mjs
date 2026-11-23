// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize } from 'node:v8';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTransition, appendTransition } from '../dist/sealed-transition.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { deviceKeys, personKeys } from '../dist/sealed-keys.js';
import { framedHash } from '../dist/sealed-format.js';
import { rosterBytes } from '../dist/sealed-records.js';
import { FileKeyStore } from '../dist/sealed-local.js';
import { SecretPins } from '../dist/sealed-pins.js';
import { fixture } from './helpers/sealed-fixture.mjs';

const clone = value => deserialize(serialize(value));
const delta = changes => ({
  added: [],
  removed: [],
  roles: [],
  droppedFormer: [],
  newSharingMode: null,
  newChecksPointer: null,
  supersede: null,
  epochBumped: 0,
  ...changes,
});
const clear = result => {
  result.key?.fill(0);
  for (const secret of result.secrets) secret.value.fill(0);
};

function advance(f, changes = {}, signer = f.keys) {
  const built = createTransition(f.reply.roster, delta(changes), signer);
  f.bump();
  f.reply.roster = built.roster;
  f.reply.transitions = appendTransition(f.reply.transitions, built.transition);
  Object.assign(f.reply.head, {
    rosterVersion: built.roster.rosterVersion,
    rosterHash: built.transition.toHash,
    epoch: built.roster.epoch,
  });
  f.signHead();
  return built;
}

test('T25 canonical transition construction and the 64-step ring reach a lagging pin and refuse genesis beyond the ring', () => {
  const f = fixture(),
    original = clone(f.reply.genesis);
  for (let i = 0; i < 6; i++) advance(f, { newSharingMode: i % 2 ? 2 : 1 });
  const initial = verifySealedReply(f.reply, null, f.request),
    pin = initial.pin;
  clear(initial);
  for (let i = 0; i < 64; i++) advance(f, { newSharingMode: i % 2 ? 2 : 1 });
  assert.equal(f.reply.transitions.length, 64);
  assert.equal(f.reply.transitions[0].fromVersion, 7);
  clear(verifySealedReply(f.reply, pin, f.request));
  assert.throws(() => verifySealedReply(f.reply, null, f.request), { code: 'SECRETS_PIN_TOO_OLD' });
  assert.deepEqual(f.reply.genesis, original);
  f.reply.transitions.splice(15, 1);
  assert.throws(() => verifySealedReply(f.reply, pin, f.request), { code: 'SECRETS_PIN_TOO_OLD' });
});

test('a constructed signed transition does not mutate the pinned roster, caller delta or prior ring', () => {
  const f = fixture(),
    from = clone(f.reply.roster),
    d = delta({ newSharingMode: 1 }),
    before = clone(d);
  const built = createTransition(f.reply.roster, d, f.keys),
    prior = [];
  const ring = appendTransition(prior, built.transition);
  assert.deepEqual(f.reply.roster, from);
  assert.deepEqual(d, before);
  assert.equal(prior.length, 0);
  assert.equal(ring.length, 1);
  assert.deepEqual(built.roster.prevRosterHash, framedHash(rosterBytes(from)));
  const fork = { ...built.transition, fromVersion: built.transition.toVersion, fromHash: Buffer.alloc(32) };
  assert.throws(() => appendTransition(ring, fork), { code: 'SECRETS_FORK' });
});

test('transition writers refuse the last owner and preserve reader authority rules for member and revoked signers', () => {
  const f = fixture(),
    member = deviceKeys(f.account, f.random);
  assert.throws(
    () => createTransition(f.reply.roster, delta({ removed: [f.keys.id], epochBumped: 1 }), f.keys),
    { code: 'SECRETS_LAST_OWNER' },
  );
  advance(f, { added: [f.entry(member, { role: 2, how: 4, addedAtRosterVersion: 2 })] });
  for (const changes of [
    { roles: [{ id: member.id, role: 1 }] },
    { removed: [f.keys.id], epochBumped: 1 },
    { newSharingMode: 1 },
  ])
    assert.throws(() => createTransition(f.reply.roster, delta(changes), member), {
      code: 'SECRETS_ROSTER_REFUSED',
    });
  assert.throws(() => createTransition(f.reply.roster, delta({}), f.keys, { revoked: [f.keys.id] }), {
    code: 'SECRETS_ROSTER_REFUSED',
  });
});

test('removal construction derives former signers and requires a raised epoch without giving them authority', () => {
  const f = fixture(),
    member = deviceKeys(f.account, f.random);
  advance(f, { added: [f.entry(member, { role: 2, how: 4, addedAtRosterVersion: 2 })] });
  assert.throws(() => createTransition(f.reply.roster, delta({ removed: [member.id] }), f.keys), {
    code: 'SECRETS_ROSTER_REFUSED',
  });
  const { roster } = advance(f, { removed: [member.id], epochBumped: 1 });
  assert.deepEqual(roster.former, [{ deviceId: member.id, signPub: member.signPub, lastEpoch: 1 }]);
  assert.equal(roster.epoch, 2);
  assert.throws(() => createTransition(roster, delta({}), member), { code: 'SECRETS_ROSTER_REFUSED' });
});

test('person transition construction can add its own member device but cannot raise it to owner', () => {
  const f = fixture(),
    person = personKeys(f.random(32), f.account),
    member = deviceKeys(f.account, f.random);
  advance(f, {
    added: [
      f.entry(person, { entryKind: 3, role: 4, how: 4, addedAtRosterVersion: 2, bindSig: Buffer.alloc(0) }),
    ],
  });
  const entry = f.entry(member, { role: 2, how: 5, addedBy: person.id, addedAtRosterVersion: 3 });
  const { roster } = createTransition(f.reply.roster, delta({ added: [entry] }), person);
  assert.equal(roster.entries.find(e => e.id.equals(member.id)).role, 2);
  assert.throws(() => createTransition(f.reply.roster, delta({ added: [{ ...entry, role: 1 }] }), person), {
    code: 'SECRETS_ROSTER_REFUSED',
  });
});

test('shared roster reconstruction matches the independent fixture across removal and re-addition', () => {
  const f = fixture(),
    member = deviceKeys(f.account, f.random);
  const compare = changes => {
    const from = clone(f.reply.roster),
      d = delta(changes),
      expected = f.transition(d);
    const actual = createTransition(from, d, f.keys);
    assert.deepEqual(actual.roster, f.reply.roster);
    assert.deepEqual(actual.transition, expected);
  };
  compare({ added: [f.entry(member, { role: 2, how: 4, addedAtRosterVersion: 2 })] });
  compare({ roles: [{ id: member.id, role: 1 }] });
  compare({ removed: [member.id], epochBumped: 1 });
  compare({
    added: [f.entry(member, { role: 2, how: 4, addedAtRosterVersion: 5 })],
    droppedFormer: [member.id],
  });
});

function twoOwners() {
  const f = fixture(),
    second = deviceKeys(f.account, f.random);
  advance(f, { added: [f.entry(second, { role: 1, how: 4, addedAtRosterVersion: 2 })] });
  return { f, second };
}

test('GB-08 d3 the transition writer refuses removing or lowering its own signer', () => {
  const { f } = twoOwners();
  for (const changes of [{ removed: [f.keys.id], epochBumped: 1 }, { roles: [{ id: f.keys.id, role: 2 }] }])
    assert.throws(
      () => createTransition(f.reply.roster, delta(changes), f.keys),
      error =>
        error.code === 'SECRETS_ROSTER_REFUSED' &&
        error.message === 'A transition cannot remove or lower its own signer.',
    );
});

test('GB-08 d3 a reader refuses a served self-removal step even when another owner signs the head', () => {
  const { f, second } = twoOwners();
  const pin = verifySealedReply(f.reply, null, f.request);
  clear(pin);
  f.bump();
  f.transition({ removed: [f.keys.id], epochBumped: 1 });
  f.signHead(second);
  assert.throws(
    () => verifySealedReply(f.reply, pin.pin, { ...f.request, recipient: undefined }),
    error =>
      error.code === 'SECRETS_ROSTER_REFUSED' &&
      error.message === 'A transition cannot remove or lower its own signer.',
  );
});

test('a retried construction is byte-identical, and a lost compare-and-swap must rebuild on the new roster', () => {
  const f = fixture(),
    member = deviceKeys(f.account, f.random),
    from = clone(f.reply.roster),
    d = delta({ added: [f.entry(member, { role: 2, how: 4, addedAtRosterVersion: 2 })] });
  // An unknown outcome is retried with the same bytes, so the server's operation id reconciles.
  const first = createTransition(from, d, f.keys),
    retry = createTransition(from, d, f.keys);
  assert.deepEqual(retry.transition, first.transition);
  // A competing step wins the compare-and-swap first; the stale transition no longer extends the ring.
  const ring = appendTransition([], createTransition(from, delta({ newSharingMode: 1 }), f.keys).transition);
  assert.throws(() => appendTransition(ring, first.transition), { code: 'SECRETS_FORK' });
  const won = createTransition(from, delta({ newSharingMode: 1 }), f.keys).roster,
    rebuilt = createTransition(
      won,
      delta({ added: [f.entry(member, { role: 2, how: 4, addedAtRosterVersion: 3 })] }),
      f.keys,
    );
  assert.equal(appendTransition(ring, rebuilt.transition).length, 2);
});

test('a pin outside the 64-step ring is refused with the holder route and its pin bytes unchanged', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-ring-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(),
    store = new FileKeyStore(join(directory, 'device.bin'));
  store.save({ ...f.keys, pinCounter: 0 });
  const pins = new SecretPins(directory, store);
  clear(await pins.verifyAndSave(f.reply, f.request, 1));
  const files = () =>
    Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
  const before = files();
  for (let i = 0; i < 65; i++) advance(f, { newSharingMode: i % 2 ? 2 : 1 });
  await assert.rejects(pins.verifyAndSave(f.reply, f.request, 2), {
    code: 'SECRETS_PIN_TOO_OLD',
    message: 'Secret roster is beyond the retained history. Confirm with a holder.',
  });
  assert.deepEqual(files(), before);
  // A healthy pin is never sent to repin as a workaround.
  await assert.rejects(
    pins.rebuild(f.reply, f.request, true, async () => true),
    {
      code: 'SECRETS_NOT_ALLOWED',
    },
  );
  assert.deepEqual(files(), before);
});

test('a Checks transition writer needs trusted Development so it cannot publish an ineligible final owner', () => {
  const f = fixture(17, 'fixture-project', 2);
  assert.throws(() => createTransition(f.reply.roster, delta({ newSharingMode: 2 }), f.keys), {
    code: 'SECRETS_ROSTER_REFUSED',
    message: 'A Checks or Production transition needs the trusted Development roster.',
  });
  const built = createTransition(f.reply.roster, delta({ newSharingMode: 2 }), f.keys, {
    development: f.request.development.roster,
  });
  assert.equal(built.roster.rosterVersion, 2);
});
