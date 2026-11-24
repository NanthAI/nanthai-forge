// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Signed proposals (Item 6466c6a5). A device that may not change a value directly seals the change to the set's
// inbox key; a holder of the set key opens it and applies it under the queue-first version rule (41a0df87, lead
// 2a827903). Pure local functions: no network and no storage. The server store and the CLI that use them are
// separate, so nothing here authorizes applying a proposal or chooses its age or rejection policy.
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { invariant } from './errors.js';
import { ciphertextHash, deriveKey, empty, equalBytes, fixed, type Framed } from './sealed-format.js';
import {
  agree,
  decrypt,
  encrypt,
  inboxKeys,
  signBytes,
  verifyBytes,
  type RandomBytes,
} from './sealed-keys.js';
import { proposalBytes, proposalSealBytes, type SealedProposal } from './sealed-future-records.js';
import { changeBytes, type Head, type NameRecord, type Roster } from './sealed-records.js';
import { findEntry, sameId, writeDevice } from './sealed-roster.js';
import { requireConfirmedBase, requireConfirmedWriter } from './sealed-anchors.js';
import { safeSecretName } from './sealed-display.js';
import {
  bucketSize,
  makeRoom,
  nextValueVersion,
  packValue,
  sealValue,
  unpackValue,
  valueCommitment,
} from './sealed-value.js';
import { decodeSealedProposal } from './sealed-decode.js';
import { secretNameKind } from './secret-names.js';
import type { SecretPin } from './sealed-verify.js';

type Signer = { id: Buffer; sign: Buffer };
/** Each proposal key comes from a fresh ephemeral agreement and seals one plaintext, so its nonce is fixed. */
const NONCE = Buffer.alloc(12);
/** A proposal ciphertext is one value bucket plus the 16-byte tag: 272 to 69,648 bytes. */
export const PROPOSAL_CIPHERTEXT = { min: bucketSize(0) + 16, max: bucketSize(65536) + 16 };
const notAllowed = (ok: unknown, message: string) => invariant(ok, 'SECRETS_NOT_ALLOWED', message);
const refused = (ok: unknown, message: string) => invariant(ok, 'SECRETS_VALUE_REFUSED', message);
const conflict = (ok: unknown, message: string) => invariant(ok, 'WORK_CONFLICT', message);
const sealKey = (shared: Uint8Array, ephPub: Uint8Array, inboxPub: Uint8Array, aad: Framed) =>
  deriveKey(shared, Buffer.concat([ephPub, inboxPub]), aad);

/** The name record a proposal's change signature covers, at `valueVersion`. */
export const proposedRecord = (p: SealedProposal, valueVersion: number): NameRecord => ({
  name: p.name,
  kind: p.kind,
  valueVersion,
  valueEpoch: p.epoch,
  sealEpoch: p.epoch,
  ctHash: Buffer.alloc(0),
  valueCommit: p.valueCommit,
  changedBy: p.proposerId,
  changedAt: p.proposedAt,
  proposalId: p.proposalId,
  changeSig: p.changeSig,
  flags: 0,
  allowedChecks: [],
});
const namedOk = (name: string) => ['routing', 'credential'].includes(secretNameKind(name));
/** Who may author a proposal on this set: a device of the set's own roster for Development; for Checks a device of
 * the proposer's trusted Development roster that the Checks head lists as an approved proposer (GB-08 e). */
function proposalAuthor(r: Roster, h: Head, id: Uint8Array, development?: Roster) {
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

/** Review M2: the head the applier will extend, after the compaction its write makes for a new name (makeRoom is
 * deterministic from the head), so the version signed here is the one apply computes. The real head is unchanged. */
const roomFor = (h: Head, name: string) => {
  const room = { names: [...h.names], versionFloor: h.versionFloor };
  makeRoom(room, name);
  return room;
};
/** Seals a proposal that sets `value` for `name` (null removes it) on the proposer's verified view `pin`. The
 * version it signs is nextValueVersion of that view; `baseValueVersion` is the name's real version and only detects
 * conflicts. Returns the proposal and the hidden random r, which the proposer keeps to recognise an adopted value. */
export function sealProposal(input: {
  pin: SecretPin;
  proposer: Signer;
  /** Checks only: the proposer's trusted Development roster. */
  development?: Roster;
  name: string;
  value: Uint8Array | null;
  file?: boolean;
  now: number;
  random?: RandomBytes;
}) {
  const { pin, proposer, name, now } = input,
    random = input.random ?? randomBytes;
  // GB-08 d4: a proposal never rests on a Checks view reached only by the walk from genesis.
  requireConfirmedBase(pin, 'proposal');
  // Review M1: a device that trusted Development on first use seals nothing, a proposal included: the inbox key of a
  // set a hostile server built for it would open the value, as a direct write's set key would (Gate B2 L7).
  requireConfirmedWriter(pin);
  const { roster: r, head: h } = pin;
  proposalAuthor(r, h, proposer.id, input.development);
  notAllowed(namedOk(name), 'This name is not accepted for a secret.');
  const old = h.names.find(n => n.name === name),
    live = !!old && old.kind !== 3;
  notAllowed(input.value !== null || live, 'There is no current value to remove.');
  const op = input.value === null ? 3 : live ? 2 : 1,
    value = input.value ?? empty,
    valueVersion = nextValueVersion(roomFor(h, name), name);
  const r32 = Buffer.from(fixed(random(32), 32)),
    ephemeral = fixed(random(32), 32);
  let plain: Buffer | undefined, shared: Buffer | undefined, key: Buffer | undefined;
  try {
    plain = packValue(value, r32);
    const p: SealedProposal = {
      proposalId: Buffer.from(fixed(random(16), 16)),
      epoch: r.epoch,
      op,
      name,
      kind: op === 3 ? 3 : input.file ? 2 : 1,
      baseValueVersion: old?.valueVersion ?? 0,
      valueCommit:
        op === 3
          ? Buffer.alloc(0)
          : valueCommitment({ projectId: r.projectId, setId: r.setId, name, valueVersion }, r32, value),
      changeSig: Buffer.alloc(64),
      ephPub: Buffer.from(x25519.getPublicKey(ephemeral)),
      ciphertext: Buffer.alloc(0),
      ciphertextHash: Buffer.alloc(32),
      proposerId: Buffer.from(proposer.id),
      proposedAt: now,
      signature: Buffer.alloc(64),
    };
    p.changeSig = signBytes(changeBytes(h, proposedRecord(p, valueVersion)), proposer.sign);
    const aad = proposalSealBytes(r, p);
    shared = agree(ephemeral, h.inboxPub);
    key = sealKey(shared, p.ephPub, h.inboxPub, aad);
    p.ciphertext = encrypt(key, NONCE, plain, aad);
    p.ciphertextHash = ciphertextHash(name, p.ciphertext);
    p.signature = signBytes(proposalBytes(r, p), proposer.sign);
    return { proposal: p, r: Buffer.from(r32) };
  } finally {
    for (const secret of [plain, shared, key, r32, ephemeral]) secret?.fill(0);
  }
}

/** The verified current view of a holder that has the set key: from the read this write made, never a cache. */
export type ProposalView = {
  roster: Roster;
  head: Head;
  key: Uint8Array;
  /** Server-owned removal markers on this set. */
  revoked: readonly Uint8Array[];
  /** Checks only: the holder's trusted Development roster and its markers, where proposals are authored. */
  development?: Roster;
  developmentRevoked?: readonly Uint8Array[];
};
export type OpenedProposal = { proposal: SealedProposal; r: Buffer; value: Buffer };
/** The proposal's author on this view: listed, allowed to propose, and not marked for removal. */
function currentAuthor(view: ProposalView, p: SealedProposal) {
  const author = proposalAuthor(view.roster, view.head, p.proposerId, view.development);
  const markers = view.roster.setKind === 1 ? view.revoked : (view.developmentRevoked ?? []);
  notAllowed(!markers.some(id => sameId(id, p.proposerId)), 'Forge marked this proposer for removal.');
  return author;
}

/** Opens `proposal` for a holder on its verified view. Checks the record schema, its epoch, author and signature,
 * operation, kind and name, the ciphertext digest, the authenticated encryption and the padding. The change
 * signature and value commitment cover the version the proposal will get, so applyProposal checks them. The caller
 * zeroes `r` and `value`. */
export function openProposal(view: ProposalView, proposal: unknown): OpenedProposal {
  const p = decodeSealedProposal(proposal),
    { roster: r, head: h } = view;
  conflict(
    p.epoch === r.epoch && h.epoch === r.epoch,
    'This proposal was made before the set was re-keyed. Ask for a new proposal.',
  );
  const author = currentAuthor(view, p);
  invariant(
    (p.op === 3 ? p.kind === 3 && p.valueCommit.length === 0 : p.kind !== 3 && p.valueCommit.length === 32) &&
      namedOk(p.name) &&
      p.ciphertext.length >= PROPOSAL_CIPHERTEXT.min &&
      p.ciphertext.length <= PROPOSAL_CIPHERTEXT.max,
    'SECRETS_FORMAT_REFUSED',
    'Proposal fields exceed format bounds.',
  );
  refused(
    equalBytes(ciphertextHash(p.name, p.ciphertext), p.ciphertextHash) &&
      verifyBytes(proposalBytes(r, p), p.signature, author.signPub),
    'The proposal does not match its signature.',
  );
  const inbox = inboxKeys(view.key, r),
    aad = proposalSealBytes(r, p);
  let shared: Buffer | undefined, key: Buffer | undefined, plain: Buffer | undefined;
  try {
    refused(equalBytes(inbox.publicKey, h.inboxPub), 'Inbox public key does not match the set key.');
    shared = agree(inbox.privateKey, p.ephPub);
    key = sealKey(shared, p.ephPub, h.inboxPub, aad);
    plain = decrypt(key, NONCE, p.ciphertext, aad);
    const opened = unpackValue(plain);
    refused(p.op !== 3 || opened.value.length === 0, 'A removal proposal carries no value.');
    return { proposal: p, r: Buffer.from(opened.r), value: Buffer.from(opened.value) };
  } finally {
    for (const secret of [inbox.privateKey, shared, key, plain]) secret?.fill(0);
  }
}

/** The base a proposal signed is unchanged in `head`: the same live version for a change or removal; for an addition,
 * absent then and now, the same tombstone, or a tombstone since compacted under the floor (Gate B1). */
function baseUnchanged(p: SealedProposal, head: Head) {
  const current = head.names.find(n => n.name === p.name);
  if (p.op !== 1) return !!current && current.kind !== 3 && current.valueVersion === p.baseValueVersion;
  if (current) return current.kind === 3 && current.valueVersion === p.baseValueVersion;
  return p.baseValueVersion === 0 || p.baseValueVersion <= head.versionFloor;
}

/** Applies an opened proposal to `view`, the verified head this write replaces, which the caller has already made room
 * in (makeRoom) and will sign as the next head. The version is nextValueVersion of that head; the signed base only
 * detects conflicts, so a changed base is WORK_CONFLICT, never SECRETS_ROLLBACK. Returns the record and its
 * ciphertext, sealed under the set key with the proposer's r:
 * - `kept`: the proposer signed exactly this version. The record keeps the proposer's change signature and
 *   proposalId, so every reader names the proposer and the head's signer applied it.
 * - `adopted`, Development only: compaction raised the floor since the proposal, so the version it signed is stale.
 *   The applier signs an ordinary change of the same value with the same r and no proposalId (Gate B1 adoption rule);
 *   the proposer recognises it by the r it kept. A stale Checks proposal needs a new one: its proposer cannot open the
 *   current value to recognise an adoption.
 * The caller zeroes `opened`. */
export function applyProposal(
  view: ProposalView,
  opened: OpenedProposal,
  applier: Signer,
  now: number,
  random?: RandomBytes,
) {
  const { roster: r, head: h } = view,
    { proposal: p, r: hidden, value } = opened;
  // The view may be newer than the one the proposal was opened on: epoch and author are checked again here.
  conflict(
    p.epoch === r.epoch && h.epoch === r.epoch,
    'This proposal was made before the set was re-keyed. Ask for a new proposal.',
  );
  const author = currentAuthor(view, p);
  notAllowed(
    writeDevice(findEntry(r, applier.id), r.setKind),
    'Only a device with write authority applies a proposal.',
  );
  const label = safeSecretName(p.name);
  conflict(baseUnchanged(p, h), `${label} changed after this proposal was made. Ask for a new proposal.`);
  const valueVersion = nextValueVersion(h, p.name),
    current = h.names.find(n => n.name === p.name && n.kind !== 3);
  const signed = proposedRecord(p, valueVersion);
  const kept = verifyBytes(changeBytes(h, signed), p.changeSig, author.signPub);
  if (kept)
    refused(
      p.op === 3 ||
        equalBytes(
          valueCommitment(
            { projectId: r.projectId, setId: r.setId, name: p.name, valueVersion },
            hidden,
            value,
          ),
          p.valueCommit,
        ),
      'The proposed value does not match its signed commitment.',
    );
  else
    conflict(
      r.setKind === 1,
      `${label}: this Checks proposal was overtaken by a later compaction. Ask its proposer for a new one.`,
    );
  const record: NameRecord = kept
    ? { ...signed }
    : {
        ...signed,
        valueEpoch: r.epoch,
        valueCommit: Buffer.alloc(0),
        changedBy: Buffer.from(applier.id),
        changedAt: now,
        proposalId: Buffer.alloc(0),
      };
  // A change keeps the name's Checks permissions; an addition or removal starts without any.
  record.flags = p.op === 2 && current ? current.flags : 0;
  record.allowedChecks = p.op === 2 && current ? [...current.allowedChecks] : [];
  record.sealEpoch = r.epoch;
  let stored: Buffer | null = null;
  if (p.op !== 3) {
    const sealed = sealValue(
      view.key,
      {
        projectId: r.projectId,
        setId: r.setId,
        epoch: r.epoch,
        name: p.name,
        kind: record.kind as 1 | 2,
        valueVersion,
        valueEpoch: record.valueEpoch,
        sealEpoch: record.sealEpoch,
      },
      value,
      { r: hidden, ...(random ? { random } : {}) },
    );
    stored = sealed.stored;
    record.ctHash = sealed.ctHash;
    record.valueCommit = sealed.valueCommit;
  }
  if (!kept) record.changeSig = signBytes(changeBytes(h, record), applier.sign);
  return { mode: kept ? ('kept' as const) : ('adopted' as const), record, stored };
}
