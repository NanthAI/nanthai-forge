// SPDX-License-Identifier: Apache-2.0
// Design 5.5 re-key, as one all-or-nothing build: a new random set key, every live value re-sealed under it
// with its version, epoch, author, signature and `r` kept, a wrap for every remaining recipient and the next
// head. Pure: the caller publishes the transition, head, ciphertexts and wraps in one mutation.
import { randomBytes } from 'node:crypto';
import { invariant } from './errors.js';
import { equalBytes, framedHash } from './sealed-format.js';
import {
  inboxKeys,
  keyCommit,
  signBytes,
  wrapSetKey,
  type KeyWrap,
  type RandomBytes,
} from './sealed-keys.js';
import { headBytes, rosterBytes, type Head, type Roster } from './sealed-records.js';
import { openValue, sealValue } from './sealed-value.js';

export function rekeySet(input: {
  /** The verified roster, head and set key the values are sealed under now. */
  from: Roster;
  head: Head;
  key: Buffer;
  ciphertexts: readonly { name: string; stored: Buffer }[];
  /** The roster after the signed transition that bumped the epoch. */
  next: Roster;
  signer: { id: Buffer; sign: Buffer };
  now: number;
  random?: RandomBytes;
  /** The next head's proposers when the step drops some (repair); otherwise kept as they are. */
  proposers?: Head['proposers'];
}) {
  const { from, head, next } = input,
    random = input.random ?? randomBytes;
  invariant(
    next.epoch === from.epoch + 1 && head.epoch === from.epoch,
    'SECRETS_FORMAT_REFUSED',
    'A re-key seals under the next epoch.',
  );
  const key = Buffer.from(random(32));
  try {
    const ciphertexts: { name: string; stored: Buffer }[] = [];
    const names = head.names.map(n => {
      if (n.kind === 3) return { ...n, sealEpoch: next.epoch };
      const stored = input.ciphertexts.find(c => c.name === n.name)?.stored;
      invariant(stored, 'SECRETS_VALUE_REFUSED', 'A signed ciphertext is missing.');
      const ctx = (epoch: number) => ({
        projectId: from.projectId,
        setId: from.setId,
        epoch,
        name: n.name,
        kind: n.kind as 1 | 2,
        valueVersion: n.valueVersion,
        valueEpoch: n.valueEpoch,
        sealEpoch: epoch,
      });
      const opened = openValue(input.key, ctx(from.epoch), stored, n);
      try {
        const sealed = sealValue(key, ctx(next.epoch), opened.value, {
          r: opened.r,
          random,
        });
        invariant(
          equalBytes(sealed.valueCommit, n.valueCommit),
          'SECRETS_VALUE_REFUSED',
          'Re-sealed value lost its commitment.',
        );
        ciphertexts.push({ name: n.name, stored: sealed.stored });
        return { ...n, sealEpoch: next.epoch, ctHash: sealed.ctHash };
      } finally {
        opened.value.fill(0);
        opened.r.fill(0);
      }
    });
    const wraps: KeyWrap[] = next.entries.map(e =>
      wrapSetKey(key, next, { id: e.id, encPub: e.encPub, kind: e.entryKind }, random),
    );
    const inbox = inboxKeys(key, next);
    inbox.privateKey.fill(0);
    const nextHead: Head = {
      ...head,
      headVersion: head.headVersion + 1,
      prevHeadHash: framedHash(headBytes(head)),
      rosterVersion: next.rosterVersion,
      rosterHash: framedHash(rosterBytes(next)),
      epoch: next.epoch,
      commit: keyCommit(key, next),
      inboxPub: inbox.publicKey,
      names,
      proposers: input.proposers ?? head.proposers,
      signerId: input.signer.id,
      signedAt: input.now,
      signature: Buffer.alloc(64),
    };
    nextHead.signature = signBytes(headBytes(nextHead), input.signer.sign);
    // A re-key drops every pending proposal in the same mutation (4.11): the caller publishes none.
    return { head: nextHead, ciphertexts, wraps };
  } finally {
    key.fill(0);
  }
}
