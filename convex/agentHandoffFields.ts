// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
/** Portable delivery notes retain self reports separately from recorded receipts. */
export const deliveryHandoff = v.object({
  schema: v.literal(1),
  operationId: v.string(),
  request: v.string(),
  laneId: v.string(),
  intentId: v.string(),
  head: v.string(),
  at: v.string(),
  actor: v.string(),
  summary: v.string(),
  changes: v.optional(v.array(v.string())),
  unrun: v.optional(v.array(v.string())),
  next: v.optional(v.array(v.string())),
  evidence: v.optional(v.array(v.string())),
  tests: v.array(
    v.object({
      source: v.literal('self-reported'),
      command: v.string(),
      passed: v.number(),
      failed: v.number(),
      skipped: v.number(),
    }),
  ),
  recordedChecks: v.array(
    v.object({
      source: v.literal('forge-recorded'),
      operationId: v.string(),
      viewId: v.string(),
      head: v.string(),
      laneHead: v.string(),
      checkId: v.string(),
      definition: v.string(),
      status: v.string(),
      exitCode: v.union(v.number(), v.null()),
      startedAt: v.string(),
      endedAt: v.union(v.string(), v.null()),
    }),
  ),
});
