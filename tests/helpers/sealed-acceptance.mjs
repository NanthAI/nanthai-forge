// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize } from 'node:v8';
import { fixture } from './sealed-fixture.mjs';
import { assertSecretReplyRefused } from './secret-server.mjs';
import { verifySealedReply } from '../../dist/sealed-verify.js';
import { deviceKeys, personKeys, signBytes, recipientId } from '../../dist/sealed-keys.js';
import { framedHash, forgeSecretId } from '../../dist/sealed-format.js';
import { headBytes, rosterBytes, transitionBytes } from '../../dist/sealed-records.js';
const clone = x => deserialize(serialize(x));
const pub = f => {
  const { recipient, ...r } = f.request;
  return r;
};
const pin = f => clone(f.pin());
async function refused(f, p, code, request = f.request) {
  f.server.rows.set('set', f.reply);
  await assertSecretReplyRefused(assert, {
    server: f.server,
    pin: p,
    request,
    code,
    verify: async (reply, trusted, req) => verifySealedReply(reply, trusted, req),
  });
}
function ownerAdd(f, role = 2, accountName = 'fixture-second') {
  const d = deviceKeys(forgeSecretId('account', accountName), f.random);
  const e = f.entry(d, {
    accountId: forgeSecretId('account', accountName),
    accountHandle: 'fixture-second',
    how: role === 1 ? 6 : 2,
    role,
    addedAtRosterVersion: f.reply.roster.rosterVersion + 1,
  });
  f.transition({ added: [e] });
  return d;
}
export function sealedAcceptance() {
  test('T1 server-created signer cannot replace a pinned roster', async () => {
    const f = fixture(),
      p = pin(f),
      attacker = deviceKeys(f.account, f.random);
    f.bump();
    f.transition({ newSharingMode: 1 }, attacker);
    await refused(f, p, 'SECRETS_ROSTER_REFUSED');
  });
  test('T2 removed signers, machines and member devices cannot authorize Checks changes', async () => {
    const f = fixture(),
      second = ownerAdd(f, 1),
      p = pin(f);
    f.bump();
    f.transition({ removed: [second.id], epochBumped: 1 });
    f.transition({ newSharingMode: 1 }, second);
    await refused(f, p, 'SECRETS_ROSTER_REFUSED', pub(f));
    for (const entryKind of [1, 2]) {
      const x = fixture(17, 'fixture-project', 2);
      let outsider = deviceKeys(x.account, x.random);
      if (entryKind === 1) {
        const dev = fixture();
        outsider = ownerAdd(dev, 2, 'fixture-member');
        dev.transition({ newChecksPointer: x.request.development.roster.checksPointer });
        x.request.development = dev.pin();
      }
      if (entryKind === 2) {
        outsider.id = recipientId(2, Buffer.alloc(0), outsider.encPub);
        x.transition({
          added: [
            x.entry(outsider, {
              entryKind: 2,
              role: 3,
              how: 6,
              signPub: Buffer.alloc(0),
              accountId: Buffer.alloc(0),
              bindSig: Buffer.alloc(0),
              addedAtRosterVersion: 2,
            }),
          ],
        });
      }
      const q = pin(x);
      x.bump();
      x.transition({}, outsider);
      assert.throws(
        () => verifySealedReply(x.reply, q, pub(x)),
        e =>
          e.code === 'SECRETS_ROSTER_REFUSED' && e.message === 'Roster transition signer is not authorized.',
      );
      await refused(x, q, 'SECRETS_ROSTER_REFUSED', pub(x));
    }
  });
  test('T3 older rosters, older heads and equal-version forks leave the pin unchanged', async () => {
    const f = fixture(),
      old = clone(f.reply);
    f.bump();
    f.name();
    const p = pin(f);
    f.reply.head = old.head;
    await refused(f, p, 'SECRETS_ROLLBACK');
    f.reply.head = { ...p.head, signedAt: p.head.signedAt + 1 };
    f.signHead();
    await refused(f, p, 'SECRETS_FORK');
    const g = fixture();
    const before = clone(g.reply);
    ownerAdd(g);
    g.bump();
    g.signHead();
    const q = pin(g);
    Object.assign(g.reply, before);
    await refused(g, q, 'SECRETS_ROLLBACK');
  });
  test('T4 signed ciphertext digest refuses an earlier same-epoch ciphertext', async () => {
    const f = fixture();
    f.name();
    const previous = clone(f.reply.ciphertexts);
    const p = pin(f);
    f.bump();
    f.name();
    f.reply.ciphertexts = previous;
    await refused(f, p, 'SECRETS_VALUE_REFUSED');
  });
  test('T6 authenticated sharing mode and set kind cannot be flipped by the server', async () => {
    const f = fixture(),
      p = pin(f);
    f.reply.roster = { ...f.reply.roster, sharingMode: 1 };
    await refused(f, p, 'SECRETS_FORK');
    const g = fixture(17, 'fixture-project', 2);
    await refused(g, null, 'SECRETS_ROSTER_REFUSED', { ...pub(g), setKind: 1 });
  });
  test('T7 unknown and downgraded record versions are refused', async () => {
    for (const target of ['v', 'head', 'roster', 'genesis']) {
      const f = fixture(),
        p = pin(f);
      if (target === 'v') f.reply.v = 2;
      else f.reply[target] = { ...f.reply[target], v: 0 };
      await refused(f, p, 'SECRETS_FORMAT_REFUSED');
    }
  });
  test('T20 signed inbox key must derive from the unwrapped set key', async () => {
    const f = fixture(),
      p = pin(f);
    f.bump();
    f.reply.head.inboxPub = Buffer.alloc(32, 88);
    f.signHead();
    await refused(f, p, 'SECRETS_ROSTER_REFUSED');
  });
  test('T21 newer heads cannot lower a pinned name version', async () => {
    const f = fixture();
    f.name();
    f.bump();
    f.name();
    const p = pin(f);
    f.bump();
    f.reply.head.names = [{ ...f.reply.head.names[0], valueVersion: 1 }];
    f.signHead();
    await refused(f, p, 'SECRETS_ROLLBACK');
  });
  test('T23 notices are derived only from verified records; cross-project identity is locally derived', async () => {
    const f = fixture();
    f.name();
    f.reply.notice = 'UNTRUSTED_SERVER_SENTENCE';
    assert.throws(() => verifySealedReply(f.reply, null, f.request), { code: 'SECRETS_FORMAT_REFUSED' });
    delete f.reply.notice;
    await refused(f, null, 'SECRETS_ROSTER_REFUSED', { ...f.request, forgeProjectId: 'another-project' });
  });
  test('T59 project/kind pins refuse another set or genesis identity', async () => {
    for (const kind of [1, 2]) {
      const f = fixture(17, 'fixture-project', kind),
        p = pin(f),
        g = fixture(19, 'fixture-project', kind);
      f.reply = g.reply;
      f.server.rows.set('set', g.reply);
      await assertSecretReplyRefused(assert, {
        server: f.server,
        pin: p,
        request: f.request,
        code: 'SECRETS_SET_REPLACED',
        verify: async (r, t, q) => verifySealedReply(r, t, q),
      });
    }
  });
  test('T63 same-version value/author fields are immutable, permission changes are named', async () => {
    const changes = {
      kind: 2,
      valueEpoch: 2,
      changedBy: Buffer.alloc(16, 77),
      changedAt: 9999,
      proposalId: Buffer.alloc(16, 77),
      valueCommit: Buffer.alloc(32, 77),
      changeSig: Buffer.alloc(64, 77),
      ctHash: Buffer.alloc(32, 77),
    };
    for (const [field, value] of Object.entries(changes)) {
      const f = fixture();
      f.name();
      const p = pin(f);
      f.bump();
      f.reply.head.names = [{ ...f.reply.head.names[0], [field]: value }];
      f.signHead();
      await refused(f, p, 'SECRETS_ROSTER_REFUSED');
    }
    const f = fixture(17, 'fixture-project', 2);
    f.name();
    const p = pin(f);
    f.bump();
    f.reply.head.names = [{ ...f.reply.head.names[0], flags: 1, allowedChecks: ['verify'] }];
    f.signHead();
    const result = verifySealedReply(f.reply, p, f.request);
    assert(
      result.notices.some(n => n.includes('permissions changed') && n.includes(f.keys.id.toString('hex'))),
    );
  });
  test('T64 raised versions require a checked author, bounded epoch and adjacent writer attribution', async () => {
    for (const opts of [
      { changedBy: Buffer.alloc(16, 77) },
      { valueEpoch: 0 },
      { valueEpoch: 2 },
      { changeSig: Buffer.alloc(64) },
    ]) {
      const f = fixture();
      f.name();
      const p = pin(f);
      f.bump();
      const n = f.name('API_TOKEN', Buffer.from('next-synthetic-value'), opts);
      if (opts.changeSig) {
        n.changeSig = opts.changeSig;
        f.signHead();
      }
      await refused(
        f,
        p,
        opts.valueEpoch === 0
          ? 'SECRETS_FORMAT_REFUSED'
          : opts.valueEpoch === 2
            ? 'SECRETS_ROLLBACK'
            : 'SECRETS_ROSTER_REFUSED',
      );
    }
    const f = fixture(),
      other = ownerAdd(f);
    f.bump();
    f.signHead();
    const p = pin(f);
    f.bump();
    f.name('API_TOKEN', Buffer.from('next-synthetic-value'), { changedBy: other.id, signer: other });
    await refused(f, p, 'SECRETS_ROSTER_REFUSED');
  });
  test('T67 tombstones preserve version history across removal and re-addition', () => {
    const f = fixture();
    f.name();
    const p = pin(f);
    f.bump();
    const tomb = f.name('API_TOKEN', Buffer.alloc(0), { kind: 3 });
    assert.equal(tomb.valueVersion, 2);
    verifySealedReply(f.reply, p, f.request);
    f.bump();
    const live = f.name();
    assert.equal(live.valueVersion, 3);
    assert.equal(verifySealedReply(f.reply, p, f.request).secrets.length, 1);
  });
  test('T68 passkey and own-device additions cannot create a greater role', async () => {
    for (const how of [4, 5]) {
      const f = fixture(),
        member = ownerAdd(f),
        p = pin(f),
        newDevice = deviceKeys(forgeSecretId('account', 'fixture-second'), f.random);
      f.bump();
      f.transition(
        {
          added: [
            f.entry(newDevice, {
              accountId: forgeSecretId('account', 'fixture-second'),
              how,
              role: 1,
              addedBy: member.id,
              addedAtRosterVersion: f.reply.roster.rosterVersion + 1,
            }),
          ],
        },
        member,
      );
      await refused(f, p, 'SECRETS_ROSTER_REFUSED', pub(f));
    }
    const f = fixture(),
      person = personKeys(Buffer.alloc(32, 9), f.account);
    f.transition({
      added: [
        f.entry(person, { entryKind: 3, role: 4, how: 4, bindSig: Buffer.alloc(0), addedAtRosterVersion: 2 }),
      ],
    });
    const p = pin(f),
      d = deviceKeys(f.account, f.random);
    f.bump();
    f.transition(
      { added: [f.entry(d, { role: 1, how: 5, addedBy: person.id, addedAtRosterVersion: 3 })] },
      person,
    );
    await refused(f, p, 'SECRETS_ROSTER_REFUSED', pub(f));
  });
  test('T69 unpinned Checks reads walk from the Development pointer genesis, never from known entries', async () => {
    const checks = fixture(19, 'fixture-project', 2),
      dev = fixture();
    dev.transition({
      newChecksPointer: {
        checksSetId: checks.reply.roster.setId,
        checksGenesisHash: framedHash(rosterBytes(checks.reply.genesis)),
      },
    });
    const development = pin(dev),
      request = { ...pub(checks), development };
    assert.equal(verifySealedReply(checks.reply, null, request).pin.holder, false);
    checks.bump();
    checks.transition({ newSharingMode: 2 });
    checks.reply.transitions = [];
    await refused(checks, null, 'SECRETS_PIN_TOO_OLD', request);
    checks.reply.roster = { ...checks.reply.roster, rosterVersion: 66 };
    await refused(checks, null, 'SECRETS_PIN_TOO_OLD', request);
    const f = fixture(),
      member = ownerAdd(f),
      p = pin(f);
    f.bump();
    f.transition(
      { newChecksPointer: { checksSetId: Buffer.alloc(16), checksGenesisHash: Buffer.alloc(32) } },
      member,
    );
    await refused(f, p, 'SECRETS_ROSTER_REFUSED', pub(f));
  });
  test('T71 reserved flags and Checks-only fields fail before trusting a head', async () => {
    for (const field of ['setFlags', 'flags', 'allowedChecks', 'proposers']) {
      const f = fixture();
      f.name();
      const p = pin(f);
      f.bump();
      if (field === 'setFlags') f.reply.head.setFlags = 2;
      else if (field === 'proposers')
        f.reply.head.proposers = [
          { deviceId: f.keys.id, accountId: f.account, approvedBy: f.keys.id, approvedAt: 1000 },
        ];
      else f.reply.head.names = [{ ...f.reply.head.names[0], [field]: field === 'flags' ? 8 : ['verify'] }];
      f.signHead();
      await refused(f, p, 'SECRETS_FORMAT_REFUSED');
    }
  });
  test('T77 non-holder Checks pins refuse an older genuine head', async () => {
    const f = fixture(17, 'fixture-project', 2),
      old = clone(f.reply);
    f.bump();
    f.name();
    const p = pin(f);
    p.holder = false;
    Object.assign(f.reply, old);
    await refused(f, p, 'SECRETS_ROLLBACK', pub(f));
  });
  // Gate B2 M1 (Item 14314add): a write member never removes another account's entry, marked or not.
  test('T79 removal rights preserve owner devices, a member never removes another account, and markers do not invalidate pinned heads', async () => {
    const f = fixture(),
      member = ownerAdd(f),
      p = pin(f);
    f.bump();
    f.transition({ removed: [f.keys.id], epochBumped: 1 }, member);
    await refused(f, p, 'SECRETS_ROSTER_REFUSED', pub(f));
    const g = fixture(),
      q = pin(g);
    g.bump();
    g.transition({ removed: [g.keys.id], epochBumped: 1 });
    await refused(g, q, 'SECRETS_ROSTER_REFUSED', pub(g));
    const h = fixture(),
      r = pin(h);
    h.reply.revoked = [h.keys.id];
    assert.equal(verifySealedReply(h.reply, r, pub(h)).pin.head.headVersion, 1);
    for (const marker of [false, true]) {
      const x = fixture(),
        m = ownerAdd(x),
        target = ownerAdd(x, 2, 'fixture-third'),
        before = pin(x);
      x.bump();
      if (marker) x.reply.revoked = [target.id];
      x.transition({ removed: [target.id], epochBumped: 1 }, m);
      await refused(x, before, 'SECRETS_ROSTER_REFUSED', pub(x));
    }
  });
  test('T80 every added entry binds signer, transition, keys, account, kind, role and admission method', async () => {
    for (const patch of [
      { addedBy: Buffer.alloc(16, 88) },
      { addedAtRosterVersion: 99 },
      { id: Buffer.alloc(16, 88) },
      { bindSig: Buffer.alloc(64) },
      { how: 4 },
      { how: 3 },
      { how: 5 },
      { role: 3 },
      { entryKind: 2, role: 1 },
      { entryKind: 3, role: 2 },
    ]) {
      const f = fixture(),
        p = pin(f),
        d = deviceKeys(forgeSecretId('account', 'fixture-second'), f.random);
      f.bump();
      f.transition({
        added: [
          f.entry(d, {
            accountId: forgeSecretId('account', 'fixture-second'),
            role: 2,
            how: 2,
            addedAtRosterVersion: 2,
            ...patch,
          }),
        ],
      });
      await refused(f, p, 'SECRETS_ROSTER_REFUSED', pub(f));
    }
    const f = fixture(),
      p = pin(f);
    f.bump();
    f.transition({ added: [f.entry(f.keys, { how: 4, addedAtRosterVersion: 2 })] });
    await refused(f, p, 'SECRETS_ROSTER_REFUSED', pub(f));
    for (const role of [3, 4]) {
      const g = fixture(),
        q = pin(g);
      g.bump();
      g.transition({ roles: [{ id: g.keys.id, role }] });
      await refused(g, q, 'SECRETS_ROSTER_REFUSED', pub(g));
    }
  });
  test('T92 skipped changes/re-keys and newly joined devices authenticate every older-epoch value', () => {
    const f = fixture();
    f.name();
    const p = pin(f);
    f.bump();
    f.name('API_TOKEN', Buffer.from('changed-synthetic-value'));
    f.rekey();
    assert.equal(
      verifySealedReply(f.reply, p, f.request).secrets[0].value.toString(),
      'changed-synthetic-value',
    );
    assert.equal(verifySealedReply(f.reply, null, f.request).secrets.length, 1);
    f.bump();
    f.name('NEW_EPOCH_TOKEN');
    f.rekey();
    assert.equal(verifySealedReply(f.reply, null, f.request).secrets.length, 2);
    const g = fixture();
    g.name();
    g.reply.head.versionFloor = 5;
    g.signHead();
    assert.equal(verifySealedReply(g.reply, null, g.request).secrets.length, 1);
    assert.equal(
      verifySealedReply(f.reply, null, {
        ...f.request,
        machine: true,
        machineAnchor: clone(f.reply.roster),
        anchor: undefined,
        headFloor: 1,
      }).secrets.length,
      2,
    );
  });
  test('T93 former signers retain change verification and no transition authority', async () => {
    const f = fixture(),
      other = ownerAdd(f, 1);
    f.bump();
    f.name('API_TOKEN', Buffer.from('retained-synthetic-value'), { changedBy: other.id, signer: other });
    f.signHead(other);
    const p = pin(f);
    f.rekey({ removed: [other.id], epochBumped: 1 });
    assert.equal(f.reply.roster.former[0].lastEpoch, 1);
    // A skipped reader whose previous pin has no name must verify the former author's signature.
    const early = fixture();
    const genesisPin = pin(early);
    const result = verifySealedReply(f.reply, genesisPin, pub(f));
    assert(result.notices.some(n => n.includes('(removed since)')));
    f.reply.head.names = [{ ...f.reply.head.names[0], changeSig: signBytes(changeBytesFor(f), f.keys.sign) }];
    f.signHead();
    await refused(f, genesisPin, 'SECRETS_ROSTER_REFUSED', pub(f));
    const g = fixture(),
      q = pin(g);
    g.bump();
    g.transition({ droppedFormer: [Buffer.alloc(16, 99)] });
    await refused(g, q, 'SECRETS_ROSTER_REFUSED', pub(g));
    assert.equal(p.head.names.length, 1);
  });
  test('T96 floor never falls and adjacent heads raise it only by dropped tombstones', async () => {
    for (const mode of ['lower', 'raise', 'live-drop', 'over-raise']) {
      const f = fixture();
      f.name();
      if (mode === 'lower') {
        f.reply.head.versionFloor = 2;
        f.signHead();
      }
      if (mode === 'over-raise') {
        f.bump();
        f.name('API_TOKEN', Buffer.alloc(0), { kind: 3 });
      }
      const p = pin(f);
      f.bump();
      if (mode === 'lower') f.reply.head.versionFloor = 1;
      else if (mode === 'raise') f.reply.head.versionFloor = 1;
      else {
        f.reply.head.names = [];
        f.reply.head.versionFloor = mode === 'over-raise' ? 3 : 0;
      }
      f.signHead();
      await refused(f, p, 'SECRETS_ROLLBACK', pub(f));
    }
    const f = fixture();
    f.name();
    const p = pin(f);
    f.bump();
    f.bump();
    f.reply.head.names = [];
    f.reply.head.versionFloor = 2;
    f.signHead();
    assert(verifySealedReply(f.reply, p, pub(f)).notices.some(n => n.includes('did not see')));
  });
}
function changeBytesFor(f) {
  return changeBytes(f.reply.head, f.reply.head.names[0]);
}
import { changeBytes } from '../../dist/sealed-records.js';
