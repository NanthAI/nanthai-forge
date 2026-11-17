// SPDX-License-Identifier: Apache-2.0
import { empty, fixed, frame, list, octet, textBytes, uint } from './sealed-format.js';

export type SetKind = 1 | 2 | 3;
export type Entry = {
  entryKind: 1 | 2 | 3;
  id: Buffer;
  encPub: Buffer;
  signPub: Buffer;
  accountId: Buffer;
  accountHandle: string;
  displayName: string;
  role: 1 | 2 | 3 | 4;
  addedBy: Buffer;
  how: 1 | 2 | 3 | 4 | 5 | 6;
  addedAtRosterVersion: number;
  bindSig: Buffer;
};
export type Former = { deviceId: Buffer; signPub: Buffer; lastEpoch: number };
export type ChecksPointer = { checksSetId: Buffer; checksGenesisHash: Buffer };
export type Roster = {
  v: 1;
  projectId: Buffer;
  setId: Buffer;
  setKind: SetKind;
  sharingMode: 1 | 2;
  checksPointer: ChecksPointer | null;
  rosterVersion: number;
  epoch: number;
  prevRosterHash: Buffer;
  entries: Entry[];
  former: Former[];
};
export type NameRecord = {
  name: string;
  kind: 1 | 2 | 3;
  valueVersion: number;
  valueEpoch: number;
  sealEpoch: number;
  ctHash: Buffer;
  valueCommit: Buffer;
  changedBy: Buffer;
  changedAt: number;
  proposalId: Buffer;
  changeSig: Buffer;
  flags: number;
  allowedChecks: string[];
};
export type Proposer = { deviceId: Buffer; accountId: Buffer; approvedBy: Buffer; approvedAt: number };
export type Head = {
  v: 1;
  projectId: Buffer;
  setId: Buffer;
  setKind: SetKind;
  headVersion: number;
  prevHeadHash: Buffer;
  rosterVersion: number;
  rosterHash: Buffer;
  epoch: number;
  commit: Buffer;
  inboxPub: Buffer;
  versionFloor: number;
  setFlags: number;
  proposers: Proposer[];
  names: NameRecord[];
  signerId: Buffer;
  signedAt: number;
  signature: Buffer;
};
export type Supersede = {
  projectId: Buffer;
  setKind: SetKind;
  oldSetId: Buffer;
  oldGenesisHash: Buffer;
  oldRosterVersion: number;
  oldRosterHash: Buffer;
  oldHeadHash: Buffer;
  newSetId: Buffer;
  newGenesisHash: Buffer;
  signerId: Buffer;
  at: number;
  signature: Buffer;
};
export type Delta = {
  added: Entry[];
  removed: Buffer[];
  roles: { id: Buffer; role: Entry['role'] }[];
  droppedFormer: Buffer[];
  newSharingMode: 1 | 2 | null;
  newChecksPointer: ChecksPointer | null;
  supersede: Supersede | null;
  epochBumped: 0 | 1;
};
export type Transition = {
  fromVersion: number;
  fromHash: Buffer;
  toVersion: number;
  toHash: Buffer;
  delta: Delta;
  signerId: Buffer;
  signature: Buffer;
};
export function displayText(value: string) {
  return [
    ...value
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ''),
  ]
    .slice(0, 64)
    .join('');
}
const byId = <T>(items: readonly T[], id: (item: T) => Buffer) =>
  [...items].sort((a, b) => Buffer.compare(id(a), id(b)));
const optional = (bytes: Buffer, length: number) => (bytes.length ? fixed(bytes, length) : empty);
export const pointerBytes = (pointer: ChecksPointer | null) =>
  pointer
    ? frame('checks-pointer', fixed(pointer.checksSetId, 16), fixed(pointer.checksGenesisHash, 32))
    : empty;
export const entryBytes = (e: Entry) =>
  frame(
    'roster-entry',
    octet(e.entryKind),
    fixed(e.id, 16),
    fixed(e.encPub, 32),
    optional(e.signPub, 32),
    optional(e.accountId, 16),
    textBytes(e.accountHandle),
    textBytes(e.displayName),
    octet(e.role),
    fixed(e.addedBy, 16),
    octet(e.how),
    uint(e.addedAtRosterVersion),
    optional(e.bindSig, 64),
  );
export const formerBytes = (e: Former) =>
  frame('former', fixed(e.deviceId, 16), fixed(e.signPub, 32), uint(e.lastEpoch));
export const rosterBytes = (r: Roster) =>
  frame(
    'roster',
    fixed(r.projectId, 16),
    fixed(r.setId, 16),
    octet(r.setKind),
    octet(r.sharingMode),
    pointerBytes(r.checksPointer),
    uint(r.rosterVersion),
    uint(r.epoch),
    fixed(r.prevRosterHash, 32),
    list(byId(r.entries, e => e.id).map(entryBytes)),
    list(byId(r.former, e => e.deviceId).map(formerBytes)),
  );
export const changeBytes = (c: Pick<Head, 'projectId' | 'setId' | 'setKind'>, n: NameRecord) =>
  frame(
    'change',
    fixed(c.projectId, 16),
    fixed(c.setId, 16),
    octet(c.setKind),
    textBytes(n.name),
    octet(n.kind),
    uint(n.valueVersion),
    uint(n.valueEpoch),
    uint(n.changedAt),
    optional(n.proposalId, 16),
    optional(n.valueCommit, 32),
    fixed(n.changedBy, 16),
  );
export const nameBytes = (n: NameRecord) =>
  frame(
    'head-name',
    textBytes(n.name),
    octet(n.kind),
    uint(n.valueVersion),
    uint(n.valueEpoch),
    uint(n.sealEpoch),
    optional(n.ctHash, 32),
    optional(n.valueCommit, 32),
    fixed(n.changedBy, 16),
    uint(n.changedAt),
    optional(n.proposalId, 16),
    fixed(n.changeSig, 64),
    uint(n.flags),
    list(n.allowedChecks.map(textBytes)),
  );
export const proposerBytes = (p: Proposer) =>
  frame(
    'proposer',
    fixed(p.deviceId, 16),
    fixed(p.accountId, 16),
    fixed(p.approvedBy, 16),
    uint(p.approvedAt),
  );
export const headBytes = (h: Head) =>
  frame(
    'head',
    fixed(h.projectId, 16),
    fixed(h.setId, 16),
    octet(h.setKind),
    uint(h.headVersion),
    fixed(h.prevHeadHash, 32),
    uint(h.rosterVersion),
    fixed(h.rosterHash, 32),
    uint(h.epoch),
    fixed(h.commit, 32),
    fixed(h.inboxPub, 32),
    uint(h.versionFloor),
    uint(h.setFlags),
    list(h.proposers.map(proposerBytes)),
    list([...h.names].sort((a, b) => Buffer.compare(textBytes(a.name), textBytes(b.name))).map(nameBytes)),
    fixed(h.signerId, 16),
    uint(h.signedAt),
  );
export const supersedeBytes = (s: Supersede) =>
  frame(
    'supersede',
    fixed(s.projectId, 16),
    octet(s.setKind),
    fixed(s.oldSetId, 16),
    fixed(s.oldGenesisHash, 32),
    uint(s.oldRosterVersion),
    fixed(s.oldRosterHash, 32),
    fixed(s.oldHeadHash, 32),
    fixed(s.newSetId, 16),
    fixed(s.newGenesisHash, 32),
    fixed(s.signerId, 16),
    uint(s.at),
  );
export const deltaBytes = (d: Delta) =>
  frame(
    'transition-delta',
    list(d.added.map(entryBytes)),
    list(d.removed.map(id => fixed(id, 16))),
    list(d.roles.map(e => frame('role-change', fixed(e.id, 16), octet(e.role)))),
    list(d.droppedFormer.map(id => fixed(id, 16))),
    d.newSharingMode === null ? empty : octet(d.newSharingMode),
    pointerBytes(d.newChecksPointer),
    d.supersede ? supersedeBytes(d.supersede) : empty,
    octet(d.epochBumped),
  );
export const transitionBytes = (r: Roster, t: Transition) =>
  frame(
    'transition',
    fixed(r.projectId, 16),
    fixed(r.setId, 16),
    uint(t.fromVersion),
    fixed(t.fromHash, 32),
    fixed(t.toHash, 32),
    deltaBytes(t.delta),
    fixed(t.signerId, 16),
  );
export const repinBytes = (
  r: Roster,
  rosterHash: Buffer,
  h: Head,
  headHash: Buffer,
  deviceId: Buffer,
  nonce: Buffer,
) =>
  frame(
    'repin',
    fixed(r.projectId, 16),
    fixed(r.setId, 16),
    uint(r.rosterVersion),
    fixed(rosterHash, 32),
    uint(h.headVersion),
    fixed(headHash, 32),
    fixed(deviceId, 16),
    fixed(nonce, 16),
  );
