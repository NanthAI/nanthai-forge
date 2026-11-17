// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { SealedReply } from './sealed-verify.js';

type Check = (value: unknown) => void;
const bad = (ok: unknown) => invariant(ok, 'SECRETS_FORMAT_REFUSED', 'Malformed sealed record fields.');
const number: Check = v => bad(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
const oneOf =
  (...values: number[]): Check =>
  v => {
    number(v);
    bad(values.includes(v as number));
  };
const text: Check = v => bad(typeof v === 'string');
const bytes =
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
function record(fields: Record<string, Check>, optional: Record<string, Check> = {}): Check {
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
const former = record({ deviceId: bytes(16), signPub: bytes(32), lastEpoch: number });
const roster = record({
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
const proposal = record({
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
/** Exact schemas apply to online, cached, journaled and directly supplied verifier records alike. */
export function decodeSealedReply(value: unknown): SealedReply {
  const pending = [value],
    seen = new Set<unknown>();
  const enqueue: Check = v => {
    bad(!seen.has(v));
    pending.push(v);
  };
  const reply = record(
    {
      v: oneOf(1),
      genesis: roster,
      roster,
      head,
      transitions: array(transition),
      ciphertexts: array(record({ name: text, stored: bytes() })),
      wraps: array(record({ recipientId: bytes(16), ephPub: bytes(32), ciphertext: bytes(48) })),
      revoked: array(bytes(16)),
      supersede: nullable(supersede),
      proposals: array(proposal),
    },
    { previous: enqueue, related: array(enqueue) },
  );
  while (pending.length) {
    const v = pending.pop();
    bad(!seen.has(v));
    seen.add(v);
    reply(v);
  }
  const copies = new Map<object, unknown>();
  const copy = (input: unknown): unknown => {
    if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (!input || typeof input !== 'object') return input;
    if (copies.has(input)) return copies.get(input);
    const output: unknown[] | Record<string, unknown> = Array.isArray(input) ? [] : {};
    copies.set(input, output);
    for (const [key, field] of Object.entries(input))
      Object.defineProperty(output, key, {
        value: copy(field),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return output;
  };
  return copy(value) as SealedReply;
}
