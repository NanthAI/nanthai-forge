// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Gate B1 C20 (the server runs the public part of the reader's verifier before it stores a head), C23 (entry
// crypto only for the entries a step adds) and the C25 cases that need no member writes. Every refused write
// leaves the stored records byte-for-byte unchanged. Synthetic keys and values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import { clone, server, setup } from './helpers/sealed-hosted.mjs';
import { forgeSecretId } from '../dist/sealed-format.js';
import * as portable from '../dist/sealed-portable.js';
import { deviceKeys } from '../dist/sealed-keys.js';
import { sealedAccount } from '../dist/sealed-identity.js';
import { sealedRead, sealedWrite, sealedWriteArgs } from '../dist/sealed-transport.js';
import { verifySealedReply } from '../dist/sealed-verify.js';

const code = expected => error => (error.code ?? error.data?.code) === expected;
function harness(t) {
  const h = setup(t);
  h.base = null;
  h.publish = async () => {
    const wire = sealedWrite(h.f.reply, randomUUID(), h.base),
      args = { ...sealedWriteArgs(wire), kind: 1, projectId: h.project };
    const result = await h.s.transaction(() => server.write._handler(h.s.ctx, args));
    if (result.accepted)
      h.base = { headHash: Buffer.from(wire.headHash), rosterVersion: h.f.reply.roster.rosterVersion };
    return result;
  };
  h.rows = () =>
    serialize({
      sets: [...h.s.tables.sealedSecretSets.values()],
      history: [...h.s.tables.sealedSecretHistory.values()],
    });
  h.set = () => [...h.s.tables.sealedSecretSets.values()][0];
  /** The reply as published, so each case changes one thing on a fresh copy. */
  h.snapshot = () => clone(h.f.reply);
  h.restore = reply => {
    for (const key of Object.keys(h.f.reply)) delete h.f.reply[key];
    Object.assign(h.f.reply, clone(reply));
  };
  return h;
}
/** Owner genesis with one value, then a step that shares Development with a member account's device. */
async function withMember(t) {
  const h = harness(t),
    f = h.f;
  f.name();
  assert.equal((await h.publish()).accepted, true);
  const memberAccount = forgeSecretId('account', 'fixture-member');
  h.member = deviceKeys(memberAccount, f.random);
  f.bump();
  f.transition({
    added: [f.entry(h.member, { accountId: memberAccount, role: 2, how: 2, addedAtRosterVersion: 2 })],
  });
  f.wrap();
  assert.equal((await h.publish()).accepted, true);
  return h;
}
async function refused(h, expected, change) {
  const before = h.rows(),
    reply = h.snapshot();
  change();
  await assert.rejects(h.publish(), code(expected));
  assert.deepEqual(h.rows(), before, 'a refused write changes no stored record');
  h.restore(reply);
}

test('C20 a head signed by a device of another account is refused, even a valid writer of the set', async t => {
  const h = await withMember(t),
    f = h.f;
  // The member device may write Development, but this sign-in is the owner's: the signer must be its own device.
  await refused(h, 'SECRETS_ROSTER_REFUSED', () => {
    f.bump();
    f.name('MEMBER_TOKEN', Buffer.from('member-synthetic-value'), {
      changedBy: h.member.id,
      signer: h.member,
    });
    f.signHead(h.member);
  });
});

test('C20 the server walks each step with the reader rules: a member-signed owner-only shape is refused', async t => {
  const h = await withMember(t),
    f = h.f;
  await refused(h, 'SECRETS_ROSTER_REFUSED', () => {
    f.bump();
    f.transition({ newSharingMode: 1 }, h.member);
    f.wrap();
  });
  // The same step signed by the owner device is accepted.
  f.bump();
  f.transition({ newSharingMode: 1 });
  f.wrap();
  assert.equal((await h.publish()).accepted, true);
});

test('C20 C23 a step adding an entry whose device binding does not verify is refused', async t => {
  const h = harness(t),
    f = h.f;
  f.name();
  await h.publish();
  const stranger = deviceKeys(forgeSecretId('account', 'fixture-member'), f.random),
    other = deviceKeys(f.account, f.random);
  await refused(h, 'SECRETS_ROSTER_REFUSED', () => {
    f.bump();
    // A binding signed for another device: its keys never bound themselves to this account.
    f.transition({
      added: [f.entry(stranger, { role: 2, how: 4, addedAtRosterVersion: 2, bindSig: other.bindSig })],
    });
    f.wrap();
  });
});

test('C20 a head that breaks the adjacent-head rules every pinned holder checks is refused', async t => {
  const h = harness(t),
    f = h.f;
  f.name();
  f.name('SECOND_TOKEN');
  await h.publish();
  // A live name dropped without its tombstone.
  await refused(h, 'SECRETS_ROLLBACK', () => {
    f.bump();
    f.reply.head.names = f.reply.head.names.filter(n => n.name !== 'SECOND_TOKEN');
    f.reply.ciphertexts = f.reply.ciphertexts.filter(c => c.name !== 'SECOND_TOKEN');
    f.signHead();
  });
  // A value record changed at the same version.
  await refused(h, 'SECRETS_ROSTER_REFUSED', () => {
    f.bump();
    f.reply.head.names.find(n => n.name === 'API_TOKEN').changedAt += 1;
    f.signHead();
  });
  // A marked device writes nothing new.
  h.set().revoked = [Uint8Array.from(f.keys.id).buffer];
  await refused(h, 'SECRETS_ROSTER_REFUSED', () => {
    f.bump();
    f.name('NEXT_TOKEN');
  });
});

test('C20 ciphertexts and wraps must match the signed head: a mismatched, missing or extra one is refused', async t => {
  const h = harness(t),
    f = h.f;
  f.name();
  await h.publish();
  const stranger = deviceKeys(forgeSecretId('account', 'fixture-member'), f.random);
  for (const [expected, change] of [
    [
      'SECRETS_VALUE_REFUSED',
      () => {
        const c = f.reply.ciphertexts.find(c => c.name === 'NEXT_TOKEN');
        c.stored = Buffer.from(c.stored);
        c.stored[c.stored.length - 1] ^= 1;
      },
    ],
    [
      'SECRETS_VALUE_REFUSED',
      () => (f.reply.ciphertexts = f.reply.ciphertexts.filter(c => c.name !== 'NEXT_TOKEN')),
    ],
    [
      'SECRETS_VALUE_REFUSED',
      () => f.reply.ciphertexts.push({ name: 'NOT_SIGNED', stored: f.reply.ciphertexts[0].stored }),
    ],
    ['SECRETS_WRAP_REFUSED', () => f.reply.wraps.push({ ...f.reply.wraps[0], recipientId: stranger.id })],
    ['SECRETS_WRAP_REFUSED', () => f.reply.wraps.push(f.reply.wraps[0])],
  ])
    await refused(h, expected, () => {
      f.bump();
      f.name('NEXT_TOKEN');
      change();
    });
  f.bump();
  f.name('NEXT_TOKEN');
  assert.equal((await h.publish()).accepted, true);
});

test('C25 a head that passes the server subset but fails a client-only rule is refused by every reader', async t => {
  const h = harness(t),
    f = h.f;
  f.name();
  await h.publish();
  const pin = verifySealedReply(sealedRead(await h.transport.read({ kind: 1 })), null, f.request).pin;
  // The key commitment needs the set key, which the server never holds: it stores this head, a holder refuses it.
  f.bump();
  f.name('NEXT_TOKEN');
  f.reply.head.commit = Buffer.alloc(32, 7);
  f.signHead();
  assert.equal((await h.publish()).accepted, true);
  const served = sealedRead(await h.transport.read({ kind: 1 }));
  assert.throws(
    () => verifySealedReply(served, pin, { ...f.request, firstContact: false, anchor: undefined }),
    code('SECRETS_VALUE_REFUSED'),
  );
});

test('C20 the CLI and the server derive the same sealed account id from one sign-in', () => {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const subject = 'k57synthetic0subject0id0000000000|synthetic-session';
  const token = [
    part({ alg: 'RS256' }),
    part({ sub: subject, forgeCredential: 'synthetic-credential', forgeSignIn: 'synthetic-sign-in' }),
    'synthetic-signature',
  ].join('.');
  // Known answer: the CLI reads `sub` from its token; the server reads `subject` from the verified identity.
  const expected = 'b0eb54fe61d8adc5a4819846eef41a59';
  assert.equal(forgeSecretId('account', sealedAccount(token)).toString('hex'), expected);
  assert.equal(Buffer.from(portable.forgeSecretId('account', subject)).toString('hex'), expected);
});
