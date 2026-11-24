// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The server proposal store (Item 6466c6a5) against the real sealed Convex module: propose checks a proposal as a
// holder would and stores it; a Development head write answers waiting proposals and removes them in the same
// mutation; reject and re-keys drop them. Every refused call leaves the stored records byte-for-byte unchanged.
// Synthetic keys and values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import { clone, server, setup } from './helpers/sealed-hosted.mjs';
import { device } from './helpers/sealed-devices.mjs';
import { fixture } from './helpers/sealed-fixture.mjs';
import { forgeSecretId } from '../dist/sealed-format.js';
import { deviceKeys } from '../dist/sealed-keys.js';
import { decodeSealedWire, encodeSealedWire } from '../dist/sealed-wire.js';
import { makeRoom } from '../dist/sealed-value.js';
import { sealedRead, sealedWrite, sealedWriteArgs } from '../dist/sealed-transport.js';
import { verifySealedReply } from '../dist/sealed-verify.js';
import { applyProposal, openProposal, sealProposal } from '../dist/sealed-proposal.js';
import { moduleUrl } from './convex-module.mjs';

const markers = await import(moduleUrl('../convex/sealedSecretMarkers.ts'));
const gate = await import(moduleUrl('../convex/sealedSecretGate.ts'));

const code = expected => error => (error.code ?? error.data?.code) === expected;
const MEMBER = 'fixture-member';
const memberAccount = forgeSecretId('account', MEMBER);
const bytes = value => Uint8Array.from(encodeSealedWire(value)).buffer;

/** Owner genesis with TOKEN, then a step that shares Development with a write member's device, which proposes. */
async function harness(t) {
  const h = setup(t),
    f = h.f;
  h.base = null;
  h.member = device(h, t, MEMBER, { keys: deviceKeys(memberAccount, f.random) });
  h.publish = async (more = {}, who = null) => {
    const wire = sealedWrite(f.reply, randomUUID(), h.base),
      args = { ...sealedWriteArgs(wire), ...more, kind: 1, projectId: h.project };
    const write = () => h.s.transaction(() => server.write._handler(h.s.ctx, args));
    const result = await (who ? who.as(write) : write());
    if (result.accepted)
      h.base = { headHash: Buffer.from(wire.headHash), rosterVersion: f.reply.roster.rosterVersion };
    return result;
  };
  h.call = (name, args, who = h.member) =>
    who.as(() => h.s.transaction(() => server[name]._handler(h.s.ctx, { projectId: h.project, ...args })));
  h.propose = (proposal, who = h.member, kind = 1) =>
    h.call('propose', { kind, proposal: bytes(proposal) }, who);
  h.seal = (name, value, options = {}) =>
    sealProposal({
      pin: clone(f.pin()),
      proposer: h.member.keys,
      name,
      value,
      now: f.reply.head.signedAt + 1,
      random: f.random,
      ...options,
    }).proposal;
  h.rows = () =>
    serialize({
      sets: [...h.s.tables.sealedSecretSets.values()],
      history: [...h.s.tables.sealedSecretHistory.values()],
      proposals: [...h.s.tables.sealedSecretProposals.values()],
    });
  h.set = () => [...h.s.tables.sealedSecretSets.values()].find(s => s.kind === 1);
  h.waiting = async () =>
    (await server.read._handler(h.s.ctx, { projectId: h.project, kind: 1 })).proposals ?? 0;
  f.name('TOKEN', Buffer.from('owner-synthetic-value'));
  assert.equal((await h.publish()).accepted, true);
  f.bump();
  f.transition({
    added: [f.entry(h.member.keys, { accountId: memberAccount, role: 2, how: 2, addedAtRosterVersion: 2 })],
  });
  f.wrap();
  assert.equal((await h.publish()).accepted, true);
  /** One more Development device: of `account` (a new write member), or another device of the member's account. */
  h.addDevice = async (account = MEMBER) => {
    const accountId = forgeSecretId('account', account),
      keys = deviceKeys(accountId, f.random),
      own = account === MEMBER,
      who = own ? h.member : device(h, t, account, { keys });
    // Another device of the member's account is the member device's own addition (how 4), signed and sent by it.
    const signer = own ? h.member.keys : f.keys;
    f.bump();
    f.transition(
      {
        added: [
          f.entry(keys, {
            accountId,
            role: 2,
            how: own ? 4 : 2,
            addedBy: signer.id,
            addedAtRosterVersion: f.reply.roster.rosterVersion + 1,
          }),
        ],
      },
      signer,
    );
    f.wrap();
    if (own) f.signHead(signer);
    assert.equal((await h.publish({}, own ? h.member : null)).accepted, true);
    return { keys, who };
  };
  return h;
}
async function refused(h, expected, run) {
  const before = h.rows();
  await assert.rejects(run(), code(expected));
  assert.deepEqual(h.rows(), before, 'a refused call changes no stored record');
}
/** The owner opens the stored proposal on its current view and puts the applied record in its next head. */
function apply(h, stored) {
  const f = h.f,
    room = { ...f.reply.head, names: [...f.reply.head.names] },
    p = openProposal(
      { roster: f.reply.roster, head: f.reply.head, key: f.key, revoked: [] },
      decodeSealedWire(new Uint8Array(stored)),
    );
  makeRoom(room, p.proposal.name);
  try {
    const out = applyProposal(
      { roster: f.reply.roster, head: room, key: f.key, revoked: [] },
      p,
      f.keys,
      f.reply.head.signedAt + 1,
      f.random,
    );
    f.bump();
    f.reply.head.versionFloor = room.versionFloor;
    f.reply.head.names = room.names.filter(n => n.name !== out.record.name).concat(out.record);
    f.reply.ciphertexts = f.reply.ciphertexts.filter(c => c.name !== out.record.name);
    if (out.stored) f.reply.ciphertexts.push({ name: out.record.name, stored: out.stored });
    f.signHead();
    return out;
  } finally {
    p.r.fill(0);
    p.value.fill(0);
  }
}
const readValues = async h => {
  const result = verifySealedReply(
    sealedRead(await server.read._handler(h.s.ctx, { projectId: h.project, kind: 1 })),
    null,
    h.f.request,
  );
  result.key?.fill(0);
  const values = Object.fromEntries(result.secrets.map(s => [s.name, s.value.toString()]));
  for (const s of result.secrets) s.value.fill(0);
  return { values, notices: result.notices };
};

test('6466c6a5 a member proposes a change; the owner applies it and the same write removes the proposal', async t => {
  const h = await harness(t);
  assert.equal(await h.waiting(), 0);
  const proposal = h.seal('TOKEN', Buffer.from('proposed-synthetic-value'));
  assert.deepEqual(await h.propose(proposal), { accepted: true, replay: false });
  assert.deepEqual(await h.propose(proposal), { accepted: true, replay: true });
  assert.equal(await h.waiting(), 1);
  // Slice 4: the pending facts keep the operation and kind (a change of an env value), so the Secrets page names them
  // without opening the proposal bytes; the same proposal counts once in the set's needs-you total.
  assert.deepEqual([h.set().proposals[0].op, h.set().proposals[0].kind, h.set().needs], [2, 1, 1]);
  const listed = await server.proposals._handler(h.s.ctx, { projectId: h.project, kind: 1 });
  assert.equal(listed.length, 1);
  assert.equal(apply(h, listed[0]).mode, 'kept');
  assert.equal((await h.publish()).accepted, true);
  assert.equal(h.s.tables.sealedSecretProposals.size, 0);
  assert.equal(h.set().proposals, undefined);
  assert.equal(await h.waiting(), 0);
  const { values, notices } = await readValues(h);
  assert.equal(values.TOKEN, 'proposed-synthetic-value');
  assert(notices.some(line => /TOKEN: proposed by/.test(line)));
});

test('6466c6a5 propose refuses what a holder would refuse, and stores nothing', async t => {
  const h = await harness(t),
    f = h.f;
  const good = h.seal('NEW_TOKEN', Buffer.from('new-synthetic-value'));
  // Checks takes no proposals yet; another account's sign-in cannot send this device's proposal.
  await refused(h, 'SECRETS_NOT_ALLOWED', () => h.propose(good, h.member, 2));
  const other = device(h, t, 'fixture-other');
  await refused(h, 'SECRETS_ROSTER_REFUSED', () => h.propose(good, other));
  // A tampered record: its signature no longer matches.
  await refused(h, 'SECRETS_VALUE_REFUSED', () => h.propose({ ...good, proposedAt: good.proposedAt + 1 }));
  // An extra field fails the exact record schema.
  await refused(h, 'SECRETS_FORMAT_REFUSED', () => h.propose({ ...good, extra: 1 }));
  // A proposer Forge marked for removal.
  h.set().revoked = [Uint8Array.from(h.member.keys.id).buffer];
  await refused(h, 'SECRETS_NOT_ALLOWED', () => h.propose(good));
  h.set().revoked = undefined;
  // A read-only member's sign-in has no write access.
  const grant = h.s.tables.projectContributors.get(`pc-${MEMBER}`);
  h.s.tables.projectContributors.delete(`pc-${MEMBER}`);
  await refused(h, 'PROJECT_UNAVAILABLE', () => h.propose(good));
  h.s.tables.projectContributors.set(`pc-${MEMBER}`, grant);
  // The same id with other bytes.
  assert.equal((await h.propose(good)).accepted, true);
  const again = h.seal('NEW_TOKEN', Buffer.from('other-synthetic-value'), {
    random: n => (n === 16 ? Buffer.from(good.proposalId) : h.f.random(n)),
  });
  assert.deepEqual(again.proposalId, good.proposalId);
  await refused(h, 'WORK_OPERATION_REUSED', () => h.propose(again));
  // A proposal from before a re-key.
  const stale = h.seal('LATER_TOKEN', Buffer.from('later-synthetic-value'));
  f.rekey({ epochBumped: 1 });
  assert.equal((await h.publish()).accepted, true);
  await refused(h, 'WORK_CONFLICT', () => h.propose(stale));
});

test('6466c6a5 a re-key drops older proposals; a newer proposal for the same name replaces the older', async t => {
  const h = await harness(t),
    f = h.f;
  assert.equal((await h.propose(h.seal('TOKEN', Buffer.from('first-synthetic-value')))).accepted, true);
  assert.equal((await h.propose(h.seal('OTHER_TOKEN', Buffer.from('other-synthetic-value')))).accepted, true);
  const newer = h.seal('TOKEN', Buffer.from('second-synthetic-value'));
  assert.equal((await h.propose(newer)).accepted, true);
  assert.deepEqual(
    h.set().proposals.map(p => p.name),
    ['OTHER_TOKEN', 'TOKEN'],
  );
  assert.equal(h.s.tables.sealedSecretProposals.size, 2);
  f.rekey({ epochBumped: 1 });
  assert.equal((await h.publish()).accepted, true);
  assert.equal(h.set().proposals, undefined);
  assert.equal(h.s.tables.sealedSecretProposals.size, 0);
});

test('6466c6a5 review F3: the waiting cap is 8 proposals per proposer device and 32 or 256 KiB per set', async t => {
  const h = await harness(t);
  const devices = [{ keys: h.member.keys, who: h.member }];
  for (let i = 1; i < 5; i++) devices.push(await h.addDevice(`fixture-proposer-${i}`));
  const fill = async (d, i, n) =>
    (
      await h.propose(
        h.seal(`TOKEN_${i}_${n}`, Buffer.from('cap-synthetic-value'), { proposer: d.keys }),
        d.who,
      )
    ).accepted;
  for (let n = 0; n < 8; n++) assert.equal(await fill(devices[0], 0, n), true);
  // One device holds at most 8, so a looping agent leaves room for the others.
  await refused(h, 'SECRETS_NOT_ALLOWED', () => fill(devices[0], 0, 8));
  for (let i = 1; i < 4; i++) for (let n = 0; n < 8; n++) assert.equal(await fill(devices[i], i, n), true);
  assert.equal(h.set().proposals.length, 32);
  await refused(h, 'SECRETS_NOT_ALLOWED', () => fill(devices[4], 4, 0));
  // A replacement of a waiting proposal still fits.
  assert.equal((await h.propose(h.seal('TOKEN_0_0', Buffer.from('cap-synthetic-value-2')))).accepted, true);
  const big = await harness(t);
  for (let i = 0; i < 3; i++)
    assert.equal((await big.propose(big.seal(`BIG_${i}`, Buffer.alloc(65536, 0x61)))).accepted, true);
  await refused(big, 'SECRETS_NOT_ALLOWED', () => big.propose(big.seal('BIG_3', Buffer.alloc(65536, 0x61))));
});

test('6466c6a5 a head record claiming a proposal must answer a waiting one; reject and resolved drop proposals', async t => {
  const h = await harness(t),
    f = h.f;
  const proposal = h.seal('TOKEN', Buffer.from('proposed-synthetic-value'));
  assert.equal((await h.propose(proposal)).accepted, true);
  const [stored] = await server.proposals._handler(h.s.ctx, { projectId: h.project, kind: 1 });
  // Rejected first: the applying write stores nothing.
  const reply = clone(f.reply);
  assert.deepEqual(
    await h.call('reject', { kind: 1, proposalIds: [Uint8Array.from(proposal.proposalId).buffer] }, h.member),
    {
      rejected: 1,
    },
  );
  assert.equal(h.s.tables.sealedSecretProposals.size, 0);
  apply(h, stored);
  await refused(h, 'WORK_CONFLICT', () => h.publish());
  for (const key of Object.keys(f.reply)) delete f.reply[key];
  Object.assign(f.reply, clone(reply));
  // An ordinary write that names a waiting proposal as resolved (an adoption, or a rejection with the write).
  const next = h.seal('OTHER_TOKEN', Buffer.from('other-synthetic-value'));
  assert.equal((await h.propose(next)).accepted, true);
  f.bump();
  f.name('OWNER_TOKEN', Buffer.from('owner-synthetic-value-2'));
  assert.equal(
    (await h.publish({ resolved: [Uint8Array.from(next.proposalId).buffer, new ArrayBuffer(16)] })).accepted,
    true,
  );
  assert.equal(h.s.tables.sealedSecretProposals.size, 0);
  assert.equal(h.set().proposals, undefined);
  // A Checks head still carries no proposal record.
  const c = fixture(23, 'fixture-project', 2);
  c.name('CHECKS_TOKEN', Buffer.from('checks-synthetic-value'), { proposalId: Buffer.alloc(16, 3) });
  await refused(h, 'SECRETS_NOT_ALLOWED', () =>
    h.s.transaction(() =>
      server.write._handler(h.s.ctx, {
        ...sealedWriteArgs(sealedWrite(c.reply, randomUUID(), null)),
        kind: 2,
        projectId: h.project,
      }),
    ),
  );
});

test('6466c6a5 review F1: a proposer withdraws its own; another person\u2019s proposal needs a roster write device', async t => {
  const h = await harness(t);
  const id = p => Uint8Array.from(p.proposalId).buffer;
  const first = h.seal('TOKEN', Buffer.from('first-synthetic-value')),
    second = h.seal('OTHER_TOKEN', Buffer.from('second-synthetic-value'));
  assert.equal((await h.propose(first)).accepted, true);
  assert.equal((await h.propose(second)).accepted, true);
  // A write member with no device on the roster cannot reject anyone's proposals; nothing is half-done.
  const stranger = device(h, t, 'fixture-stranger');
  await refused(h, 'SECRETS_NOT_ALLOWED', () =>
    h.call('reject', { kind: 1, proposalIds: [id(first), id(second)] }, stranger),
  );
  // Another account's proposal next to the caller's own refuses the whole call.
  const other = await h.addDevice('fixture-other');
  const theirs = h.seal('THEIR_TOKEN', Buffer.from('their-synthetic-value'), { proposer: other.keys });
  assert.equal((await h.propose(theirs, other.who)).accepted, true);
  const row = h.s.tables.cliCredentials.get(`${MEMBER}-device-row`);
  row.settings = { source: 'write', projects: { kind: 'project', projectId: h.project } };
  await refused(h, 'SECRETS_NOT_ALLOWED', () =>
    h.call('reject', { kind: 1, proposalIds: [id(first), id(theirs)] }),
  );
  // The proposer's own account withdraws from a project-scoped device; an unknown id is ignored.
  assert.deepEqual(await h.call('reject', { kind: 1, proposalIds: [id(first), new ArrayBuffer(16)] }), {
    rejected: 1,
  });
  // A person's write device on the roster (the owner) rejects another person's.
  row.settings = { source: 'write', projects: { kind: 'all' } };
  const owner = { as: run => run() };
  assert.deepEqual(await h.call('reject', { kind: 1, proposalIds: [id(second)] }, owner), { rejected: 1 });
  assert.deepEqual(
    h.set().proposals.map(p => p.name),
    ['THEIR_TOKEN'],
  );
  // Review F4: a rejected proposal is not stored again, by a retry or anyone else.
  await refused(h, 'WORK_CONFLICT', () => h.propose(first));
});

test('6466c6a5 review F2: marking a proposer drops its proposals in the same mutation', async t => {
  const h = await harness(t);
  const second = await h.addDevice(); // another device of the member's account
  assert.equal((await h.propose(h.seal('TOKEN', Buffer.from('a-synthetic-value')))).accepted, true);
  assert.equal(
    (await h.propose(h.seal('OTHER_TOKEN', Buffer.from('b-synthetic-value'), { proposer: second.keys })))
      .accepted,
    true,
  );
  const other = await h.addDevice('fixture-other');
  assert.equal(
    (
      await h.propose(
        h.seal('THEIR_TOKEN', Buffer.from('c-synthetic-value'), { proposer: other.keys }),
        other.who,
      )
    ).accepted,
    true,
  );
  // An ended sign-in marks that device only, and drops that device's proposals only.
  await h.s.transaction(() =>
    markers.markEndedSignIn(h.s.ctx, MEMBER, [
      { projectId: h.project, deviceId: Uint8Array.from(second.keys.id).buffer },
    ]),
  );
  assert.deepEqual(
    h.set().proposals.map(p => p.name),
    ['TOKEN', 'THEIR_TOKEN'],
  );
  assert.equal(h.s.tables.sealedSecretProposals.size, 2);
  // The person leaves the project: every device of the account is marked and its proposals leave.
  await h.s.transaction(() => markers.markRemovedAccount(h.s.ctx, h.project, MEMBER));
  assert.deepEqual(
    h.set().proposals.map(p => p.name),
    ['THEIR_TOKEN'],
  );
  assert.equal(h.s.tables.sealedSecretProposals.size, 1);
  assert.equal(h.set().resolvedProposals.length, 2);
});

test('6466c6a5 review F4 N3: an applied proposal is not stored again; a proposer off the roster or marked is dropped', async t => {
  const h = await harness(t);
  const proposal = h.seal('TOKEN', Buffer.from('proposed-synthetic-value'));
  assert.equal((await h.propose(proposal)).accepted, true);
  const [stored] = await server.proposals._handler(h.s.ctx, { projectId: h.project, kind: 1 });
  apply(h, stored);
  assert.equal((await h.publish()).accepted, true);
  await refused(h, 'WORK_CONFLICT', () => h.propose(proposal));
  // A removal always re-keys (src/sealed-roster.ts), so the write gate is checked directly: same epoch, proposer gone
  // from the roster, or still listed but marked.
  const pending = {
      id: 'row',
      proposalId: new ArrayBuffer(16),
      proposerId: Uint8Array.from(h.member.keys.id).buffer,
      name: 'TOKEN',
      epoch: 1,
      size: 1,
      at: 1,
    },
    set = { proposals: [pending] },
    facts = entries => ({ head: { names: [], epoch: 1 }, roster: { entries } });
  const listed = [{ entryKind: 1, id: Uint8Array.from(h.member.keys.id) }];
  assert.deepEqual(gate.nextProposals(set, facts(listed), null, [], []).dropped, []);
  assert.deepEqual(gate.nextProposals(set, facts([]), null, [], []).dropped, ['row']);
  assert.deepEqual(gate.nextProposals(set, facts(listed), null, [], [pending.proposerId]).dropped, ['row']);
  // Remembered ids stay bounded at 64, newest last.
  const many = Array.from({ length: 70 }, (_, i) => ({ ...pending, proposalId: Uint8Array.of(i).buffer }));
  const ring = gate.rememberResolved({ resolvedProposals: [] }, many);
  assert.equal(ring.length, 64);
  assert.deepEqual(new Uint8Array(ring.at(-1)), Uint8Array.of(69));
});
