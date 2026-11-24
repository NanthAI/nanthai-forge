// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Exact sealed record schemas, checked in place. No Buffer or node: imports: the server runs these too.
import { invariant } from './errors.js';

export type Check = (value: unknown) => void;
const bad = (ok: unknown) => invariant(ok, 'SECRETS_FORMAT_REFUSED', 'Malformed sealed record fields.');
export const number: Check = v => bad(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
const oneOf =
  (...values: number[]): Check =>
  v => {
    number(v);
    bad(values.includes(v as number));
  };
const text: Check = v => bad(typeof v === 'string');
export const bytes =
  (...lengths: number[]): Check =>
  v =>
    bad(v instanceof Uint8Array && (!lengths.length || lengths.includes(v.length)));
const array =
  (item: Check): Check =>
  v => {
    bad(Array.isArray(v));
    for (const x of v as unknown[]) item(x);
  };
const nullable =
  (item: Check): Check =>
  v => {
    if (v !== null) item(v);
  };
export function record(fields: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return v => {
    bad(v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v));
    const o = v as Record<string, unknown>;
    bad(Object.keys(o).every(k => Object.hasOwn(fields, k) || Object.hasOwn(optional, k)));
    for (const [key, check] of Object.entries(fields)) {
      bad(Object.hasOwn(o, key));
      check(o[key]);
    }
    for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(o, key)) check(o[key]);
  };
}
const pointer = record({ checksSetId: bytes(16), checksGenesisHash: bytes(32) });
const entry = record({
  entryKind: oneOf(1, 2, 3),
  id: bytes(16),
  encPub: bytes(32),
  signPub: bytes(0, 32),
  accountId: bytes(0, 16),
  accountHandle: text,
  displayName: text,
  role: oneOf(1, 2, 3, 4),
  addedBy: bytes(16),
  how: oneOf(1, 2, 3, 4, 5, 6),
  addedAtRosterVersion: number,
  bindSig: bytes(0, 64),
});
const former = record({ deviceId: bytes(16), signPub: bytes(0, 32), lastEpoch: number });
export const roster = record({
  v: oneOf(1),
  projectId: bytes(16),
  setId: bytes(16),
  setKind: oneOf(1, 2, 3),
  sharingMode: oneOf(1, 2),
  checksPointer: nullable(pointer),
  rosterVersion: number,
  epoch: number,
  prevRosterHash: bytes(32),
  entries: array(entry),
  former: array(former),
});
const name = record({
  name: text,
  kind: oneOf(1, 2, 3),
  valueVersion: number,
  valueEpoch: number,
  sealEpoch: number,
  ctHash: bytes(0, 32),
  valueCommit: bytes(0, 32),
  changedBy: bytes(16),
  changedAt: number,
  proposalId: bytes(0, 16),
  changeSig: bytes(64),
  flags: oneOf(0, 1, 2, 3, 4, 5, 6, 7),
  allowedChecks: array(text),
});
const proposer = record({
  deviceId: bytes(16),
  accountId: bytes(16),
  approvedBy: bytes(16),
  approvedAt: number,
});
const head = record({
  v: oneOf(1),
  projectId: bytes(16),
  setId: bytes(16),
  setKind: oneOf(1, 2, 3),
  headVersion: number,
  prevHeadHash: bytes(32),
  rosterVersion: number,
  rosterHash: bytes(32),
  epoch: number,
  commit: bytes(32),
  inboxPub: bytes(32),
  versionFloor: number,
  setFlags: oneOf(0, 1),
  proposers: array(proposer),
  names: array(name),
  signerId: bytes(16),
  signedAt: number,
  signature: bytes(64),
});
const supersede = record({
  projectId: bytes(16),
  setKind: oneOf(1, 2, 3),
  oldSetId: bytes(16),
  oldGenesisHash: bytes(32),
  oldRosterVersion: number,
  oldRosterHash: bytes(32),
  oldHeadHash: bytes(32),
  newSetId: bytes(16),
  newGenesisHash: bytes(32),
  signerId: bytes(16),
  at: number,
  signature: bytes(64),
});
const delta = record({
  added: array(entry),
  removed: array(bytes(16)),
  roles: array(record({ id: bytes(16), role: oneOf(1, 2, 3, 4) })),
  droppedFormer: array(bytes(16)),
  newSharingMode: nullable(oneOf(1, 2)),
  newChecksPointer: nullable(pointer),
  supersede: nullable(supersede),
  epochBumped: oneOf(0, 1),
});
const transition = record({
  fromVersion: number,
  fromHash: bytes(32),
  toVersion: number,
  toHash: bytes(32),
  delta,
  signerId: bytes(16),
  signature: bytes(64),
});
/** One proposal record, checked strictly wherever it is read (the reply, the server store, the applier). */
export const proposal = record({
  proposalId: bytes(16),
  epoch: number,
  op: oneOf(1, 2, 3),
  name: text,
  kind: oneOf(1, 2, 3),
  baseValueVersion: number,
  valueCommit: bytes(0, 32),
  changeSig: bytes(64),
  ephPub: bytes(32),
  ciphertext: bytes(),
  ciphertextHash: bytes(32),
  proposerId: bytes(16),
  proposedAt: number,
  signature: bytes(64),
});
const replyFields = {
  v: oneOf(1),
  roster,
  head,
  ciphertexts: array(record({ name: text, stored: bytes() })),
  wraps: array(record({ recipientId: bytes(16), ephPub: bytes(32), ciphertext: bytes(48) })),
  revoked: array(bytes(16)),
  supersede: nullable(supersede),
  proposals: array(proposal),
};
/** Checks a record tree once per node; nested replies are queued, never followed recursively. */
export function checkTree(
  value: unknown,
  root: (enqueue: Check) => Check,
  nested: (enqueue: Check) => Check,
) {
  const pending: { value: unknown; check: Check }[] = [],
    seen = new Set<unknown>();
  let nestedCheck: Check = bad;
  const enqueue: Check = v => {
    bad(!seen.has(v));
    pending.push({ value: v, check: nestedCheck });
  };
  nestedCheck = nested(enqueue);
  pending.push({ value, check: root(enqueue) });
  while (pending.length) {
    const next = pending.pop()!;
    bad(!seen.has(next.value));
    seen.add(next.value);
    next.check(next.value);
  }
}
export const fullReply = (enqueue: Check) =>
  record(
    { ...replyFields, genesis: roster, transitions: array(transition) },
    { previous: enqueue, related: array(enqueue) },
  );
/** The stored parts of a reply, checked in place with the same schemas: the head-write payload
 * (a reply without its history, and without nested previous/related replies, whose markers only the
 * server may supply), a genesis roster and one transition. No Buffer, so the server runs it. */
export function checkSealedPart(kind: 'payload' | 'roster' | 'transition' | 'proposal', value: unknown) {
  (kind === 'payload'
    ? record(replyFields)
    : kind === 'roster'
      ? roster
      : kind === 'proposal'
        ? proposal
        : transition)(value);
}
