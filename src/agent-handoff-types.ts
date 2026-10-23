// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
const id = z.string().uuid();
const head = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const count = z.number().int().nonnegative().safe();
export const handoffFields = {
  repairs: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  summary: z.string().trim().min(1).max(4000),
  changes: z.array(z.string()).optional(),
  tests: z.array(z.object({ command: z.string(), passed: count, failed: count, skipped: count })).optional(),
  unrun: z.array(z.string()).optional(),
  next: z.array(z.string()).optional(),
  evidence: z.array(z.string()).optional(),
};
export const handoffSchema = z.object({
  action: z.literal('handoff'),
  operationId: id.optional(),
  laneId: id,
  ...handoffFields,
});
export const handoffReadSchema = z.object({ action: z.literal('handoff-read'), laneId: id });
/** Optional extension of existing private Intent notes; no new retention owner. */
const handoffRecordSchema = z.object({
  schema: z.literal(1),
  operationId: id,
  request: z.string().regex(/^[a-f0-9]{64}$/),
  laneId: id,
  intentId: id,
  head,
  at: z.string(),
  actor: z.string(),
  ...handoffFields,
  tests: z.array(
    z.object({
      source: z.literal('self-reported'),
      command: z.string(),
      passed: count,
      failed: count,
      skipped: count,
    }),
  ),
  recordedChecks: z.array(
    z.object({
      source: z.literal('forge-recorded'),
      operationId: id,
      viewId: id,
      head,
      laneHead: head,
      checkId: id,
      definition: head,
      status: z.string(),
      exitCode: z.number().nullable(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
    }),
  ),
});
export const deliveryHandoffSchema = handoffRecordSchema.extend({
  parentHandoff: handoffRecordSchema.nullable().optional(),
});
export type DeliveryHandoff = z.infer<typeof deliveryHandoffSchema>;
export function latestHandoff(notes: { handoff?: DeliveryHandoff | undefined }[], laneId: string) {
  return (
    notes
      .slice()
      .reverse()
      .find(note => note.handoff?.laneId === laneId)?.handoff ?? null
  );
}
export function handoffSummary(handoff: DeliveryHandoff | null) {
  if (!handoff) return null;
  return {
    operationId: handoff.operationId,
    laneId: handoff.laneId,
    head: handoff.head,
    at: handoff.at,
    summary: handoff.summary.slice(0, 200),
    tests: { source: 'self-reported' as const, commands: handoff.tests.length },
    recordedChecks: handoff.recordedChecks.map(check => ({
      operationId: check.operationId,
      source: check.source,
      status: check.status,
    })),
    read: { action: 'handoff-read' as const, laneId: handoff.laneId },
  };
}
