// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The public checks of a signed head against its verified roster: one implementation, run by every reader
// (sealed-verify) and by the server before it stores a head (convex/sealedSecretGate, Gate B1 C20). No Buffer
// and no node: builtins, so it runs inside a Convex mutation. Nothing here opens a value or needs a key.
import { invariant } from './errors.js';
import { ciphertextHash, equalBytes, framedHash, hex, verifyBytes } from './sealed-portable.js';
import { changeBytes, headBytes, rosterBytes, type Head, type Roster } from './sealed-records.js';
import { findEntry, sameId, writeDevice } from './sealed-roster.js';
import { safeSecretName } from './sealed-display.js';

export type HeadContext = {
  /** The trusted head and roster this head follows: a reader's pin, or the server's stored record. */
  pinned: { head: Head; roster: Roster } | null;
  /** Server-owned removal markers on this set. */
  revoked: readonly Uint8Array[];
  headFloor?: number;
  machine?: boolean;
  /** Checks proposals are authored in Development: its trusted roster and markers. */
  development?: Roster;
  developmentRevoked?: readonly Uint8Array[];
  /** 4.13 step 7 (GB-08 a): after a proposer or re-pin code the holder's head is the floor. */
  codeFloor?: { version: number; hash: Uint8Array } | null;
};
const refuse = (ok: unknown, rule: string) => invariant(ok, 'SECRETS_ROSTER_REFUSED', rule);
const rollback = (ok: unknown, rule: string) => invariant(ok, 'SECRETS_ROLLBACK', rule);

/** Signer authority, roster binding, rollback and per-name rules of head `h` on verified roster `r`. Returns the
 * notices a reader prints; the server ignores them. */
export function checkSignedHead(h: Head, r: Roster, c: HeadContext): string[] {
  const notices: string[] = [],
    pin = c.pinned;
  const headHash = framedHash(headBytes(h)),
    pinnedHash = pin ? framedHash(headBytes(pin.head)) : null;
  const sameHead = !!pin && h.headVersion === pin.head.headVersion && sameId(headHash, pinnedHash!);
  const adjacent = !!pin && h.headVersion === pin.head.headVersion + 1;
  const signer = findEntry(r, h.signerId);
  refuse(
    writeDevice(signer, r.setKind) &&
      verifyBytes(headBytes(h), h.signature, signer!.signPub) &&
      (sameHead || !c.revoked.some(id => sameId(id, h.signerId))),
    'Head signer lacks current write authority.',
  );
  refuse(
    h.rosterVersion === r.rosterVersion &&
      sameId(h.rosterHash, framedHash(rosterBytes(r))) &&
      h.epoch === r.epoch,
    'Head does not match the verified roster.',
  );
  rollback(h.headVersion >= (pin?.head.headVersion ?? c.headFloor ?? 1), 'Head is older than the pin.');
  if (pin && h.headVersion === pin.head.headVersion)
    invariant(sameHead, 'SECRETS_FORK', 'Different head at the pinned version.');
  if (c.codeFloor) {
    rollback(h.headVersion >= c.codeFloor.version, 'Head is older than the code-confirmed floor.');
    if (h.headVersion === c.codeFloor.version)
      invariant(
        sameId(headHash, c.codeFloor.hash),
        'SECRETS_FORK',
        'Different head at the code-confirmed floor version.',
      );
  }
  if (adjacent)
    invariant(sameId(h.prevHeadHash, pinnedHash!), 'SECRETS_FORK', 'Head does not extend the pinned head.');
  invariant(
    Number.isSafeInteger(h.setFlags) &&
      h.setFlags >= 0 &&
      h.setFlags <= 1 &&
      (r.setKind === 2 || (h.setFlags === 0 && h.proposers.length === 0)) &&
      h.names.length <= 400 &&
      h.names.filter(n => n.kind !== 3).length <= 200 &&
      new Set(h.names.map(n => n.name)).size === h.names.length,
    'SECRETS_FORMAT_REFUSED',
    'Head fields exceed format bounds.',
  );
  rollback(h.versionFloor >= (pin?.head.versionFloor ?? 0), 'Version floor is older than the pin.');
  const missing = pin?.head.names.filter(old => !h.names.some(n => n.name === old.name)) ?? [];
  if (adjacent) {
    rollback(
      missing.every(n => n.kind === 3),
      'Live names must leave a tombstone.',
    );
    rollback(
      h.versionFloor === Math.max(pin!.head.versionFloor, ...missing.map(n => n.valueVersion)),
      'Version floor may rise only by dropped tombstones.',
    );
  }
  for (const old of missing) {
    if (!adjacent)
      rollback(
        old.valueVersion < h.versionFloor || (old.kind === 3 && old.valueVersion === h.versionFloor),
        'A pinned name disappeared above the floor.',
      );
    notices.push(
      `${safeSecretName(old.name)} left the set in a head this device did not see; head signed by ${hex(h.signerId)}.`,
    );
  }
  for (const n of h.names) {
    const safeName = safeSecretName(n.name);
    invariant(
      [1, 2, 3].includes(n.kind) &&
        n.valueVersion >= 1 &&
        n.valueEpoch >= 1 &&
        n.sealEpoch === h.epoch &&
        Number.isSafeInteger(n.flags) &&
        n.flags >= 0 &&
        n.flags <= 7 &&
        (r.setKind === 2 || (n.flags % 2 === 0 && n.allowedChecks.length === 0)) &&
        (n.kind === 3
          ? n.ctHash.length === 0 && n.valueCommit.length === 0
          : n.ctHash.length === 32 && n.valueCommit.length === 32),
      'SECRETS_FORMAT_REFUSED',
      'Name record fields exceed format bounds.',
    );
    const old = pin?.head.names.find(value => value.name === n.name);
    if (old && old.valueVersion === n.valueVersion) {
      refuse(
        old.kind === n.kind &&
          old.valueEpoch === n.valueEpoch &&
          sameId(old.changedBy, n.changedBy) &&
          old.changedAt === n.changedAt &&
          sameId(old.proposalId, n.proposalId) &&
          sameId(old.valueCommit, n.valueCommit) &&
          sameId(old.changeSig, n.changeSig) &&
          (old.sealEpoch !== n.sealEpoch || sameId(old.ctHash, n.ctHash)),
        'Same-version value or author fields changed.',
      );
      if (old.flags !== n.flags || JSON.stringify(old.allowedChecks) !== JSON.stringify(n.allowedChecks))
        notices.push(`${safeName} permissions changed; head signed by ${hex(h.signerId)}.`);
    } else {
      rollback(!old || n.valueVersion > old.valueVersion, 'Name version is older than the pin.');
      rollback(n.valueVersion > (pin?.head.versionFloor ?? 0), 'Name version is below the pinned floor.');
      const proposal = n.proposalId.length > 0,
        authorRoster = proposal && r.setKind === 2 ? c.development : r;
      const author = authorRoster && findEntry(authorRoster, n.changedBy),
        former = authorRoster?.former.find(e => sameId(e.deviceId, n.changedBy));
      const fallback = proposal && r.setKind === 2 && !author && !former;
      const markers = proposal && r.setKind === 2 ? (c.developmentRevoked ?? []) : c.revoked;
      refuse(
        fallback || !markers.some(id => sameId(id, n.changedBy)),
        'A revoked change signer has no new authority.',
      );
      refuse(
        fallback ||
          ((author?.entryKind === 1 || former) &&
            verifyBytes(changeBytes(h, n), n.changeSig, author?.signPub ?? former!.signPub)),
        'Unknown author or invalid change signature.',
      );
      refuse(proposal || former || writeDevice(author, r.setKind), 'Change author lacks write authority.');
      rollback(
        n.valueEpoch >= (c.machine ? 0 : (pin?.head.epoch ?? 0)) &&
          n.valueEpoch <= h.epoch &&
          (!former || (proposal && r.setKind === 2) || n.valueEpoch <= former.lastEpoch),
        'Change epoch is outside its authenticated history.',
      );
      if (adjacent && !(proposal && r.setKind === 2)) {
        refuse(
          n.valueEpoch === h.epoch &&
            (findEntry(r, n.changedBy)?.entryKind === 1 ||
              (pin && findEntry(pin.roster, n.changedBy)?.entryKind === 1)) &&
            (proposal || sameId(n.changedBy, h.signerId)),
          'Adjacent change does not match its author and epoch.',
        );
      }
      const authorLabel = `${hex(n.changedBy)}${former ? ' (removed since)' : ''}`;
      notices.push(
        fallback
          ? `${safeName}: proposed by a device not in this device's Development roster; not checked against Development; head signed by ${hex(h.signerId)}.`
          : `${safeName}: ${proposal ? 'proposed' : 'changed'} by ${authorLabel}${sameId(n.changedBy, h.signerId) ? '' : adjacent ? `, applied by ${hex(h.signerId)}` : `; head signed by ${hex(h.signerId)}`}.`,
      );
    }
  }
  // Gate B3a review M2: a reader with no pin or an older one re-checks every record's author, so each must still be a
  // device on the roster or a former signer, tombstones included (a Checks proposal is authored in Development).
  for (const n of h.names)
    refuse(
      (n.proposalId.length > 0 && r.setKind === 2) ||
        findEntry(r, n.changedBy)?.entryKind === 1 ||
        r.former.some(e => sameId(e.deviceId, n.changedBy)),
      'A record names an author that is neither on the roster nor a former signer.',
    );
  return notices;
}

/** The public consistency of a head's sealed contents (Gate B1 C20): each ciphertext names one live record and
 * matches its signed hash, every live record has its ciphertext, and wraps name distinct roster recipients.
 * Without these a head could be stored whose values no reader can open. */
export function checkSealedContents(
  h: Head,
  r: Roster,
  ciphertexts: readonly { name: string; stored: Uint8Array }[],
  wraps: readonly { recipientId: Uint8Array }[],
) {
  const live = new Map(h.names.filter(n => n.kind !== 3).map(n => [n.name, n]));
  const stored = new Map(ciphertexts.map(c => [c.name, c.stored]));
  invariant(
    stored.size === ciphertexts.length && ciphertexts.every(c => live.has(c.name)),
    'SECRETS_VALUE_REFUSED',
    'Ciphertexts must name exactly one live signed record.',
  );
  invariant(
    new Set(wraps.map(w => hex(w.recipientId))).size === wraps.length &&
      wraps.every(w => findEntry(r, w.recipientId)),
    'SECRETS_WRAP_REFUSED',
    'Wraps must name distinct roster recipients.',
  );
  for (const [name, n] of live) {
    const bytes = stored.get(name);
    invariant(bytes, 'SECRETS_VALUE_REFUSED', 'A signed ciphertext is missing.');
    invariant(
      bytes.length >= 316 && equalBytes(ciphertextHash(name, bytes), n.ctHash),
      'SECRETS_VALUE_REFUSED',
      'Ciphertext does not match the signed record.',
    );
  }
}
