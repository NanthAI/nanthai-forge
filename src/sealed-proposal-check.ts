// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The public checks on a proposal record, which need no key. Portable: the holder that opens a proposal
// (src/sealed-proposal.ts) and the server that stores one (convex/sealedSecretGate.ts proposalFacts) run this same code.
import { invariant } from './errors.js';
import { ciphertextHash, equalBytes, verifyBytes } from './sealed-portable.js';
import { proposalBytes, type SealedProposal } from './sealed-future-records.js';
import type { Head, Roster } from './sealed-records.js';
import { findEntry, sameId } from './sealed-roster.js';
import { secretNameKind } from './secret-names.js';

/** A proposal ciphertext is one value bucket plus the 16-byte tag: bucketSize(0) + 16 to bucketSize(65536) + 16. */
export const PROPOSAL_CIPHERTEXT = { min: 272, max: 69648 };
const notAllowed = (ok: unknown, message: string) => invariant(ok, 'SECRETS_NOT_ALLOWED', message);
/** A name a secret may have: never an invalid or denied one. */
export const acceptedName = (name: string) => ['routing', 'credential'].includes(secretNameKind(name));

export type ProposalAuthority = {
  roster: Roster;
  head: Head;
  /** Server-owned removal markers on this set. */
  revoked: readonly Uint8Array[];
  /** Checks only: the trusted Development roster and its markers, where proposals are authored. */
  development?: Roster;
  developmentRevoked?: readonly Uint8Array[];
};
/** Who may author a proposal on this set: a device of the set's own roster for Development; for Checks a device of
 * the trusted Development roster that the Checks head lists as an approved proposer (GB-08 e). */
export function proposalAuthor(r: Roster, h: Head, id: Uint8Array, development?: Roster) {
  notAllowed(r.setKind !== 3, 'Production takes no proposals.');
  notAllowed(
    r.setKind === 1 ? !development : development && h.proposers.some(p => sameId(p.deviceId, id)),
    r.setKind === 1
      ? 'A Development proposal is authored on the Development roster.'
      : 'Only an approved Checks proposer proposes. Ask a Checks owner for a proposer code.',
  );
  const author = findEntry(development ?? r, id);
  notAllowed(author?.entryKind === 1, 'Only a device on the roster proposes a change.');
  return author!;
}
/** The proposal's author on this view: listed, allowed to propose, and not marked for removal. */
export function currentAuthor(view: ProposalAuthority, p: SealedProposal) {
  const author = proposalAuthor(view.roster, view.head, p.proposerId, view.development);
  const markers = view.roster.setKind === 1 ? view.revoked : (view.developmentRevoked ?? []);
  notAllowed(!markers.some(id => sameId(id, p.proposerId)), 'Forge marked this proposer for removal.');
  return author;
}
/** Everything about a schema-checked proposal that needs no key: the current epoch, an allowed unmarked author,
 * operation, kind and commitment shape, an accepted name, the ciphertext bounds and digest, and the proposal
 * signature. Returns the author. */
export function checkProposal(view: ProposalAuthority, p: SealedProposal) {
  const { roster: r, head: h } = view;
  invariant(
    p.epoch === r.epoch && h.epoch === r.epoch,
    'WORK_CONFLICT',
    'This proposal was made before the set was re-keyed. Ask for a new proposal.',
  );
  const author = currentAuthor(view, p);
  invariant(
    (p.op === 3 ? p.kind === 3 && p.valueCommit.length === 0 : p.kind !== 3 && p.valueCommit.length === 32) &&
      acceptedName(p.name) &&
      p.ciphertext.length >= PROPOSAL_CIPHERTEXT.min &&
      p.ciphertext.length <= PROPOSAL_CIPHERTEXT.max,
    'SECRETS_FORMAT_REFUSED',
    'Proposal fields exceed format bounds.',
  );
  invariant(
    equalBytes(ciphertextHash(p.name, p.ciphertext), p.ciphertextHash) &&
      verifyBytes(proposalBytes(r, p), p.signature, author.signPub),
    'SECRETS_VALUE_REFUSED',
    'The proposal does not match its signature.',
  );
  return author;
}
