// SPDX-License-Identifier: Apache-2.0
// GB-08 d5 (Gate B1 C9-C12): when a Checks or Production roster breaks the cross-set rule, values stay
// refused and one write is allowed. A full owner device of that set whose own account passes the rule removes
// the offending entries, and every entry they added (transitively) unless the person keeps it by name, and
// re-keys in the same mutation. Pure: the caller publishes the result in one CAS write.
import { invariant } from './errors.js';
import { type RandomBytes } from './sealed-keys.js';
import type { Delta } from './sealed-records.js';
import { findEntry, ownerDevice, sameId } from './sealed-roster.js';
import { rekeySet } from './sealed-rekey.js';
import { createTransition } from './sealed-transition.js';
import { verifyRepair, type SealedReply, type SecretPin, type VerifyRequest } from './sealed-verify.js';

const hex = (id: Uint8Array) => Buffer.from(id).toString('hex');

export function repairSet(input: {
  reply: SealedReply;
  /** The repairer's pin, at or before the breaking roster. */
  pin: SecretPin;
  /** Must name the repairer as recipient and carry trusted Development. */
  request: VerifyRequest;
  signer: { id: Buffer; sign: Buffer };
  /** Display names or hex ids of entries an offending device added that the person keeps. */
  keep?: readonly string[];
  person: boolean;
  now?: number;
  random?: RandomBytes;
}) {
  invariant(input.person, 'PERSON_REQUIRED', 'A person repairs a Checks roster on a terminal.');
  const view = verifyRepair(input.reply, input.pin, input.request);
  try {
    const r = view.roster,
      offending = new Set(view.offending.map(hex));
    const eligible = (id: Uint8Array) => {
      const entry = findEntry(r, id);
      return ownerDevice(entry) && !offending.has(hex(id));
    };
    // Gate B1 C11: with no eligible owner left nobody can sign the repair; the set is replaced (4.18).
    invariant(
      r.entries.some(e => eligible(e.id)),
      'SECRETS_ROSTER_REFUSED',
      'Checks owner account has no Development owner device, and no Checks owner device remains that passes this rule. Replace the Checks set from a Development owner device; members then confirm their proposer code again.',
    );
    invariant(
      eligible(input.signer.id) && sameId(input.request.recipient!.id, input.signer.id),
      'SECRETS_ROSTER_REFUSED',
      'Checks owner account has no Development owner device. Repair from a Checks owner device whose account has a Development owner device.',
    );
    // Everything the offending devices added, transitively through addedBy, minus the kept ids.
    const closure = (kept: Set<string>) => {
      const removed = new Set(offending);
      for (let grew = true; grew;) {
        grew = false;
        for (const e of r.entries)
          if (!removed.has(hex(e.id)) && removed.has(hex(e.addedBy)) && !kept.has(hex(e.id))) {
            removed.add(hex(e.id));
            grew = true;
          }
      }
      return removed;
    };
    const candidates = closure(new Set());
    // A kept name must name exactly one entry in the whole roster (display names are chosen by whoever
    // added the entry), and that entry must be one this repair removes and not itself offending.
    const keep = new Set(
      (input.keep ?? []).map(token => {
        const matches = r.entries.filter(e => e.displayName === token || hex(e.id) === token);
        invariant(
          matches.length === 1,
          'SECRETS_NOT_ALLOWED',
          matches.length
            ? 'More than one entry has this name. Keep it by its id.'
            : 'No entry has this name or id.',
        );
        const id = hex(matches[0]!.id);
        invariant(
          candidates.has(id) && !offending.has(id),
          'SECRETS_NOT_ALLOWED',
          offending.has(id)
            ? 'An offending device cannot be kept.'
            : 'This repair does not remove that entry.',
        );
        return id;
      }),
    );
    const removed = closure(keep);
    invariant(
      !removed.has(hex(input.signer.id)),
      'SECRETS_ROSTER_REFUSED',
      'An offending device added this device. Keep it by name, or repair from another Checks owner device.',
    );
    const gone = r.entries.filter(e => removed.has(hex(e.id))),
      named = new Set(view.head.names.map(n => hex(n.changedBy)));
    const delta: Delta = {
      added: [],
      removed: gone.map(e => e.id),
      roles: [],
      // 4.6: former signers that no head record names leave the list in the same step.
      droppedFormer: [
        ...r.former.map(e => e.deviceId),
        ...gone.filter(e => e.entryKind === 1).map(e => e.id),
      ].filter(id => !named.has(hex(id))),
      newSharingMode: null,
      newChecksPointer: null,
      supersede: null,
      epochBumped: 1,
    };
    const built = createTransition(r, delta, input.signer, {
      development: input.request.development!.roster,
      person: true,
    });
    const rekeyed = rekeySet({
      from: r,
      head: view.head,
      key: view.key,
      ciphertexts: input.reply.ciphertexts,
      next: built.roster,
      signer: input.signer,
      now: input.now ?? Date.now(),
      ...(input.random ? { random: input.random } : {}),
      // C10: approvals a removed device made go with it; the proposer redoes its code with an honest owner.
      proposers: view.head.proposers.filter(p => !removed.has(hex(p.approvedBy))),
    });
    return {
      transition: built.transition,
      roster: built.roster,
      ...rekeyed,
      removed: gone.map(e => ({ id: e.id, displayName: e.displayName, offending: offending.has(hex(e.id)) })),
      droppedProposers: view.head.proposers.filter(p => removed.has(hex(p.approvedBy))).map(p => p.deviceId),
      // Values a removed device wrote stay (re-sealed, signatures kept); the person reviews them.
      writtenByRemoved: view.head.names
        .filter(n => n.kind !== 3 && removed.has(hex(n.changedBy)))
        .map(n => n.name),
    };
  } finally {
    view.key.fill(0);
  }
}
