// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { randomBytes } from 'node:crypto';
import { forgeSecretId, framedHash } from './sealed-format.js';
import { inboxKeys, keyCommit, signBytes, wrapSetKey, type DeviceKeys } from './sealed-keys.js';
import { headBytes, rosterBytes, type Entry, type Roster } from './sealed-records.js';
import type { SealedReply } from './sealed-verify.js';

export function newSealedSet(
  project: string,
  account: string,
  keys: DeviceKeys,
  now: number,
  kind: 1 | 2 = 1,
) {
  const projectId = forgeSecretId('project', project),
    setId = randomBytes(16),
    key = randomBytes(32);
  const entry: Entry = {
    entryKind: 1,
    id: keys.id,
    encPub: keys.encPub,
    signPub: keys.signPub,
    accountId: forgeSecretId('account', account),
    accountHandle: '',
    displayName: 'this device',
    role: 1,
    addedBy: keys.id,
    how: 1,
    addedAtRosterVersion: 1,
    bindSig: keys.bindSig,
  };
  const roster: Roster = {
    v: 1,
    projectId,
    setId,
    setKind: kind,
    // Owner decision 2 (design 3, 4.8): Development starts in Automatic; the owner may switch it to Confirm.
    // Checks is Confirm only (a constant): its recipients are owner devices and machines.
    sharingMode: kind === 1 ? 1 : 2,
    checksPointer: null,
    rosterVersion: 1,
    epoch: 1,
    prevRosterHash: Buffer.alloc(32),
    entries: [entry],
    former: [],
  };
  const inbox = inboxKeys(key, roster);
  try {
    const reply: SealedReply = {
      v: 1,
      genesis: roster,
      roster,
      transitions: [],
      ciphertexts: [],
      wraps: [wrapSetKey(key, roster, { id: keys.id, encPub: keys.encPub, kind: 1 })],
      revoked: [],
      supersede: null,
      proposals: [],
      head: {
        v: 1,
        projectId,
        setId,
        setKind: kind,
        headVersion: 1,
        prevHeadHash: Buffer.alloc(32),
        rosterVersion: 1,
        rosterHash: framedHash(rosterBytes(roster)),
        epoch: 1,
        commit: keyCommit(key, roster),
        inboxPub: inbox.publicKey,
        versionFloor: 0,
        setFlags: 0,
        proposers: [],
        names: [],
        signerId: keys.id,
        signedAt: now,
        signature: Buffer.alloc(64),
      },
    };
    reply.head.signature = signBytes(headBytes(reply.head), keys.sign);
    return { reply, key };
  } finally {
    inbox.privateKey.fill(0);
  }
}
