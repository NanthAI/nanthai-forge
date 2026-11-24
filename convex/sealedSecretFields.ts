// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const sealedKind = v.union(v.literal(1), v.literal(2), v.literal(3));
export const sealedPendingProposal = v.object({
  id: v.id('sealedSecretProposals'),
  proposalId: v.bytes(),
  proposerId: v.bytes(),
  name: v.string(),
  epoch: v.number(),
  size: v.number(),
  at: v.number(),
  /** The proposal's operation (1 add, 2 change, 3 remove) and kind (1 env, 2 file, 3 removal), kept from the decoded
   * record so the Secrets page names them without opening the proposal bytes. Absent on rows stored before slice 4. */
  op: v.optional(sealedKind),
  kind: v.optional(sealedKind),
});
/** Client records contain public signed metadata and ciphertext only. The server never opens a value
 * or holds a key; it checks public signatures and bindings before storing a write (sealedSecretGate).
 * Clients rely on none of this. */
export const sealedSetFields = {
  projectId: v.id('hostedProjects'),
  kind: sealedKind,
  v: v.literal(1),
  active: v.boolean(),
  supersededAt: v.union(v.number(), v.null()),
  setId: v.bytes(),
  headHash: v.bytes(),
  headVersion: v.number(),
  rosterVersion: v.number(),
  payload: v.bytes(),
  /** Server-owned side records, which a head write never sets: removal markers (device ids) and
   * join requests. A removing or adding transition clears its own. Absent when empty. */
  revoked: v.optional(v.array(v.bytes())),
  joinRequests: v.optional(v.array(v.object({ deviceId: v.bytes(), request: v.bytes(), at: v.number() }))),
  /** Server-owned: the owner devices the issuing browser of the account's "Sign out everywhere" at `epoch` kept
   * (convex/sealedSecretMarkers.ts clearSweptSignIn); that sweep's later marking steps leave them unmarked. */
  sweptKept: v.optional(v.object({ epoch: v.number(), ids: v.array(v.bytes()) })),
  /** Server-owned: the waiting proposals (Item 6466c6a5), at most 32 and 256 KiB of proposal bytes per set. Each
   * row's facts are kept here so a head write checks and resolves them without reading the proposal rows. */
  proposals: v.optional(v.array(sealedPendingProposal)),
  /** Server-owned: the last 64 proposal ids that left the waiting list, so the same proposal is not stored again
   * (review F4). A holder's own journal of applied ids is the client's check. */
  resolvedProposals: v.optional(v.array(v.bytes())),
  /** Server-owned, beside `revoked` (Item 41a0df87, slice 4): when each marker was set and, when the person left the
   * project, their public Forge handle (never a name or email). A holder's re-key step moves the handles of the
   * entries it removes into `formerHandles`. Bounded by the roster: only ids in `revoked` or the roster's former list. */
  revokedNotes: v.optional(
    v.array(v.object({ id: v.bytes(), at: v.number(), handle: v.optional(v.string()) })),
  ),
  formerHandles: v.optional(v.array(v.object({ id: v.bytes(), handle: v.string() }))),
  /** Server-owned: this set's needs-you total (removed people still listed + names to rotate + waiting proposals),
   * kept by the writes that change them so the project's top-bar counter moves in the same transaction. */
  needs: v.optional(v.number()),
};
export const sealedHistoryFields = {
  projectId: v.id('hostedProjects'),
  kind: sealedKind,
  v: v.literal(1),
  setId: v.bytes(),
  genesis: v.bytes(),
  transitions: v.array(v.bytes()),
  /** Unused and no longer written: a rotate list is derived from the signed roster's former signers and each
   * name's value epoch. Delete the field once no stored row carries it (each head write replaces the row). */
  rotateLists: v.optional(v.array(v.bytes())),
  events: v.array(v.object({ operationId: v.string(), headHash: v.bytes(), at: v.number() })),
};
export const sealedSecretTables = {
  sealedSecretSets: defineTable(sealedSetFields).index('by_project_and_kind_and_active', [
    'projectId',
    'kind',
    'active',
  ]),
  sealedSecretHistory: defineTable(sealedHistoryFields).index('by_project_and_setId', ['projectId', 'setId']),
  /** One signed proposal record, sealed to the set's inbox key; only a holder of the set key opens it. Written by
   * sealedSecrets:propose, deleted by the head write or rejection that resolves it, or by a re-key. */
  sealedSecretProposals: defineTable({
    projectId: v.id('hostedProjects'),
    kind: sealedKind,
    setId: v.bytes(),
    proposal: v.bytes(),
    at: v.number(),
  }).index('by_project_and_setId', ['projectId', 'setId']),
  /** Slice 5 (review F4): one Checks machine's read verifier, a hash of the token its key derives
   * (convex/sealedMachines.ts). A machine read checks this small row before it reads the set row. Written in the
   * owner write that adds the machine; a Checks step that removes the machine deletes it. At most 100 per set. */
  sealedMachineReaders: defineTable({
    projectId: v.id('hostedProjects'),
    kind: sealedKind,
    setId: v.bytes(),
    machineId: v.bytes(),
    verifier: v.bytes(),
  }).index('by_project_and_kind_and_machine', ['projectId', 'kind', 'machineId']),
};
