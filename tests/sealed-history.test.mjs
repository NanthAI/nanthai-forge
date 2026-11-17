// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize } from 'node:v8';
import { fixture } from './helpers/sealed-fixture.mjs';
import { assertSecretReplyRefused } from './helpers/secret-server.mjs';
import { deviceKeys, signBytes } from '../dist/sealed-keys.js';
import { forgeSecretId, framedHash } from '../dist/sealed-format.js';
import { rosterBytes, headBytes, changeBytes, supersedeBytes } from '../dist/sealed-records.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
const clone = x => deserialize(serialize(x));
const pin = f => clone(f.pin());
const pub = f => {
  const { recipient, ...request } = f.request;
  return request;
};
const refuse = async (f, p, code, request = pub(f)) => {
  f.server.rows.set('set', f.reply);
  await assertSecretReplyRefused(assert, {
    server: f.server,
    pin: p,
    request,
    code,
    verify: async (r, p, q) => verifySealedReply(r, p, q),
  });
};
function addOwner(f) {
  const d = deviceKeys(forgeSecretId('account', 'other-owner'), f.random);
  f.transition({
    added: [
      f.entry(d, {
        accountId: forgeSecretId('account', 'other-owner'),
        role: 1,
        how: 6,
        addedAtRosterVersion: f.reply.roster.rosterVersion + 1,
      }),
    ],
  });
  return d;
}
function replacement(old, newSet) {
  const r = old.reply.roster,
    h = old.reply.head,
    s = {
      projectId: r.projectId,
      setKind: r.setKind,
      oldSetId: r.setId,
      oldGenesisHash: framedHash(rosterBytes(old.reply.genesis)),
      oldRosterVersion: r.rosterVersion,
      oldRosterHash: framedHash(rosterBytes(r)),
      oldHeadHash: framedHash(headBytes(h)),
      newSetId: newSet.reply.roster.setId,
      newGenesisHash: framedHash(rosterBytes(newSet.reply.genesis)),
      signerId: old.keys.id,
      at: 1000,
    };
  s.signature = signBytes(supersedeBytes(s), old.keys.sign);
  return s;
}

test('T12 a denied name in a signed head is reported but cannot reach the child provider', () => {
  const f = fixture();
  f.name('PATH');
  f.name('API_TOKEN');
  const r = verifySealedReply(f.reply, null, f.request);
  assert.deepEqual(
    r.secrets.map(s => s.name),
    ['API_TOKEN'],
  );
  assert(r.notices.some(n => n.includes('PATH: name is not accepted')));
});
test('T64 epoch bounds include the pinned epoch and former signer lastEpoch, at adjacent and skipped heads', async () => {
  const f = fixture();
  f.name();
  f.rekey();
  const p = pin(f);
  f.bump();
  f.name('API_TOKEN', Buffer.from('old-epoch-synthetic-value'), { valueEpoch: 1 });
  await refuse(f, p, 'SECRETS_ROLLBACK');
  const g = fixture(),
    other = addOwner(g),
    early = pin(g);
  g.bump();
  g.name('API_TOKEN', Buffer.from('by-other-synthetic-value'), { changedBy: other.id, signer: other });
  g.rekey({ removed: [other.id], epochBumped: 1 });
  g.bump();
  g.name('API_TOKEN', Buffer.from('forged-late-former-value'), {
    changedBy: other.id,
    signer: other,
    valueEpoch: 2,
  });
  await refuse(g, early, 'SECRETS_ROLLBACK');
  const h = fixture(),
    author = addOwner(h);
  h.bump();
  h.name('API_TOKEN', Buffer.from('old-author-synthetic-value'), { changedBy: author.id, signer: author });
  const q = pin(h);
  h.rekey({ removed: [author.id], epochBumped: 1 });
  h.name('NEW_TOKEN', Buffer.from('late-former-synthetic-value'), {
    changedBy: author.id,
    signer: author,
    valueEpoch: 1,
    proposalId: Buffer.alloc(16, 8),
  });
  await refuse(h, q, 'SECRETS_ROSTER_REFUSED');
});
test('T67 re-addition after tombstone compaction starts above the floor and preserves a pre-removal pin', () => {
  const f = fixture();
  f.name();
  const p = pin(f);
  f.bump();
  f.name('API_TOKEN', Buffer.alloc(0), { kind: 3 });
  const removed = pin(f);
  f.bump();
  f.reply.head.names = [];
  f.reply.head.versionFloor = 2;
  f.signHead();
  verifySealedReply(f.reply, removed, f.request);
  f.bump();
  assert.equal(f.name().valueVersion, 3);
  assert.equal(verifySealedReply(f.reply, p, f.request).secrets.length, 1);
});
test('T69 a valid forward Checks replacement moves a pin; an older record cannot move a newer pin', async () => {
  const old = fixture(17, 'fixture-project', 2),
    p = pin(old),
    next = fixture(19, 'fixture-project', 2),
    s = replacement(old, next);
  next.reply.supersede = s;
  next.reply.previous = clone(old.reply);
  assert.deepEqual(verifySealedReply(next.reply, p, next.request).pin.roster.setId, next.reply.roster.setId);
  old.bump();
  old.name();
  const newer = pin(old);
  await refuse(next, newer, 'SECRETS_SET_REPLACED', next.request);
});
test('a pin present at entry keeps the verified replacement anchor instead of applying a first-contact anchor', () => {
  const old = fixture(),
    next = fixture(19),
    p = pin(old);
  next.reply.supersede = replacement(old, next);
  next.reply.previous = clone(old.reply);
  const result = verifySealedReply(next.reply, p, pub(old));
  assert.deepEqual(result.pin.roster.setId, next.reply.roster.setId);
  result.key?.fill(0);
  for (const secret of result.secrets) secret.value.fill(0);
});
test('T69 Checks pointer records are independently authorized, and owner non-holders walk from genesis', async () => {
  const checks = fixture(17, 'fixture-project', 2),
    dev = fixture();
  dev.transition({
    newChecksPointer: {
      checksSetId: checks.reply.roster.setId,
      checksGenesisHash: framedHash(rosterBytes(checks.reply.genesis)),
    },
  });
  const p = pin(dev),
    next = fixture(19, 'fixture-project', 2),
    s = replacement(checks, next);
  dev.bump();
  dev.transition({
    newChecksPointer: {
      checksSetId: next.reply.roster.setId,
      checksGenesisHash: framedHash(rosterBytes(next.reply.genesis)),
    },
    supersede: s,
  });
  assert.equal(
    verifySealedReply(dev.reply, p, { ...pub(dev), checks: pin(checks) }).pin.roster.rosterVersion,
    3,
  );
  s.signature = Buffer.alloc(64);
  dev.reply.transitions.at(-1).delta.supersede = s;
  await refuse(dev, p, 'SECRETS_ROSTER_REFUSED', { ...pub(dev), checks: pin(checks) });
  const fresh = fixture(19, 'fixture-project', 2),
    development = fresh.request.development;
  fresh.transition({ epochBumped: 1 });
  fresh.reply.transitions = [];
  await refuse(fresh, null, 'SECRETS_PIN_TOO_OLD', { ...fresh.request, development });
});
test('T79 a revoked change author has no authority for a new proposal, while its pinned record remains valid', async () => {
  const f = fixture(),
    author = addOwner(f);
  f.bump();
  f.name('API_TOKEN', Buffer.from('before-revocation-value'), {
    changedBy: author.id,
    signer: author,
    proposalId: Buffer.alloc(16, 1),
  });
  const p = pin(f);
  f.reply.revoked = [author.id];
  assert.equal(verifySealedReply(f.reply, p, pub(f)).pin.head.headVersion, p.head.headVersion);
  f.bump();
  f.name('API_TOKEN', Buffer.from('after-revocation-value'), {
    changedBy: author.id,
    signer: author,
    proposalId: Buffer.alloc(16, 2),
  });
  await refuse(f, p, 'SECRETS_ROSTER_REFUSED');
});
test('T93 dropped former signers, re-addition and Checks proposal fallback retain the right attribution rules', async () => {
  const f = fixture(),
    author = addOwner(f),
    early = pin(f);
  f.bump();
  f.name('API_TOKEN', Buffer.from('retained-author-value'), { changedBy: author.id, signer: author });
  f.rekey({ removed: [author.id], epochBumped: 1 });
  const saw = pin(f);
  f.bump();
  f.transition({ droppedFormer: [author.id] });
  await refuse(f, early, 'SECRETS_ROSTER_REFUSED');
  assert.equal(verifySealedReply(f.reply, saw, pub(f)).pin.head.names.length, 1);
  const g = fixture(),
    second = addOwner(g);
  g.rekey({ removed: [second.id], epochBumped: 1 });
  const before = pin(g);
  g.bump();
  g.transition({
    added: [
      g.entry(second, {
        accountId: forgeSecretId('account', 'other-owner'),
        how: 6,
        role: 1,
        addedAtRosterVersion: g.reply.roster.rosterVersion + 1,
      }),
    ],
    droppedFormer: [second.id],
  });
  assert.equal(verifySealedReply(g.reply, before, pub(g)).pin.roster.former.length, 0);
  const c = fixture(17, 'fixture-project', 2);
  c.name('API_TOKEN', Buffer.from('fallback-proposal-value'), {
    changedBy: Buffer.alloc(16, 99),
    proposalId: Buffer.alloc(16, 1),
  });
  const result = verifySealedReply(c.reply, null, c.request);
  assert(result.notices.some(n => n.includes('not checked against Development')));
  const cp = clone(result.pin);
  c.bump();
  c.reply.head.proposers = [];
  c.signHead();
  assert.equal(verifySealedReply(c.reply, cp, c.request).secrets.length, 1);
  const machine = verifySealedReply(c.reply, null, {
    ...c.request,
    machine: true,
    machineAnchor: clone(c.reply.roster),
    anchor: undefined,
    headFloor: 1,
  });
  assert.equal(machine.secrets.length, 1);
});
