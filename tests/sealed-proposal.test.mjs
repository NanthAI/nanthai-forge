// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Signed proposals (Item 6466c6a5) and their apply under the queue-first version rule (41a0df87, lead 2a827903).
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize } from 'node:v8';
import { x25519 } from '@noble/curves/ed25519.js';
import { fixture } from './helpers/sealed-fixture.mjs';
import { assertNoPlaintext } from './helpers/sealed-no-plaintext.mjs';
import { ciphertextHash, deriveKey, forgeSecretId } from '../dist/sealed-format.js';
import { agree, deviceKeys, encrypt, signBytes } from '../dist/sealed-keys.js';
import { hex } from '../dist/sealed-portable.js';
import { proposalBytes, proposalSealBytes } from '../dist/sealed-future-records.js';
import { changeBytes } from '../dist/sealed-records.js';
import { makeRoom, openValue, packValue } from '../dist/sealed-value.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { applyProposal, openProposal, sealProposal, PROPOSAL_CIPHERTEXT } from '../dist/sealed-proposal.js';

const clone = x => deserialize(serialize(x));
const text = value => Buffer.from(value);
const memberAccount = forgeSecretId('account', 'fixture-member');
/** A Development set with the owner and one write member, whose device proposes. */
function setup(seed = 17, project = 'fixture-project', member = null) {
  const f = fixture(seed, project);
  member ??= deviceKeys(memberAccount, f.random);
  f.transition({
    added: [f.entry(member, { accountId: memberAccount, role: 2, how: 2, addedAtRosterVersion: 2 })],
  });
  f.wrap();
  return { f, member };
}
const view = (f, extra = {}) => ({
  roster: f.reply.roster,
  head: f.reply.head,
  key: f.key,
  revoked: f.reply.revoked,
  ...extra,
});
const propose = (f, member, name, value, options = {}) =>
  sealProposal({
    pin: clone(f.pin()),
    proposer: member,
    name,
    value,
    now: f.reply.head.signedAt + 1,
    random: f.random,
    ...options,
  });
/** The owner applies `proposal` in its next head and signs it; returns the result and the pin it extends. */
function applyInto(f, proposal, extra = {}) {
  const before = clone(f.pin());
  // The view is the verified head this write replaces, after the room the write makes for a new name (as the direct
  // writer does); a refusal leaves the fixture unchanged.
  const room = { ...f.reply.head, names: [...f.reply.head.names] };
  makeRoom(room, proposal.name);
  const applying = { ...view(f, extra), head: room };
  const opened = openProposal(applying, proposal);
  try {
    const out = applyProposal(applying, opened, f.keys, f.reply.head.signedAt + 1, f.random);
    f.bump();
    const name = out.record.name;
    f.reply.head.versionFloor = room.versionFloor;
    f.reply.head.names = room.names.filter(n => n.name !== name).concat(out.record);
    const kept = new Set(f.reply.head.names.map(n => n.name));
    f.reply.ciphertexts = f.reply.ciphertexts.filter(c => kept.has(c.name));
    f.reply.ciphertexts = f.reply.ciphertexts.filter(c => c.name !== name);
    if (out.stored) f.reply.ciphertexts.push({ name, stored: out.stored });
    f.signHead();
    return { out, before };
  } finally {
    opened.r.fill(0);
    opened.value.fill(0);
  }
}
const read = (f, pin, request = f.request) => {
  const result = verifySealedReply(f.reply, pin, request);
  result.key?.fill(0);
  const values = Object.fromEntries(result.secrets.map(s => [s.name, s.value.toString()]));
  for (const s of result.secrets) s.value.fill(0);
  return { values, notices: result.notices };
};
/** The proposer's r, as the applier sealed it under the set key. */
const sealedR = (f, name) => {
  const n = f.reply.head.names.find(record => record.name === name);
  const opened = openValue(
    f.key,
    { ...f.reply.roster, ...n },
    f.reply.ciphertexts.find(c => c.name === name).stored,
    n,
  );
  opened.value.fill(0);
  return opened.r;
};
/** Compaction (the client's makeRoom): a tombstone at version 7 is written and then dropped, raising the floor to 7. */
function compactToFloor7(f) {
  f.bump();
  f.name('OLDEST_TOKEN', Buffer.alloc(0), { kind: 3, valueVersion: 7 });
  f.bump();
  f.reply.head.names = f.reply.head.names.filter(n => n.name !== 'OLDEST_TOKEN');
  f.reply.head.versionFloor = 7;
  f.signHead();
}
/** A proposer that re-seals its own proposal with `plain` (a hostile proposer: its signature is genuine). */
function resealAs(f, member, p, plain) {
  const eph = f.random(32),
    ephPub = Buffer.from(x25519.getPublicKey(eph)),
    aad = proposalSealBytes(f.reply.roster, p),
    shared = agree(eph, f.reply.head.inboxPub),
    key = deriveKey(shared, Buffer.concat([ephPub, f.reply.head.inboxPub]), aad);
  const next = { ...p, ephPub, ciphertext: encrypt(key, Buffer.alloc(12), plain, aad) };
  next.ciphertextHash = ciphertextHash(p.name, next.ciphertext);
  next.signature = signBytes(proposalBytes(f.reply.roster, next), member.sign);
  return next;
}
const resign = (f, member, p) => ({
  ...p,
  signature: signBytes(proposalBytes(f.reply.roster, p), member.sign),
});

test('queue-first: a proposal overtaken by compaction applies at max(live, floor)+1 when its base is unchanged', () => {
  const { f, member } = setup();
  f.name('API_TOKEN', text('synthetic-value-one'));
  const { proposal, r } = propose(f, member, 'API_TOKEN', text('synthetic-proposed-value'));
  assert.equal(proposal.baseValueVersion, 1);
  compactToFloor7(f);
  const { out, before } = applyInto(f, proposal);
  // The signed version (2) is below the floor, so the applier adopts it as its own ordinary change at 8.
  assert.equal(out.mode, 'adopted');
  assert.equal(out.record.valueVersion, 8);
  assert.deepEqual(out.record.changedBy, f.keys.id);
  assert.equal(out.record.proposalId.length, 0);
  // The unchanged reader accepts it from the pin before the write, and from no pin at all.
  assert.equal(read(f, before).values.API_TOKEN, 'synthetic-proposed-value');
  assert.equal(read(f, null).values.API_TOKEN, 'synthetic-proposed-value');
  // The proposer recognises its value by the r it kept.
  assert.deepEqual(sealedR(f, 'API_TOKEN'), r);
});
test('queue-first: a changed base refuses as a normal conflict, never SECRETS_ROLLBACK', () => {
  const { f, member } = setup();
  f.name('API_TOKEN', text('synthetic-value-one'));
  const { proposal } = propose(f, member, 'API_TOKEN', text('synthetic-proposed-value'));
  f.bump();
  f.name('API_TOKEN', text('synthetic-direct-change'));
  compactToFloor7(f);
  assert.throws(() => applyInto(f, proposal), {
    code: 'WORK_CONFLICT',
    message: /changed after this proposal/,
  });
  // Absent then, tombstone now is a change too.
  const { proposal: add } = propose(f, member, 'NEW_TOKEN', text('synthetic-new-value'));
  f.bump();
  f.name('NEW_TOKEN', Buffer.alloc(0), { kind: 3 });
  assert.throws(() => applyInto(f, add), { code: 'WORK_CONFLICT' });
});
test('an unchanged proposal keeps the proposer record and signature, and readers name proposer and applier', () => {
  const { f, member } = setup();
  f.name('API_TOKEN', text('synthetic-value-one'));
  const { proposal, r } = propose(f, member, 'API_TOKEN', text('synthetic-proposed-value'));
  const { out, before } = applyInto(f, proposal);
  assert.equal(out.mode, 'kept');
  assert.equal(out.record.valueVersion, 2);
  assert.deepEqual(out.record.changedBy, member.id);
  assert.deepEqual(out.record.proposalId, proposal.proposalId);
  assert.deepEqual(out.record.changeSig, proposal.changeSig);
  const result = read(f, before);
  assert.equal(result.values.API_TOKEN, 'synthetic-proposed-value');
  assert(
    result.notices.some(
      line => line.includes(`proposed by ${hex(member.id)}`) && line.includes(`applied by ${hex(f.keys.id)}`),
    ),
  );
  assert.equal(read(f, null).values.API_TOKEN, 'synthetic-proposed-value');
  assert.deepEqual(sealedR(f, 'API_TOKEN'), r);
});
test('every operation and value shape round-trips, with each bucket boundary', () => {
  const { f, member } = setup();
  for (const [length, ciphertext] of [
    [0, 272],
    [220, 272],
    [221, 528],
    [4060, 4112],
    [4061, 8208],
    [65536, PROPOSAL_CIPHERTEXT.max],
  ]) {
    const value = Buffer.alloc(length, 0x61),
      { proposal } = propose(f, member, 'SIZED_TOKEN', value, { file: true });
    assert.equal(proposal.ciphertext.length, ciphertext);
    const opened = openProposal(view(f), proposal);
    assert.deepEqual(opened.value, value);
    assert.equal(opened.proposal.kind, 2);
  }
  assert.equal(PROPOSAL_CIPHERTEXT.min, 272);
  assert.throws(() => propose(f, member, 'SIZED_TOKEN', Buffer.alloc(65537)), {
    code: 'SECRETS_FORMAT_REFUSED',
  });
  // Add (absent), change, remove, then add again over the tombstone; env and file shapes.
  let p = propose(f, member, 'API_TOKEN', text('synthetic-added')).proposal;
  assert.deepEqual([p.op, p.kind, p.baseValueVersion], [1, 1, 0]);
  let pin = applyInto(f, p).before;
  assert.equal(read(f, pin).values.API_TOKEN, 'synthetic-added');
  p = propose(f, member, 'API_TOKEN', text('synthetic-changed'), { file: true }).proposal;
  assert.deepEqual([p.op, p.kind, p.baseValueVersion], [2, 2, 1]);
  pin = applyInto(f, p).before;
  assert.equal(read(f, pin).values.API_TOKEN, 'synthetic-changed');
  p = propose(f, member, 'API_TOKEN', null).proposal;
  assert.deepEqual([p.op, p.kind, p.valueCommit.length], [3, 3, 0]);
  const removed = applyInto(f, p);
  assert.equal(removed.out.stored, null);
  assert.equal(removed.out.record.kind, 3);
  assert.equal(read(f, removed.before).values.API_TOKEN, undefined);
  p = propose(f, member, 'API_TOKEN', text('synthetic-readded')).proposal;
  assert.deepEqual([p.op, p.baseValueVersion], [1, 3]);
  pin = applyInto(f, p).before;
  assert.equal(read(f, pin).values.API_TOKEN, 'synthetic-readded');
  assert.throws(() => propose(f, member, 'MISSING_TOKEN', null), { code: 'SECRETS_NOT_ALLOWED' });
});
test('an addition over a tombstone that compaction dropped under the floor is an unchanged base', () => {
  const { f, member } = setup();
  f.name('API_TOKEN', text('synthetic-value-one'));
  f.bump();
  f.name('API_TOKEN', Buffer.alloc(0), { kind: 3 });
  const { proposal, r } = propose(f, member, 'API_TOKEN', text('synthetic-readded'));
  assert.equal(proposal.baseValueVersion, 2);
  f.bump();
  f.reply.head.names = f.reply.head.names.filter(n => n.name !== 'API_TOKEN');
  f.reply.head.versionFloor = 2;
  f.signHead();
  compactToFloor7(f);
  const { out, before } = applyInto(f, proposal);
  assert.deepEqual([out.mode, out.record.valueVersion], ['adopted', 8]);
  assert.equal(read(f, before).values.API_TOKEN, 'synthetic-readded');
  assert.deepEqual(sealedR(f, 'API_TOKEN'), r);
});
test('a proposal is bound to its project, set and epoch', () => {
  const { f, member } = setup();
  const { proposal } = propose(f, member, 'API_TOKEN', text('synthetic-proposed-value'));
  for (const other of [setup(17, 'other-project', member).f, setup(29, 'fixture-project', member).f])
    assert.throws(() => openProposal(view(other), proposal), { code: 'SECRETS_VALUE_REFUSED' });
  f.rekey();
  assert.throws(() => openProposal(view(f), proposal), { code: 'WORK_CONFLICT', message: /re-keyed/ });
});
test('only an authorized, unmarked author on the roster proposes, with its own signature', () => {
  const { f, member } = setup();
  const stranger = deviceKeys(memberAccount, f.random);
  assert.throws(() => propose(f, stranger, 'API_TOKEN', text('synthetic-value')), {
    code: 'SECRETS_NOT_ALLOWED',
  });
  const { proposal } = propose(f, member, 'API_TOKEN', text('synthetic-value'));
  // Forged: the member's id, another key's signature.
  assert.throws(() => openProposal(view(f), resign(f, stranger, proposal)), {
    code: 'SECRETS_VALUE_REFUSED',
  });
  assert.throws(() => openProposal(view(f, { revoked: [member.id] }), proposal), {
    code: 'SECRETS_NOT_ALLOWED',
    message: /marked/,
  });
  // Review M1: a device that trusted Development on first use proposes nothing, like a direct write.
  assert.throws(
    () =>
      propose(f, member, 'API_TOKEN', text('synthetic-value'), {
        pin: { ...clone(f.pin()), confirmed: 'tofu' },
      }),
    {
      code: 'SECRETS_CODE_NEEDED',
    },
  );
  // A device that may not write does not apply, and a proposer marked after opening is refused at apply.
  const opened = openProposal(view(f), proposal);
  assert.throws(() => applyProposal(view(f), opened, stranger, 1), { code: 'SECRETS_NOT_ALLOWED' });
  assert.throws(() => applyProposal(view(f, { revoked: [member.id] }), opened, f.keys, 1), {
    code: 'SECRETS_NOT_ALLOWED',
    message: /marked/,
  });
  assert.throws(() => propose(f, member, 'GITHUB_TOKEN\n', text('synthetic-value')), {
    code: 'SECRETS_NOT_ALLOWED',
  });
});
test('tampered context, digest, tag, commitment, padding and raw extras are named refusals', () => {
  const { f, member } = setup();
  f.name('API_TOKEN', text('synthetic-value-one'));
  const { proposal } = propose(f, member, 'API_TOKEN', text('synthetic-proposed-value'));
  const refuses = (p, code) => assert.throws(() => openProposal(view(f), p), { code });
  // The server or a relay changes a signed field: the proposer's signature no longer matches.
  refuses({ ...proposal, baseValueVersion: 0 }, 'SECRETS_VALUE_REFUSED');
  refuses({ ...proposal, name: 'OTHER_TOKEN' }, 'SECRETS_VALUE_REFUSED');
  refuses({ ...proposal, ciphertextHash: Buffer.alloc(32, 1) }, 'SECRETS_VALUE_REFUSED');
  const flipped = Buffer.from(proposal.ciphertext);
  flipped[flipped.length - 1] ^= 1;
  refuses({ ...proposal, ciphertext: flipped }, 'SECRETS_VALUE_REFUSED');
  // A hostile proposer signs its own tampering: the context binding, the tag and the padding still refuse.
  refuses(resign(f, member, { ...proposal, op: 1 }), 'SECRETS_VALUE_REFUSED');
  const tag = { ...proposal, ciphertext: flipped, ciphertextHash: ciphertextHash(proposal.name, flipped) };
  refuses(resign(f, member, tag), 'SECRETS_VALUE_REFUSED');
  const padded = packValue(text('synthetic-proposed-value'), Buffer.alloc(32, 2));
  padded[padded.length - 1] = 1;
  refuses(resealAs(f, member, proposal, padded), 'SECRETS_VALUE_REFUSED');
  refuses(
    resign(f, member, { ...proposal, op: 3, kind: 3, valueCommit: Buffer.alloc(0) }),
    'SECRETS_VALUE_REFUSED',
  );
  refuses({ ...proposal, extra: 1 }, 'SECRETS_FORMAT_REFUSED');
  refuses({ ...proposal, ciphertext: Buffer.alloc(271) }, 'SECRETS_FORMAT_REFUSED');
  // A commitment that does not match the value, under a change signature that is valid for this version.
  const bad = { ...proposal, valueCommit: Buffer.alloc(32, 3) };
  bad.changeSig = signBytes(
    changeBytes(f.reply.head, {
      name: bad.name,
      kind: bad.kind,
      valueVersion: 2,
      valueEpoch: bad.epoch,
      changedAt: bad.proposedAt,
      proposalId: bad.proposalId,
      valueCommit: bad.valueCommit,
      changedBy: member.id,
    }),
    member.sign,
  );
  const opened = openProposal(view(f), resign(f, member, bad));
  assert.throws(() => applyProposal(view(f), opened, f.keys, 1), {
    code: 'SECRETS_VALUE_REFUSED',
    message: /commitment/,
  });
});
test('T18: a proposal carries no plaintext, no unkeyed value hash and no key', () => {
  const { f, member } = setup();
  const value = text('synthetic-t18-proposal-value');
  const { proposal } = propose(f, member, 'API_TOKEN', value);
  assertNoPlaintext('proposal', proposal, {
    values: [value],
    keys: [f.key, member.sign, member.enc, f.keys.sign, f.keys.enc],
  });
});
test('Checks: only an approved proposer on a confirmed view proposes; a stale proposal needs a new one', () => {
  const f = fixture(23, 'fixture-project', 2),
    member = deviceKeys(memberAccount, f.random);
  f.name('API_TOKEN', text('synthetic-checks-value'));
  f.dev.transition({
    added: [f.dev.entry(member, { accountId: memberAccount, role: 2, how: 2, addedAtRosterVersion: 3 })],
  });
  f.dev.wrap();
  f.request.development = f.dev.pin();
  const development = f.request.development.roster,
    extra = { development, developmentRevoked: [] };
  const checksPin = { ...clone(f.pin()), confirmed: 'code' };
  const proposeChecks = (pin = checksPin) =>
    sealProposal({
      pin,
      proposer: member,
      development,
      name: 'API_TOKEN',
      value: text('synthetic-proposed-checks'),
      now: 5000,
      random: f.random,
    });
  assert.throws(() => proposeChecks(), { code: 'SECRETS_NOT_ALLOWED', message: /approved Checks proposer/ });
  f.bump();
  f.reply.head.proposers = [
    { deviceId: member.id, accountId: memberAccount, approvedBy: f.keys.id, approvedAt: 1 },
  ];
  f.signHead();
  assert.throws(() => proposeChecks({ ...clone(f.pin()), confirmed: 'none' }), {
    code: 'SECRETS_CODE_NEEDED',
  });
  const { proposal } = proposeChecks({ ...clone(f.pin()), confirmed: 'code' });
  const { out, before } = applyInto(f, proposal, extra);
  assert.equal(out.mode, 'kept');
  assert.equal(read(f, before).values.API_TOKEN, 'synthetic-proposed-checks');
  // Overtaken by compaction: Checks never adopts, since its proposer cannot open the value to recognise it.
  const stale = proposeChecks({ ...clone(f.pin()), confirmed: 'code' }).proposal;
  compactToFloor7(f);
  assert.throws(() => applyInto(f, stale, extra), { code: 'WORK_CONFLICT', message: /new one/ });
});
test('review N1: a proposal from a device removed since is refused at open', () => {
  const { f, member } = setup();
  const { proposal } = propose(f, member, 'API_TOKEN', text('synthetic-value'));
  f.bump();
  f.transition({ removed: [member.id] });
  f.wrap();
  assert.throws(() => openProposal(view(f), proposal), { code: 'SECRETS_NOT_ALLOWED' });
});
/** 199 live names and 201 tombstones: a new name makes its write drop the oldest tombstone (version 1, above floor 0). */
function fill400(f) {
  f.bump();
  for (let i = 0; i < 199; i++) f.name(`LIVE_TOKEN_${i}`, text(`synthetic-live-${i}`));
  for (let i = 0; i < 201; i++) f.name(`GONE_TOKEN_${i}`, Buffer.alloc(0), { kind: 3 });
  assert.equal(f.reply.head.names.length, 400);
}
test('review M2: at 400 records a new-name proposal signs the version its compacting apply computes, and is kept', () => {
  const { f, member } = setup();
  fill400(f);
  const { proposal } = propose(f, member, 'NEW_TOKEN', text('synthetic-new-value'));
  const { out, before } = applyInto(f, proposal);
  assert.deepEqual([out.mode, out.record.valueVersion, f.reply.head.versionFloor], ['kept', 2, 1]);
  assert.deepEqual(out.record.changedBy, member.id);
  assert.equal(f.reply.head.names.length, 400);
  assert.equal(read(f, before).values.NEW_TOKEN, 'synthetic-new-value');
  // Checks: the same boundary keeps the approved proposer's record instead of a dead end.
  const c = fixture(31, 'fixture-project', 2),
    proposer = deviceKeys(memberAccount, c.random);
  c.dev.transition({
    added: [c.dev.entry(proposer, { accountId: memberAccount, role: 2, how: 2, addedAtRosterVersion: 3 })],
  });
  c.dev.wrap();
  c.request.development = c.dev.pin();
  fill400(c);
  c.reply.head.proposers = [
    { deviceId: proposer.id, accountId: memberAccount, approvedBy: c.keys.id, approvedAt: 1 },
  ];
  c.signHead();
  const development = c.request.development.roster;
  const checks = sealProposal({
    pin: { ...clone(c.pin()), confirmed: 'code' },
    proposer,
    development,
    name: 'NEW_TOKEN',
    value: text('synthetic-new-checks'),
    now: 9000,
    random: c.random,
  }).proposal;
  const applied = applyInto(c, checks, { development, developmentRevoked: [] });
  assert.deepEqual([applied.out.mode, applied.out.record.valueVersion], ['kept', 2]);
  assert.equal(read(c, applied.before).values.NEW_TOKEN, 'synthetic-new-checks');
});
