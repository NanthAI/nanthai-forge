// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const sealedKind = v.union(v.literal(1), v.literal(2), v.literal(3));
/** Opaque client records contain public signed metadata and ciphertext only.
 * The server never decodes values, checks signatures or receives a private key. */
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
};
export const sealedHistoryFields = {
  projectId: v.id('hostedProjects'),
  kind: sealedKind,
  v: v.literal(1),
  setId: v.bytes(),
  genesis: v.bytes(),
  transitions: v.array(v.bytes()),
  rotateLists: v.array(v.bytes()),
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
