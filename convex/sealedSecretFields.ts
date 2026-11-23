// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const sealedKind = v.union(v.literal(1), v.literal(2), v.literal(3));
/** Client records contain public signed metadata and ciphertext only. The server never opens a value
 * or holds a key; it checks the public binding of each write before storing it (sealedSecretGate).
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
};
