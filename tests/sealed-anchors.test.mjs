// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { forgeSecretId, framedHash } from '../dist/sealed-format.js';
import { deviceKeys, personKeys, signBytes } from '../dist/sealed-keys.js';
import { rosterBytes } from '../dist/sealed-records.js';
import { checkpointBytes } from '../dist/sealed-future-records.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { FileKeyStore } from '../dist/sealed-local.js';
import { SecretPins } from '../dist/sealed-pins.js';
import { fixture } from './helpers/sealed-fixture.mjs';

const clone = value => deserialize(serialize(value));
const clear = result => {
  result.key?.fill(0);
  for (const secret of result.secrets) secret.value.fill(0);
};
const recipient = keys => ({ id: keys.id, enc: keys.enc, kind: 1 });

test('F1 an unanchored joined Development device is refused even with a complete served roster', () => {
  const f = fixture(),
    accountId = forgeSecretId('account', 'joining-member'),
    member = deviceKeys(accountId, f.random);
  f.transition({ added: [f.entry(member, { accountId, role: 2, how: 2, addedAtRosterVersion: 2 })] });
  f.wrap();
  clear(verifySealedReply(f.reply, null, f.request));
  for (let i = 0; i < 65; i++) f.transition({});
  // A first Development contact starts at the served roster, even once genesis has left the ring.
  f.reply.transitions = [];
  assert.throws(
    () => verifySealedReply(f.reply, null, { ...f.request, anchor: undefined, recipient: recipient(member) }),
    { code: 'SECRETS_ROSTER_REFUSED' },
  );
});

test('F1 a non-genesis Checks holder walks from trusted Development and refuses a missing transition', () => {
  const f = fixture(17, 'fixture-project', 2),
    owner = deviceKeys(f.account, f.random);
  f.transition({ added: [f.entry(owner, { how: 4, addedAtRosterVersion: 2 })] });
  f.wrap();
  const request = { ...f.request, recipient: recipient(owner) };
  clear(verifySealedReply(f.reply, null, request));
  f.reply.transitions = [];
  assert.throws(() => verifySealedReply(f.reply, null, request), { code: 'SECRETS_PIN_TOO_OLD' });
});

test('F1 a joined device rebuilds only its own signed view without requiring the genesis walk', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-anchor-rebuild-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(),
    owner = deviceKeys(f.account, f.random),
    store = new FileKeyStore(join(directory, 'device.bin'));
  f.transition({ added: [f.entry(owner, { how: 4, addedAtRosterVersion: 2 })] });
  f.wrap();
  // Publish a pin through a normal already-trusted walk before losing its local file.
  store.save({ ...owner, pinCounter: 0 });
  const pins = new SecretPins(directory, store),
    request = { ...f.request, recipient: recipient(owner) };
  const initial = { ...request, anchor: undefined, recipient: undefined, machineAnchor: f.reply.genesis };
  clear(await pins.verifyAndSave(f.reply, initial, 1));
  unlinkSync(join(directory, forgeSecretId('project', request.forgeProjectId).toString('hex') + '.bin'));
  f.reply.transitions = [];
  f.signHead(owner);
  clear(await pins.rebuild(f.reply, request, true, async () => true));
  assert.equal(
    (await pins.load(request.forgeProjectId, 1)).pin.head.signerId.toString('hex'),
    owner.id.toString('hex'),
  );
  unlinkSync(join(directory, forgeSecretId('project', request.forgeProjectId).toString('hex') + '.bin'));
  const before = Object.fromEntries(
    readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]),
  );
  f.signHead();
  await assert.rejects(
    pins.rebuild(f.reply, request, true, async () => true),
    { code: 'SECRETS_PIN_LOST' },
  );
  assert.deepEqual(
    Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))])),
    before,
  );
});

function passkeyContact() {
  const f = fixture(),
    person = personKeys(f.random(32), f.account);
  f.transition({
    added: [
      f.entry(person, { entryKind: 3, role: 4, how: 4, addedAtRosterVersion: 2, bindSig: Buffer.alloc(0) }),
    ],
  });
  f.wrap();
  const roster = clone(f.reply.roster),
    rosterHash = framedHash(rosterBytes(roster)),
    at = 1234;
  const checkpoint = {
    roster,
    rosterHash,
    at,
    signature: signBytes(checkpointBytes(roster, rosterHash, at), person.sign),
  };
  const personCheckpoint = {
    checkpoint,
    person: { id: person.id, accountId: f.account, signPub: person.signPub, encPub: person.encPub },
  };
  const request = {
    ...f.request,
    recipient: { id: person.id, enc: person.enc, kind: 3 },
    anchor: { kind: 'person-checkpoint', value: personCheckpoint },
  };
  return { f, person, request };
}

test('F1/T81 a passkey contact starts at the signed checkpoint and walks forward, not at a listed person entry', () => {
  const { f, request } = passkeyContact();
  f.transition({});
  f.wrap();
  clear(verifySealedReply(f.reply, null, request));
  assert.throws(() => verifySealedReply(f.reply, null, { ...request, anchor: undefined }), {
    code: 'SECRETS_PIN_TOO_OLD',
  });
  f.reply.transitions = [];
  assert.throws(() => verifySealedReply(f.reply, null, request), { code: 'SECRETS_PIN_TOO_OLD' });
});

test('F1 a passkey adds its account device as member through the checkpoint walk', () => {
  const { f, person, request } = passkeyContact(),
    member = deviceKeys(f.account, f.random);
  f.transition(
    { added: [f.entry(member, { role: 2, how: 5, addedBy: person.id, addedAtRosterVersion: 3 })] },
    person,
  );
  f.wrap();
  const result = verifySealedReply(f.reply, null, { ...request, recipient: recipient(member) });
  assert.equal(result.pin.roster.entries.find(entry => entry.id.equals(member.id)).role, 2);
  clear(result);
});

test('multiple explicit journey anchors are refused rather than replacing a machine bundle', () => {
  const { f, request } = passkeyContact();
  f.reply.transitions = [];
  assert.throws(
    () =>
      verifySealedReply(f.reply, null, {
        ...request,
        recipient: undefined,
        machine: true,
        machineAnchor: f.reply.genesis,
      }),
    { code: 'SECRETS_ROSTER_REFUSED' },
  );
});

test('F1/T40/T81 bad, missing or mismatched checkpoint bytes never fall back to first-contact trust', () => {
  for (const tamper of [
    anchor => {
      anchor.checkpoint.signature.fill(0);
    },
    anchor => {
      anchor.checkpoint.rosterHash.fill(0);
    },
    anchor => {
      delete anchor.checkpoint.roster;
    },
    anchor => {
      anchor.checkpoint.roster.entries[1].displayName = 'other-person';
    },
    anchor => {
      anchor.person.encPub.fill(1);
    },
    anchor => {
      anchor.checkpoint.unsignedField = 'ignored-field';
    },
    anchor => {
      anchor.checkpoint.roster.unsignedField = 'ignored-field';
    },
  ]) {
    const { f, request } = passkeyContact();
    tamper(request.anchor.value);
    assert.throws(() => verifySealedReply(f.reply, null, request), { code: 'SECRETS_PIN_TOO_OLD' });
  }
});

// F1 journey integration: the pin-committing journey code takes only the journey's own anchor.
function pinStore(t, keys) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-anchor-journey-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new FileKeyStore(join(directory, 'device.bin'));
  store.save({ ...keys, pinCounter: 0 });
  const files = () =>
    Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
  return { pins: new SecretPins(directory, store), files };
}

test('F1 a joined Development member commits no pin from a served roster or a borrowed creator anchor', async t => {
  const f = fixture(),
    accountId = forgeSecretId('account', 'joining-member'),
    member = deviceKeys(accountId, f.random);
  f.transition({ added: [f.entry(member, { accountId, role: 2, how: 2, addedAtRosterVersion: 2 })] });
  f.wrap();
  const { pins, files } = pinStore(t, member),
    before = files();
  for (const anchor of [
    undefined,
    { kind: 'own-genesis', deviceId: member.id },
    { kind: 'own-genesis', deviceId: f.keys.id },
  ]) {
    await assert.rejects(
      pins.verifyAndSave(f.reply, { ...f.request, anchor, recipient: recipient(member) }, 1),
      { code: 'SECRETS_ROSTER_REFUSED' },
    );
    assert.deepEqual(files(), before);
  }
  assert.equal(await pins.load(f.request.forgeProjectId, 1), null);
});

test('F1 a non-creator Checks holder and a passkey contact each pin through their own journey anchor', async t => {
  const checks = fixture(17, 'fixture-project', 2),
    holder = deviceKeys(checks.account, checks.random);
  checks.transition({ added: [checks.entry(holder, { how: 4, addedAtRosterVersion: 2 })] });
  checks.wrap();
  const c = pinStore(t, holder);
  clear(await c.pins.verifyAndSave(checks.reply, { ...checks.request, recipient: recipient(holder) }, 1));
  assert.equal((await c.pins.load(checks.request.forgeProjectId, 2)).pin.holder, true);

  const { f, person, request } = passkeyContact(),
    p = pinStore(t, deviceKeys(f.account, f.random));
  clear(await p.pins.verifyAndSave(f.reply, request, 1));
  const pinned = (await p.pins.load(request.forgeProjectId, 1)).pin;
  assert(pinned.roster.entries.some(entry => entry.id.equals(person.id)));
});
