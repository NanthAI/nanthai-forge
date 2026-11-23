// SPDX-License-Identifier: Apache-2.0
// GB-08 d5 (Gate B1 C9-C12): a Checks roster that breaks the cross-set rule is repaired by one owner write.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize } from 'node:v8';
import { forgeSecretId } from '../dist/sealed-format.js';
import { deviceKeys, recipientId } from '../dist/sealed-keys.js';
import { repairSet } from '../dist/sealed-repair.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { fixture } from './helpers/sealed-fixture.mjs';
import { newAccountDevice } from './helpers/sealed-code-journey.mjs';
import { assertNoPlaintext, deviceSecrets } from './helpers/sealed-no-plaintext.mjs';

const clone = value => deserialize(serialize(value));
const clear = result => {
  result.key?.fill(0);
  for (const secret of result.secrets) secret.value.fill(0);
};
const recipient = keys => ({ id: keys.id, enc: keys.enc, kind: 1 });
const value = Buffer.from('synthetic-checks-value-0123');

/**
 * Development has owner devices for accounts A (the fixture owner) and B. Checks holds A, a machine A added,
 * and (unless `soleOwner`) B's device and a machine B added. Then Development demotes `demote` to member,
 * which breaks the Checks cross-set rule without any Checks write.
 */
function broken({ soleOwner = false, demote = 'B', chain = false, twin = false } = {}) {
  const checks = fixture(29, 'repair-project', 2),
    dev = fixture(29, 'repair-project', 1),
    b = newAccountDevice(dev, 'second-owner'),
    c = newAccountDevice(dev, 'third-owner');
  const owner = (d, handle, name) =>
    dev.entry(d.keys, {
      accountId: d.accountId,
      accountHandle: handle,
      displayName: name,
      how: 6,
      addedAtRosterVersion: dev.reply.roster.rosterVersion + 1,
    });
  dev.transition({ newChecksPointer: checks.request.development.roster.checksPointer });
  dev.transition({ added: [owner(b, 'second-owner', 'second-device')] });
  dev.transition({ added: [owner(c, 'third-owner', 'third-device')] });
  dev.wrap();
  const before = dev.pin();
  const machine = (name, addedBy) => {
    const m = deviceKeys(forgeSecretId('account', name), checks.random);
    m.id = recipientId(2, Buffer.alloc(0), m.encPub);
    return checks.entry(m, {
      entryKind: 2,
      role: 3,
      how: 6,
      signPub: Buffer.alloc(0),
      accountId: Buffer.alloc(0),
      accountHandle: '',
      bindSig: Buffer.alloc(0),
      displayName: name,
      addedBy,
      addedAtRosterVersion: checks.reply.roster.rosterVersion + 1,
    });
  };
  checks.transition({ added: [machine('owner-runner', checks.keys.id)] });
  if (twin) checks.transition({ added: [machine('ci-runner', checks.keys.id)] });
  if (!soleOwner) {
    checks.transition({
      added: [
        checks.entry(b.keys, {
          accountId: b.accountId,
          accountHandle: 'second-owner',
          displayName: 'second-device',
          how: 6,
          addedAtRosterVersion: checks.reply.roster.rosterVersion + 1,
        }),
      ],
    });
    checks.transition({ added: [machine('ci-runner', b.keys.id)] }, b.keys);
    // B approves its own Development device as a Checks proposer.
    checks.reply.head.proposers = [
      { deviceId: b.keys.id, accountId: b.accountId, approvedBy: b.keys.id, approvedAt: 1000 },
    ];
    if (chain) {
      // B adds an owner device of eligible account C; that device adds a machine of its own.
      checks.transition(
        {
          added: [
            checks.entry(c.keys, {
              accountId: c.accountId,
              accountHandle: 'third-owner',
              displayName: 'third-device',
              how: 6,
              addedBy: b.keys.id,
              addedAtRosterVersion: checks.reply.roster.rosterVersion + 1,
            }),
          ],
        },
        b.keys,
      );
      checks.transition({ added: [machine('deep-runner', c.keys.id)] }, c.keys);
    }
  }
  checks.wrap();
  checks.bump();
  checks.name('API_TOKEN', value);
  checks.request.development = before;
  const result = verifySealedReply(checks.reply, null, checks.request),
    pin = clone(result.pin);
  clear(result);
  dev.bump();
  const target = demote === 'B' ? b.keys.id : dev.keys.id;
  dev.transition({ roles: [{ id: target, role: 2 }] }, demote === 'B' ? dev.keys : b.keys);
  dev.wrap();
  if (demote !== 'B') dev.signHead(b.keys);
  const after = dev.pin();
  const request = { ...checks.request, firstContact: false, development: after };
  return { checks, b, c, pin, before, after, request };
}
const publish = (checks, repaired) => {
  checks.reply.transitions.push(repaired.transition);
  checks.reply.roster = repaired.roster;
  checks.reply.head = repaired.head;
  checks.reply.ciphertexts = repaired.ciphertexts;
  checks.reply.wraps = repaired.wraps;
};
const names = roster => roster.entries.map(e => e.displayName).sort();

test('d5 C9 a broken Checks roster stays refused on read; repair is the one write allowed', () => {
  const { checks, pin, request } = broken();
  assert.throws(
    () => verifySealedReply(checks.reply, pin, request),
    e => e.code === 'SECRETS_ROSTER_REFUSED' && /no Development owner device/.test(e.message),
  );
  assert.throws(
    () =>
      repairSet({
        reply: checks.reply,
        pin,
        request,
        signer: checks.keys,
        person: false,
      }),
    e => e.code === 'PERSON_REQUIRED',
  );
});

test('d5 C10 repair removes the offender and everything it added, re-keys, and every reader walks through', () => {
  const { checks, b, pin, request } = broken();
  const repaired = repairSet({
    reply: checks.reply,
    pin,
    request,
    signer: checks.keys,
    person: true,
    now: 9000,
    random: checks.random,
  });
  assert.deepEqual(
    repaired.removed.map(r => [r.displayName, r.offending]),
    [
      ['second-device', true],
      ['ci-runner', false],
    ],
  );
  assert.deepEqual(names(repaired.roster), ['fixture-device', 'owner-runner']);
  assert.equal(repaired.roster.epoch, checks.reply.roster.epoch + 1);
  // The offender's proposer approval goes with it.
  assert.deepEqual(repaired.head.proposers, []);
  assert.deepEqual(repaired.droppedProposers, [b.keys.id]);
  assert.deepEqual(repaired.writtenByRemoved, []);
  const oldWraps = checks.reply.wraps;
  publish(checks, repaired);
  // The repairer reads its old values under the new key with its old pin.
  const read = verifySealedReply(checks.reply, pin, request);
  assert.equal(read.secrets[0].value.toString(), value.toString());
  assert.equal(read.pin.head.headVersion, pin.head.headVersion + 1);
  // T18 (Gate B2 M2): the repair write holds neither value nor the old or new set key nor a device key.
  const newKey = Buffer.from(read.key);
  clear(read);
  assertNoPlaintext('repair write', repaired, {
    values: [value],
    keys: [checks.key, newKey, ...deviceSecrets(checks.keys), ...deviceSecrets(b.keys)],
  });
  // A fresh reader walks genesis -> broken roster -> repaired roster.
  const fresh = verifySealedReply(checks.reply, null, { ...request, firstContact: true });
  assert.equal(fresh.secrets[0].value.toString(), value.toString());
  clear(fresh);
  // The offender is gone, and its old wrap opens nothing current.
  assert.throws(
    () => verifySealedReply(checks.reply, pin, { ...request, recipient: recipient(b.keys) }),
    e => e.code === 'SECRETS_ROSTER_REFUSED' && /revoked or absent/.test(e.message),
  );
  assert.throws(
    () =>
      verifySealedReply({ ...checks.reply, wraps: [...checks.reply.wraps, ...oldWraps] }, pin, {
        ...request,
        recipient: recipient(b.keys),
      }),
    e => e.code === 'SECRETS_WRAP_REFUSED' || e.code === 'SECRETS_ROSTER_REFUSED',
  );
});

test('d5 C10 the person keeps an entry the offender added by naming it', () => {
  const { checks, pin, request } = broken();
  const repaired = repairSet({
    reply: checks.reply,
    pin,
    request,
    signer: checks.keys,
    keep: ['ci-runner'],
    person: true,
    random: checks.random,
  });
  assert.deepEqual(names(repaired.roster), ['ci-runner', 'fixture-device', 'owner-runner']);
  publish(checks, repaired);
  clear(verifySealedReply(checks.reply, pin, request));
});

test('d5 C11 only a Checks owner device whose account passes the rule repairs; a healthy roster has nothing to repair', () => {
  const { checks, b, pin, before, request } = broken();
  assert.throws(
    () =>
      repairSet({
        reply: checks.reply,
        pin,
        request: { ...request, recipient: recipient(b.keys) },
        signer: b.keys,
        person: true,
      }),
    e => e.code === 'SECRETS_ROSTER_REFUSED' && /Repair from a Checks owner device/.test(e.message),
  );
  assert.throws(
    () =>
      repairSet({
        reply: checks.reply,
        pin,
        request: { ...request, development: before },
        signer: checks.keys,
        person: true,
      }),
    e => e.code === 'SECRETS_NOT_ALLOWED' && /nothing to repair/.test(e.message),
  );
});

test('d5 C11 dead end: with no passing Checks owner the error names replacing the set', () => {
  const { checks, pin, request } = broken({ soleOwner: true, demote: 'A' });
  assert.throws(
    () => repairSet({ reply: checks.reply, pin, request, signer: checks.keys, person: true }),
    e => e.code === 'SECRETS_ROSTER_REFUSED' && /Replace the Checks set/.test(e.message),
  );
});

test('d5 C10 removal follows addedBy through more than one step, and refuses a signer an offender added', () => {
  const { checks, c, pin, request } = broken({ chain: true });
  const repaired = repairSet({
    reply: checks.reply,
    pin,
    request,
    signer: checks.keys,
    person: true,
    random: checks.random,
  });
  assert.deepEqual(repaired.removed.map(r => r.displayName).sort(), [
    'ci-runner',
    'deep-runner',
    'second-device',
    'third-device',
  ]);
  assert.deepEqual(names(repaired.roster), ['fixture-device', 'owner-runner']);
  // C's device passes the rule on its own account, but an offender added it: it cannot sign the repair.
  assert.throws(
    () =>
      repairSet({
        reply: checks.reply,
        pin,
        request: { ...request, recipient: recipient(c.keys) },
        signer: c.keys,
        person: true,
      }),
    e => e.code === 'SECRETS_ROSTER_REFUSED' && /An offending device added this device/.test(e.message),
  );
});

test('d5 C10 keep-by-name refuses a shared name, an unknown name and the offender itself', () => {
  const { checks, pin, request } = broken({ twin: true });
  const attempt = keep => () =>
    repairSet({ reply: checks.reply, pin, request, signer: checks.keys, keep, person: true });
  assert.throws(
    attempt(['ci-runner']),
    e => e.code === 'SECRETS_NOT_ALLOWED' && /Keep it by its id/.test(e.message),
  );
  assert.throws(
    attempt(['no-such-runner']),
    e => e.code === 'SECRETS_NOT_ALLOWED' && /No entry/.test(e.message),
  );
  assert.throws(
    attempt(['second-device']),
    e => e.code === 'SECRETS_NOT_ALLOWED' && /offending device cannot be kept/.test(e.message),
  );
  assert.throws(
    attempt(['owner-runner']),
    e => e.code === 'SECRETS_NOT_ALLOWED' && /does not remove that entry/.test(e.message),
  );
  // By id the person keeps exactly the one they mean.
  const ids = checks.reply.roster.entries.filter(e => e.displayName === 'ci-runner'),
    offenderAdded = ids.find(e => !e.addedBy.equals(checks.keys.id));
  const repaired = attempt([offenderAdded.id.toString('hex')])();
  assert.deepEqual(names(repaired.roster), ['ci-runner', 'ci-runner', 'fixture-device', 'owner-runner']);
});
