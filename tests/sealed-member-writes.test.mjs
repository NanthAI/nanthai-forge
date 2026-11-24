// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Gate B1 server gate stage 3: write members store Development heads (C21, C24) and the C25 negatives, against
// the real sealed Convex module. Every refused write leaves the stored records byte-for-byte unchanged.
// Synthetic keys and values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import { clone, server, setup } from './helpers/sealed-hosted.mjs';
import { device } from './helpers/sealed-devices.mjs';
import { codeDevice, freshPin, runCode } from './helpers/sealed-code-journey.mjs';
import { fixture } from './helpers/sealed-fixture.mjs';
import { forgeSecretId } from '../dist/sealed-format.js';
import { deviceKeys } from '../dist/sealed-keys.js';
import { SecretPins } from '../dist/sealed-pins.js';
import { sealedRead, sealedWrite, sealedWriteArgs } from '../dist/sealed-transport.js';
import { verifySealedReply } from '../dist/sealed-verify.js';

const code = expected => error => (error.code ?? error.data?.code) === expected;
const MEMBER = 'fixture-member';
const memberAccount = forgeSecretId('account', MEMBER);
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
/** Owner genesis with one value, then an owner step that shares Development with a write member's device. */
async function withMember(t) {
  const h = setup(t),
    f = h.f;
  h.base = null;
  h.member = device(h, t, MEMBER, { keys: deviceKeys(memberAccount, f.random) });
  h.publish = async (who = null) => {
    const wire = sealedWrite(f.reply, randomUUID(), h.base),
      args = { ...sealedWriteArgs(wire), kind: 1, projectId: h.project };
    const write = () => h.s.transaction(() => server.write._handler(h.s.ctx, args));
    const result = await (who ? who.as(write) : write());
    if (result.accepted)
      h.base = { headHash: Buffer.from(wire.headHash), rosterVersion: f.reply.roster.rosterVersion };
    return result;
  };
  h.rows = () =>
    serialize({
      sets: [...h.s.tables.sealedSecretSets.values()],
      history: [...h.s.tables.sealedSecretHistory.values()],
    });
  h.set = () => [...h.s.tables.sealedSecretSets.values()][0];
  f.name();
  assert.equal((await h.publish()).accepted, true);
  f.bump();
  f.transition({
    added: [f.entry(h.member.keys, { accountId: memberAccount, role: 2, how: 2, addedAtRosterVersion: 2 })],
  });
  f.wrap();
  assert.equal((await h.publish()).accepted, true);
  /** The member device's own value change, signed by its device key. */
  h.memberValue = (name = 'MEMBER_TOKEN') => {
    f.bump();
    f.name(name, Buffer.from('member-synthetic-value'), {
      changedBy: h.member.keys.id,
      signer: h.member.keys,
    });
    f.signHead(h.member.keys);
  };
  return h;
}
async function refused(h, who, expected, change) {
  const before = h.rows(),
    reply = clone(h.f.reply);
  change();
  await assert.rejects(h.publish(who), code(expected));
  assert.deepEqual(h.rows(), before, 'a refused write changes no stored record');
  for (const key of Object.keys(h.f.reply)) delete h.f.reply[key];
  Object.assign(h.f.reply, clone(reply));
}

test('C21 a write member stores a Development head it signs; the owner reads the value and the ring is unchanged', async t => {
  const h = await withMember(t),
    ring = clone([...h.s.tables.sealedSecretHistory.values()][0].transitions);
  h.memberValue();
  assert.equal((await h.publish(h.member)).accepted, true);
  assert.deepEqual([...h.s.tables.sealedSecretHistory.values()][0].transitions, ring);
  const opened = verifySealedReply(
    sealedRead(await server.read._handler(h.s.ctx, { projectId: h.project, kind: 1 })),
    null,
    h.f.request,
  );
  assert.equal(
    opened.secrets.find(s => s.name === 'MEMBER_TOKEN').value.toString(),
    'member-synthetic-value',
  );
  clear(opened);
});

test('C21 a genesis stays the project owner’s: a write member cannot start a set', async t => {
  const h = setup(t),
    m = device(h, t, MEMBER),
    own = fixture(23);
  own.name();
  const args = {
    ...sealedWriteArgs(sealedWrite(own.reply, randomUUID(), null)),
    kind: 1,
    projectId: h.project,
  };
  await assert.rejects(
    m.as(() => h.s.transaction(() => server.write._handler(h.s.ctx, args))),
    code('SECRETS_NOT_SET_UP'),
  );
  assert.equal(h.s.tables.sealedSecretSets.size, 0);
  assert.equal(h.s.tables.sealedSecretHistory.size, 0);
});

test('C24 the credential gate: no device key, a scoped or read-only sign-in, no write grant or a removed member is refused', async t => {
  const h = await withMember(t),
    row = h.s.tables.cliCredentials.get(`${MEMBER}-device-row`);
  const cases = [
    ['AUTH_SCOPE_DENIED', () => (row.deviceKey = undefined), () => (row.deviceKey = 'synthetic-public-key')],
    [
      'AUTH_SCOPE_DENIED',
      () => (row.settings = { source: 'read', projects: { kind: 'all' } }),
      () => (row.settings = { source: 'write', projects: { kind: 'all' } }),
    ],
    ['AUTH_SCOPE_DENIED', () => (row.scope = 'browser'), () => (row.scope = 'cli')],
  ];
  for (const [expected, change, undo] of cases) {
    change();
    await refused(h, h.member, expected, () => h.memberValue());
    undo();
  }
  // Removed from the project: refused at once, in the same mutation that would store the head.
  const grant = h.s.tables.projectContributors.get(`pc-${MEMBER}`);
  h.s.tables.projectContributors.delete(`pc-${MEMBER}`);
  await refused(h, h.member, 'PROJECT_UNAVAILABLE', () => h.memberValue());
  h.s.tables.projectContributors.set(`pc-${MEMBER}`, grant);
  h.memberValue();
  assert.equal((await h.publish(h.member)).accepted, true);
});

test('C25 a member cannot sign an owner-only shape, write as another account or clear another account’s marker', async t => {
  const h = await withMember(t),
    f = h.f;
  // A sharing change is an owner shape.
  await refused(h, h.member, 'SECRETS_ROSTER_REFUSED', () => {
    f.bump();
    f.transition({ newSharingMode: 1 }, h.member.keys);
    f.signHead(h.member.keys);
  });
  // A head the owner device signed, sent by the member's sign-in.
  await refused(h, h.member, 'SECRETS_ROSTER_REFUSED', () => {
    f.bump();
    f.name('OWNER_TOKEN');
  });
  // Another account's entry, marked by Forge: only an owner device removes it, so its marker stays.
  const other = deviceKeys(forgeSecretId('account', 'fixture-other'), f.random);
  f.bump();
  f.transition({
    added: [
      f.entry(other, {
        accountId: forgeSecretId('account', 'fixture-other'),
        role: 2,
        how: 2,
        addedAtRosterVersion: 3,
      }),
    ],
  });
  f.wrap();
  assert.equal((await h.publish()).accepted, true);
  h.set().revoked = [Uint8Array.from(other.id).buffer];
  await refused(h, h.member, 'SECRETS_ROSTER_REFUSED', () => {
    f.bump();
    f.transition({ removed: [other.id], epochBumped: 1 }, h.member.keys);
    f.signHead(h.member.keys);
  });
  assert.equal(h.set().revoked.length, 1);
  // The server leaves waiting for the owner's removal to the member's CLI (next test): this value write stores.
  h.memberValue();
  assert.equal((await h.publish(h.member)).accepted, true);
});

test('C21 end to end: a member device confirmed by code writes a new name through its CLI; on a marker it waits for an owner', async t => {
  const h = setup(t),
    f = h.f;
  f.name();
  const m = device(h, t, MEMBER, { keys: deviceKeys(memberAccount, f.random) });
  let base = null;
  const publish = async () => {
    const wire = sealedWrite(f.reply, randomUUID(), base),
      args = { ...sealedWriteArgs(wire), kind: 1, projectId: h.project };
    assert.equal((await h.s.transaction(() => server.write._handler(h.s.ctx, args))).accepted, true);
    base = { headHash: Buffer.from(wire.headHash), rosterVersion: f.reply.roster.rosterVersion };
  };
  await publish();
  const journey = runCode(f, {
    purpose: 1,
    device: codeDevice(m.keys, memberAccount),
    holderPin: await freshPin(t, f),
  });
  await publish();
  const pins = new SecretPins(m.directory, m.store);
  clear(
    await pins.verifyAndSave(
      f.reply,
      {
        forgeProjectId: f.request.forgeProjectId,
        setKind: 1,
        recipient: { id: m.keys.id, enc: m.keys.enc, kind: 1 },
        anchor: journey.anchor,
      },
      1,
    ),
  );
  await m.make().write('MEMBER_TOKEN', Buffer.from('member-cli-synthetic-value'));
  const opened = verifySealedReply(
    sealedRead(await server.read._handler(h.s.ctx, { projectId: h.project, kind: 1 })),
    null,
    f.request,
  );
  assert.equal(
    opened.secrets.find(s => s.name === 'MEMBER_TOKEN').value.toString(),
    'member-cli-synthetic-value',
  );
  clear(opened);
  // A member device never converts another account's marker: it stops and names the owner's step.
  [...h.s.tables.sealedSecretSets.values()][0].revoked = [Uint8Array.from(f.keys.id).buffer];
  const before = serialize([...h.s.tables.sealedSecretSets.values()]);
  await assert.rejects(
    m.make().write('NEXT_TOKEN', Buffer.from('waiting-synthetic-value')),
    code('SECRETS_REKEY_PENDING'),
  );
  assert.deepEqual(serialize([...h.s.tables.sealedSecretSets.values()]), before);
});

test('Gate B3a review N1: a roster step, like the head, is signed by the signed-in account', async t => {
  const h = await withMember(t),
    f = h.f,
    key = f.key;
  // A member re-key is a write-member shape. Signed by the owner device, the member's sign-in cannot send it.
  await refused(h, h.member, 'SECRETS_ROSTER_REFUSED', () => {
    f.rekey({ epochBumped: 1 });
    f.signHead(h.member.keys);
  });
  f.key = key;
  // Signed by the member device, the owner's sign-in cannot send it.
  await refused(h, null, 'SECRETS_ROSTER_REFUSED', () => f.rekey({ epochBumped: 1 }, h.member.keys));
  f.key = key;
  // Step and head both signed by the member device, sent by the member: stored.
  f.rekey({ epochBumped: 1 }, h.member.keys);
  f.signHead(h.member.keys);
  assert.equal((await h.publish(h.member)).accepted, true);
});

test('Stage 3b review L1: only an owner device adds another account’s first device', async t => {
  const h = await withMember(t),
    f = h.f,
    otherAccount = forgeSecretId('account', 'fixture-other'),
    other = deviceKeys(otherAccount, f.random);
  const add = signer => {
    f.bump();
    f.transition(
      {
        added: [
          f.entry(other, {
            accountId: otherAccount,
            accountHandle: 'fixture-other',
            role: 2,
            how: 2,
            addedBy: signer.id,
            addedAtRosterVersion: f.reply.roster.rosterVersion + 1,
          }),
        ],
      },
      signer,
    );
    f.wrap();
    f.signHead(signer);
  };
  const before = h.rows(),
    reply = clone(f.reply);
  add(h.member.keys);
  await assert.rejects(
    h.publish(h.member),
    error => code('SECRETS_ROSTER_REFUSED')(error) && /first device/.test(error.message),
  );
  assert.deepEqual(h.rows(), before, 'a refused write changes no stored record');
  for (const key of Object.keys(f.reply)) delete f.reply[key];
  Object.assign(f.reply, clone(reply));
  add(f.keys);
  assert.equal((await h.publish()).accepted, true);
});
