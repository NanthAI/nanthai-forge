// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Format fields reserved now; their user journeys ship in later slices.
import { empty, fixed, frame, octet, textBytes, uint } from './sealed-format.js';
import type { Roster } from './sealed-records.js';

export type SealedProposal = {
  proposalId: Buffer;
  epoch: number;
  op: 1 | 2 | 3;
  name: string;
  kind: 1 | 2 | 3;
  baseValueVersion: number;
  valueCommit: Buffer;
  changeSig: Buffer;
  ephPub: Buffer;
  ciphertext: Buffer;
  ciphertextHash: Buffer;
  proposerId: Buffer;
  proposedAt: number;
  signature: Buffer;
};
export type PersonCheckpoint = { roster: Roster; rosterHash: Buffer; at: number; signature: Buffer };
export const proposalBytes = (r: Roster, p: SealedProposal) =>
  frame(
    'proposal',
    fixed(r.projectId, 16),
    fixed(r.setId, 16),
    octet(r.setKind),
    uint(p.epoch),
    fixed(p.proposalId, 16),
    octet(p.op),
    textBytes(p.name),
    octet(p.kind),
    uint(p.baseValueVersion),
    p.valueCommit.length ? fixed(p.valueCommit, 32) : empty,
    fixed(p.changeSig, 64),
    fixed(p.ephPub, 32),
    fixed(p.ciphertextHash, 32),
    fixed(p.proposerId, 16),
    uint(p.proposedAt),
  );
export const proposalSealBytes = (
  r: Roster,
  p: Pick<SealedProposal, 'epoch' | 'proposalId' | 'name' | 'op'>,
) =>
  frame(
    'proposal-seal',
    fixed(r.projectId, 16),
    fixed(r.setId, 16),
    uint(p.epoch),
    fixed(p.proposalId, 16),
    textBytes(p.name),
    octet(p.op),
  );
export const checkpointBytes = (r: Roster, rosterHash: Buffer, at: number) =>
  frame(
    'person-checkpoint',
    fixed(r.projectId, 16),
    fixed(r.setId, 16),
    uint(r.rosterVersion),
    fixed(rosterHash, 32),
    uint(at),
  );
export const machineBundleBytes = (
  r: Roster,
  machineId: Buffer,
  encPriv: Buffer,
  headFloor: number,
  roster: Buffer,
) =>
  frame(
    'machine-bundle',
    fixed(r.projectId, 16),
    fixed(r.setId, 16),
    octet(r.setKind),
    fixed(machineId, 16),
    fixed(encPriv, 32),
    uint(r.rosterVersion),
    roster,
    uint(headFloor),
  );
