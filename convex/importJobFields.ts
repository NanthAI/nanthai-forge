// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';

export const syncResult = v.object({
  checkedAt: v.number(),
  result: v.union(v.literal('checked'), v.literal('unavailable'), v.literal('error')),
  head: v.optional(v.string()),
});
export const jobFields = {
  scope: v.string(),
  repository: v.string(),
  ref: v.string(),
  owner: v.string(),
  visibility: v.union(v.literal('public'), v.literal('private')),
  phase: v.union(
    v.literal('queued'),
    v.literal('fetching'),
    v.literal('indexing'),
    v.literal('ready'),
    v.literal('error'),
  ),
  processed: v.number(),
  total: v.number(),
  error: v.optional(v.string()),
  artifactKey: v.optional(v.string()),
  head: v.optional(v.string()),
  analysisVersion: v.optional(v.string()),
  generation: v.number(),
  task: v.optional(v.id('_scheduled_functions')),
  syncRevision: v.optional(v.number()),
  syncEventRevision: v.optional(v.number()),
  sync: v.optional(syncResult),
  removal: v.optional(v.union(v.literal('trash'), v.literal('deleting'))),
  removedAt: v.optional(v.number()),
};
export const jobDocument = v.object({ _id: v.id('imports'), _creationTime: v.number(), ...jobFields });
