// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { serialize, deserialize } from 'node:v8';
import { fixture } from './sealed-fixture.mjs';
import { deviceKeys, recipientId } from '../../dist/sealed-keys.js';
import { forgeSecretId, framedHash } from '../../dist/sealed-format.js';
import { rosterBytes, headBytes } from '../../dist/sealed-records.js';
const clone = x => deserialize(serialize(x));
// A names-only reader holds no keys of the set; for Checks it walks from the pointer's genesis.
const pub = f => {
  const { recipient, ...request } = f.request;
  return request.setKind === 2 ? { ...request, anchor: { kind: 'checks-genesis' } } : request;
};
function added(f, accountName = 'second', role = 1) {
  const accountId = forgeSecretId('account', accountName),
    d = deviceKeys(accountId, f.random);
  f.transition({
    added: [
      f.entry(d, {
        accountId,
        role,
        how: role === 1 ? 6 : 2,
        addedAtRosterVersion: f.reply.roster.rosterVersion + 1,
      }),
    ],
  });
  return d;
}
function denied(verify, f, p, code, message, request = pub(f)) {
  assert.throws(
    () => verify(f.reply, p, request),
    e => e.code === code && (!message || e.message === message),
  );
}
export const reviewCases = {
  'T2 machine transition fails on signer authority with a genuine chained hash'(verify) {
    const f = fixture(17, 'fixture-project', 2),
      d = deviceKeys(f.account, f.random);
    d.id = recipientId(2, Buffer.alloc(0), d.encPub);
    f.transition({
      added: [
        f.entry(d, {
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
    const p = clone(f.pin());
    f.bump();
    f.transition({}, d);
    denied(verify, f, p, 'SECRETS_ROSTER_REFUSED', 'Roster transition signer is not authorized.');
  },
  'T2 member transition fails on signer authority with a genuine chained hash'(verify) {
    const f = fixture(17, 'fixture-project', 2),
      dev = fixture(),
      member = added(dev, 'member', 2);
    dev.transition({ newChecksPointer: f.request.development.roster.checksPointer });
    f.request.development = dev.pin();
    const p = clone(f.pin());
    f.bump();
    f.transition({}, member);
    denied(verify, f, p, 'SECRETS_ROSTER_REFUSED', 'Roster transition signer is not authorized.');
  },
  'T64 changedBy has no write authority in Checks despite a valid Development owner signature'(verify) {
    const f = fixture(17, 'fixture-project', 2),
      dev = fixture(),
      author = added(dev);
    dev.transition({ newChecksPointer: f.request.development.roster.checksPointer });
    const p = clone(f.pin());
    f.bump();
    f.bump();
    f.name('API_TOKEN', Buffer.from('synthetic-author-value'), { changedBy: author.id, signer: author });
    denied(verify, f, p, 'SECRETS_ROSTER_REFUSED', 'Unknown author or invalid change signature.', {
      ...pub(f),
      development: dev.pin(),
    });
  },
  'T64 adjacent change cannot use an author found only in former signers'(verify) {
    const f = fixture(),
      p = clone(f.pin()),
      former = added(f);
    f.rekey({ removed: [former.id], epochBumped: 1 });
    f.name('API_TOKEN', Buffer.from('synthetic-former-value'), {
      changedBy: former.id,
      signer: former,
      valueEpoch: 1,
    });
    f.reply.head.prevHeadHash = framedHash(headBytes(p.head));
    f.signHead();
    denied(verify, f, p, 'SECRETS_ROSTER_REFUSED', 'Adjacent change does not match its author and epoch.');
  },
  'T64 non-former author cannot change below a non-zero pinned epoch at a skipped head'(verify) {
    const f = fixture();
    f.rekey();
    const p = clone(f.pin());
    f.bump();
    f.bump();
    f.name('API_TOKEN', Buffer.from('synthetic-old-epoch'), { valueEpoch: 1 });
    denied(verify, f, p, 'SECRETS_ROLLBACK', 'Change epoch is outside its authenticated history.');
  },
  'T69 old set to a pinned member fails after pointer change without a replacement record'(verify) {
    const old = fixture(17, 'fixture-project', 2),
      fresh = fixture(19, 'fixture-project', 2),
      dev = fixture();
    const p = clone(old.pin());
    p.holder = false;
    dev.transition({
      newChecksPointer: {
        checksSetId: fresh.reply.roster.setId,
        checksGenesisHash: framedHash(rosterBytes(fresh.reply.genesis)),
      },
    });
    const request = { ...pub(old), development: dev.pin() };
    denied(verify, old, p, 'SECRETS_SET_REPLACED', undefined, request);
    assert.deepEqual(verify(fresh.reply, null, request).pin.roster.setId, fresh.reply.roster.setId);
    for (const pointer of [
      {
        checksSetId: old.reply.roster.setId,
        checksGenesisHash: framedHash(rosterBytes(fresh.reply.genesis)),
      },
      {
        checksSetId: fresh.reply.roster.setId,
        checksGenesisHash: framedHash(rosterBytes(old.reply.genesis)),
      },
    ]) {
      dev.transition({ newChecksPointer: pointer });
      denied(verify, old, p, 'SECRETS_SET_REPLACED', undefined, { ...request, development: dev.pin() });
    }
  },
  'T69 right set and genesis cannot hide a current roster the present chain does not reach'(verify) {
    const f = fixture(17, 'fixture-project', 2);
    f.transition({});
    f.reply.roster = {
      ...f.reply.roster,
      entries: f.reply.roster.entries.map(e => ({ ...e, displayName: 'unreached' })),
    };
    f.reply.head.rosterHash = framedHash(rosterBytes(f.reply.roster));
    f.signHead();
    denied(verify, f, null, 'SECRETS_FORK', 'Current roster differs from the trusted chain.');
  },
  'T80 confirm cannot add a first device for an account already in the roster'(verify) {
    const f = fixture();
    added(f, 'member', 2);
    const p = clone(f.pin());
    const accountId = forgeSecretId('account', 'member'),
      d = deviceKeys(accountId, f.random);
    f.bump();
    f.transition({ added: [f.entry(d, { accountId, role: 2, how: 2, addedAtRosterVersion: 3 })] });
    denied(verify, f, p, 'SECRETS_ROSTER_REFUSED', 'First-device addition is invalid.');
  },
  'T80 automatic addition is refused in Checks at admission authority'(verify) {
    const f = fixture(17, 'fixture-project', 2),
      p = clone(f.pin()),
      accountId = forgeSecretId('account', 'member');
    const d = deviceKeys(accountId, f.random);
    f.bump();
    f.transition({ added: [f.entry(d, { accountId, role: 2, how: 3, addedAtRosterVersion: 2 })] });
    denied(verify, f, p, 'SECRETS_ROSTER_REFUSED', 'First-device addition is invalid.');
  },
  'T80 owner-add signed by a member cannot create an owner device'(verify) {
    const f = fixture(),
      member = added(f, 'member', 2),
      p = clone(f.pin());
    const accountId = forgeSecretId('account', 'third'),
      d = deviceKeys(accountId, f.random);
    f.bump();
    f.transition(
      { added: [f.entry(d, { accountId, role: 1, how: 6, addedBy: member.id, addedAtRosterVersion: 3 })] },
      member,
    );
    denied(verify, f, p, 'SECRETS_ROSTER_REFUSED', 'Owner addition requires a full owner device.');
  },
};
