// SPDX-License-Identifier: Apache-2.0
// Design 4.13: the four-word code and two-word reply, for all four purposes. Pure: no IO, no network call;
// transport and the `nforge secret share` command come later. One scrypt runs per request on each side.
import { randomBytes } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { codeBytes, equalBytes, framedHash, replyBytes, type Framed } from './sealed-format.js';
import { recipientId, signBytes, verifyBytes, type RandomBytes } from './sealed-keys.js';
import {
  displayText,
  headBytes,
  repinBytes,
  rosterBytes,
  transitionBytes,
  type Delta,
  type Entry,
  type Head,
  type Roster,
  type Transition,
} from './sealed-records.js';
import { findEntry, ownerDevice, sameId, walkTransition, writeDevice } from './sealed-roster.js';
import { createTransition } from './sealed-transition.js';
import { codeConfirmedAnchor, requireConfirmedBase, type JourneyAnchor } from './sealed-anchors.js';
import { codeWords } from './sealed-words.js';
import type { SecretPin } from './sealed-verify.js';

/** 1 add, 2 raise, 3 proposer, 4 re-pin. */
export type CodePurpose = 1 | 2 | 3 | 4;
export type CodeDevice = Pick<
  Entry,
  'id' | 'accountId' | 'signPub' | 'encPub' | 'accountHandle' | 'displayName' | 'bindSig'
>;
/** What the requester posts. It never carries the code; the nonce exists only after the view was fixed. */
export type CodeRequest = {
  purpose: CodePurpose;
  projectId: Buffer;
  setId: Buffer;
  setKind: Roster['setKind'];
  rosterVersion: number;
  rosterHash: Buffer;
  device: CodeDevice;
  nonce: Buffer;
};
export type CodeApproval =
  | { purpose: 1; transition: Transition }
  | { purpose: 2; transition: Transition }
  | { purpose: 3; head: Head }
  | { purpose: 4; head: Head; signerId: Buffer; signature: Buffer };
export type Attempt = { matched: false; attemptsLeft: number };
const ATTEMPTS = 3;
const proposersCap = 100;
const exact = new Map(codeWords.map((word, index) => [word, index]));
const prefixes = new Map(codeWords.map((word, index) => [word.slice(0, 4), index]));
const lookup = (part: string) => {
  const index = exact.get(part) ?? (part.length >= 4 ? prefixes.get(part.slice(0, 4)) : undefined);
  return index !== undefined && codeWords[index]!.startsWith(part) ? index : undefined;
};

function bits(bytes: Uint8Array, offset: number) {
  let value = 0;
  for (let i = offset; i < offset + 11; i++) value = (value << 1) | ((bytes[i >> 3]! >> (7 - (i & 7))) & 1);
  return value;
}
/** The first 11·count bits as word indexes, two bytes each (the constant-time comparison form). */
const indexes = (bytes: Uint8Array, count: number) =>
  Buffer.concat(
    Array.from({ length: count }, (_, i) => {
      const out = Buffer.alloc(2);
      out.writeUInt16BE(bits(bytes, i * 11));
      return out;
    }),
  );
const words = (packed: Buffer) =>
  Array.from({ length: packed.length / 2 }, (_, i) => codeWords[packed.readUInt16BE(i * 2)]!);
/** Accepts the full words or their first four letters, any case, separated by spaces or hyphens. */
export function parseWords(typed: string, count: number): Buffer | null {
  const parts = typed
    .trim()
    .toLowerCase()
    .split(/[\s-]+/);
  if (parts.length !== count) return null;
  const found = parts.map(lookup);
  if (found.some(index => index === undefined)) return null;
  const out = Buffer.alloc(count * 2);
  found.forEach((index, i) => out.writeUInt16BE(index!, i * 2));
  return out;
}
const codeOf = (request: CodeRequest) =>
  indexes(
    codeBytes({
      purpose: request.purpose,
      projectId: request.projectId,
      setId: request.setId,
      rosterVersion: request.rosterVersion,
      rosterHash: request.rosterHash,
      accountId: request.device.accountId,
      deviceId: request.device.id,
      signPub: request.device.signPub,
      encPub: request.device.encPub,
      nonce: request.nonce,
    }),
    4,
  );
const replyOf = (purpose: CodePurpose, signed: Framed, signature: Buffer) =>
  indexes(replyBytes(purpose, signed, signature), 2);
const closed = () =>
  new ForgeError('SECRETS_CODE_CLOSED', 'This code request is closed. The new device starts a new request.');
const delta = (changes: Partial<Delta>): Delta => ({
  added: [],
  removed: [],
  roles: [],
  droppedFormer: [],
  newSharingMode: null,
  newChecksPointer: null,
  supersede: null,
  epochBumped: 0,
  ...changes,
});
/** Walk a fixed view forward through served transitions to `version`, with every reader check per step. */
function rosterAt(view: Roster, ring: readonly Transition[], version: number) {
  let at = view;
  while (at.rosterVersion < version) {
    const next = ring.find(t => t.fromVersion === at.rosterVersion);
    invariant(next, 'SECRETS_PIN_TOO_OLD', 'Secret roster history has a gap. Start a new request.');
    at = walkTransition(at, next, []);
  }
  invariant(at.rosterVersion === version, 'SECRETS_ROSTER_REFUSED', 'Approval predates this request.');
  return at;
}

/** The new (or lost) device's side: steps 1-3 and 7. */
export class CodeRequester {
  readonly request: CodeRequest;
  /** Shown to the person on this device; spoken to the holder over anything but Forge. */
  readonly words: string[];
  readonly #view: Roster;
  readonly #viewHash: Buffer;
  #attempts = ATTEMPTS;
  #open = true;
  /** `view` is the roster this device verified (4.9) or, past the ring for Checks, took as served. */
  constructor(purpose: CodePurpose, view: Roster, device: CodeDevice, random: RandomBytes = randomBytes) {
    invariant([1, 2, 3, 4].includes(purpose), 'SECRETS_FORMAT_REFUSED', 'Unknown code purpose.');
    invariant(
      sameId(device.id, recipientId(1, device.signPub, device.encPub)) && device.accountId.length === 16,
      'SECRETS_FORMAT_REFUSED',
      'Device id does not derive from its keys.',
    );
    const entry = findEntry(view, device.id);
    invariant(
      purpose === 1
        ? !entry
        : purpose === 2
          ? view.setKind === 1 && entry?.entryKind === 1 && entry.role === 2
          : purpose === 3
            ? view.setKind === 2
            : entry?.entryKind === 1,
      'SECRETS_NOT_ALLOWED',
      'This code purpose does not apply to this device and set.',
    );
    // Step 1 then step 2: the view is fixed before the nonce exists; the nonce is never reused.
    this.#view = view;
    this.#viewHash = framedHash(rosterBytes(view));
    this.request = {
      purpose,
      projectId: view.projectId,
      setId: view.setId,
      setKind: view.setKind,
      rosterVersion: view.rosterVersion,
      rosterHash: this.#viewHash,
      device,
      nonce: Buffer.from(random(16)),
    };
    this.words = words(codeOf(this.request));
  }
  /** Any other roster view closes this request: the device fetches again and starts a new one. */
  sameView(served: Roster) {
    const same = sameId(framedHash(rosterBytes(served)), this.#viewHash);
    if (!same) this.close();
    return same;
  }
  close() {
    this.#open = false;
    this.request.nonce.fill(0);
  }
  /** Step 7. `ring` is the served transition ring. A match returns the only anchor that marks a pin `code`. */
  confirm(
    typed: string,
    approval: CodeApproval,
    ring: readonly Transition[],
  ): { matched: true; anchor: JourneyAnchor } | Attempt {
    if (!this.#open) throw closed();
    invariant(
      sameId(framedHash(rosterBytes(this.#view)), this.#viewHash) &&
        approval.purpose === this.request.purpose,
      'SECRETS_ROSTER_REFUSED',
      'Approval does not answer this request.',
    );
    const expected = this.#expected(approval, ring),
      entered = parseWords(typed, 2);
    if (!entered) return { matched: false, attemptsLeft: this.#attempts };
    if (!equalBytes(entered, expected)) {
      this.#attempts--;
      if (this.#attempts > 0) return { matched: false, attemptsLeft: this.#attempts };
      this.close();
      throw closed();
    }
    this.close();
    const floor =
      approval.purpose === 4
        ? { version: approval.head.headVersion, hash: framedHash(headBytes(approval.head)) }
        : null;
    return {
      matched: true,
      anchor: codeConfirmedAnchor({ purpose: this.request.purpose, roster: this.#view, headFloor: floor }),
    };
  }
  #expected(approval: CodeApproval, ring: readonly Transition[]) {
    const device = this.request.device,
      refuse = (ok: unknown) =>
        invariant(ok, 'SECRETS_ROSTER_REFUSED', 'Approval does not answer this request.');
    if (approval.purpose === 1 || approval.purpose === 2) {
      const t = approval.transition,
        from = rosterAt(this.#view, ring, t.fromVersion);
      walkTransition(from, t, []);
      refuse(
        approval.purpose === 1
          ? t.delta.added.some(
              e =>
                sameId(e.id, device.id) &&
                sameId(e.accountId, device.accountId) &&
                sameId(e.signPub, device.signPub) &&
                sameId(e.encPub, device.encPub),
            )
          : t.delta.roles.some(r => sameId(r.id, device.id) && r.role === 1),
      );
      return replyOf(approval.purpose, transitionBytes(from, t), t.signature);
    }
    const h = approval.head,
      at = rosterAt(this.#view, ring, h.rosterVersion);
    refuse(
      sameId(h.projectId, this.request.projectId) &&
        sameId(h.setId, this.request.setId) &&
        h.setKind === this.request.setKind &&
        sameId(h.rosterHash, framedHash(rosterBytes(at))),
    );
    if (approval.purpose === 3) {
      const signer = findEntry(at, h.signerId);
      refuse(
        ownerDevice(signer) &&
          verifyBytes(headBytes(h), h.signature, signer!.signPub) &&
          h.proposers.some(p => sameId(p.deviceId, device.id) && sameId(p.accountId, device.accountId)),
      );
      return replyOf(3, headBytes(h), h.signature);
    }
    const signer = findEntry(at, approval.signerId),
      signed = repinBytes(
        this.#view,
        this.#viewHash,
        h,
        framedHash(headBytes(h)),
        device.id,
        this.request.nonce,
      );
    refuse(signer?.entryKind === 1 && verifyBytes(signed, approval.signature, signer.signPub));
    return replyOf(4, signed, approval.signature);
  }
}

export type CodeSigner = { id: Buffer; sign: Buffer };
/** The holder's side: steps 5 and 6. Its pin is this set's verified pin; Checks also needs trusted Development. */
export class CodeApprover {
  readonly #request: CodeRequest;
  readonly #pin: SecretPin;
  readonly #development: SecretPin | undefined;
  readonly #signer: CodeSigner;
  readonly #code: Buffer;
  #attempts = ATTEMPTS;
  #open = true;
  /** What a match would grant, for the person to read before typing the code. The account is the request's
   * own claim (bound by its device signature, not proven to be that person): shown, never trusted. */
  readonly grant: {
    purpose: CodePurpose;
    accountHandle: string;
    displayName: string;
    /** First 8 bytes of the device id, hex. */
    fingerprint: string;
    ownAccount: boolean;
    /** Purposes add and raise: the role the device gets (1 owner, 2 member). */
    role: 1 | 2 | null;
  };
  constructor(input: {
    request: CodeRequest;
    pin: SecretPin;
    signer: CodeSigner;
    development?: SecretPin;
    /** A person on a terminal types the code; no agent path approves. */
    person: boolean;
  }) {
    const { request, pin, signer } = input,
      r = pin.roster,
      device = request.device;
    invariant(input.person, 'PERSON_REQUIRED', 'A person types the code on a terminal: nforge secret share.');
    invariant(
      sameId(request.projectId, r.projectId) &&
        sameId(request.setId, r.setId) &&
        request.setKind === r.setKind,
      'SECRETS_NOT_ALLOWED',
      'This request is for another set.',
    );
    // GB-08 d4: what a holder signs on a match is a base for a wrap or a Checks head.
    requireConfirmedBase(pin, 'approve');
    const self = findEntry(r, signer.id),
      target = findEntry(r, device.id),
      dev = input.development?.roster;
    invariant(
      sameId(device.id, recipientId(1, device.signPub, device.encPub)) &&
        [1, 2, 3, 4].includes(request.purpose) &&
        (r.setKind === 1 ||
          (dev?.setKind === 1 && !!dev.checksPointer && sameId(dev.checksPointer.checksSetId, r.setId))),
      'SECRETS_FORMAT_REFUSED',
      'Code request is malformed.',
    );
    const own = !!self && sameId(self.accountId, device.accountId);
    const may = {
      // Development: another account's device joins by confirm only while that account has no entry.
      1:
        !target &&
        (r.setKind === 1
          ? writeDevice(self, 1) && (own || !r.entries.some(e => sameId(e.accountId, device.accountId)))
          : ownerDevice(self)),
      2: r.setKind === 1 && ownerDevice(self) && target?.entryKind === 1 && target.role === 2,
      3:
        r.setKind === 2 &&
        ownerDevice(self) &&
        dev?.entries.some(
          e => e.entryKind === 1 && sameId(e.id, device.id) && sameId(e.accountId, device.accountId),
        ) &&
        !pin.head.proposers.some(p => sameId(p.deviceId, device.id)) &&
        pin.head.proposers.length < proposersCap,
      4: self?.entryKind === 1 && target?.entryKind === 1,
    }[request.purpose];
    invariant(may, 'SECRETS_NOT_ALLOWED', 'This device has no authority to approve this request.');
    // Step 5: the requester must see exactly this device's trusted roster at R.
    const known = pin.rosterHashes.find(e => e.version === request.rosterVersion);
    invariant(
      known,
      'SECRETS_PIN_TOO_OLD',
      "The request names a roster outside this device's history. The new device starts again.",
    );
    invariant(
      equalBytes(known.hash, request.rosterHash),
      'SECRETS_CODE_ROSTER_MISMATCH',
      'The requester sees a different roster. Nothing to type; the new device fetches again.',
    );
    this.grant = {
      purpose: request.purpose,
      accountHandle: displayText(device.accountHandle),
      displayName: displayText(device.displayName),
      fingerprint: Buffer.from(device.id).subarray(0, 8).toString('hex'),
      ownAccount: own,
      role:
        request.purpose === 2
          ? 1
          : request.purpose === 1
            ? own
              ? (self!.role as 1 | 2)
              : r.setKind === 1
                ? 2
                : 1
            : null,
    };
    this.#request = request;
    this.#pin = pin;
    this.#development = input.development;
    this.#signer = signer;
    this.#code = codeOf(request);
  }
  /** Step 5-6: three attempts. On a match, the signed record for the purpose and the two reply words. */
  type(
    typed: string,
    now: number = Date.now(),
  ): { matched: true; approval: CodeApproval; roster: Roster; reply: string[] } | Attempt {
    if (!this.#open) throw closed();
    const entered = parseWords(typed, 4);
    if (!entered) return { matched: false, attemptsLeft: this.#attempts };
    if (!equalBytes(entered, this.#code)) {
      this.#attempts--;
      if (this.#attempts > 0) return { matched: false, attemptsLeft: this.#attempts };
      this.#open = false;
      throw closed();
    }
    this.#open = false;
    const { request } = this,
      pin = this.#pin;
    if (request.purpose === 1 || request.purpose === 2) {
      const built = createTransition(pin.roster, this.#change(), this.#signer, {
        ...(this.#development ? { development: this.#development.roster } : {}),
        person: true,
      });
      return {
        matched: true,
        approval: { purpose: request.purpose, transition: built.transition },
        roster: built.roster,
        reply: words(
          replyOf(request.purpose, transitionBytes(pin.roster, built.transition), built.transition.signature),
        ),
      };
    }
    if (request.purpose === 3) {
      const head: Head = {
        ...pin.head,
        headVersion: pin.head.headVersion + 1,
        prevHeadHash: framedHash(headBytes(pin.head)),
        proposers: [
          ...pin.head.proposers,
          {
            deviceId: request.device.id,
            accountId: request.device.accountId,
            approvedBy: this.#signer.id,
            approvedAt: now,
          },
        ],
        signerId: this.#signer.id,
        signedAt: now,
        signature: Buffer.alloc(64),
      };
      head.signature = signBytes(headBytes(head), this.#signer.sign);
      return {
        matched: true,
        approval: { purpose: 3, head },
        roster: pin.roster,
        reply: words(replyOf(3, headBytes(head), head.signature)),
      };
    }
    const signed = repinBytes(
      { ...pin.roster, rosterVersion: request.rosterVersion },
      request.rosterHash,
      pin.head,
      framedHash(headBytes(pin.head)),
      request.device.id,
      request.nonce,
    );
    const signature = signBytes(signed, this.#signer.sign);
    return {
      matched: true,
      approval: { purpose: 4, head: pin.head, signerId: this.#signer.id, signature },
      roster: pin.roster,
      reply: words(replyOf(4, signed, signature)),
    };
  }
  get request() {
    return this.#request;
  }
  #change(): Delta {
    const r = this.#pin.roster,
      d = this.#request.device,
      self = findEntry(r, this.#signer.id)!;
    if (this.#request.purpose === 2) return delta({ roles: [{ id: d.id, role: 1 }] });
    // 4.8: own further device gets the signer's role (own-device); another account's device is a Development
    // member by confirm, or a Checks owner by owner-add (its account needs a Development owner device).
    const own = sameId(d.accountId, self.accountId);
    const entry: Entry = {
      entryKind: 1,
      id: d.id,
      encPub: d.encPub,
      signPub: d.signPub,
      accountId: d.accountId,
      accountHandle: displayText(d.accountHandle),
      displayName: displayText(d.displayName),
      role: own ? self.role : r.setKind === 1 ? 2 : 1,
      addedBy: this.#signer.id,
      how: own ? 4 : r.setKind === 1 ? 2 : 6,
      addedAtRosterVersion: r.rosterVersion + 1,
      bindSig: d.bindSig,
    };
    return delta({ added: [entry] });
  }
}
