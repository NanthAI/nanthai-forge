// SPDX-License-Identifier: Apache-2.0
// Pure observation schema: Convex V8 modules import this, so it must not reach the node-only journal.
import { z } from 'zod';
const text = z.string().min(1);
const amount = z.number().finite().nonnegative();
const at = z.iso.datetime({ offset: true });
const identity = { id: text, at };
export const metricObservationSchema = z.discriminatedUnion('type', [
  z.object({
    ...identity,
    type: z.literal('revision'),
    mode: z.enum(['owner-hosted', 'hosted-cache']),
    stream: text,
    side: z.enum(['authority', 'replica']),
    timeBasis: z.enum(['commit', 'observation']).optional(),
    revision: z.number().safe().nonnegative(),
  }),
  z.object({
    ...identity,
    type: z.literal('surface'),
    surface: text,
    entity: text,
    authority: text,
    displayed: text,
  }),
  z.object({
    ...identity,
    type: z.literal('save'),
    parent: text.optional(),
    laneId: text,
    head: text,
    overlaps: z.array(z.object({ laneId: text, head: text, paths: z.array(text) })),
    complete: z.boolean(),
  }),
  z.object({
    ...identity,
    type: z.literal('overlap-delivery'),
    laneId: text,
    head: text,
    paths: z.array(text),
    noticeIds: z.array(text),
    via: z.enum(['lifecycle', 'mcp', 'hook']),
    firstWriteId: text.optional(),
  }),
  z.object({
    ...identity,
    type: z.literal('overlap-answer'),
    laneId: text.optional(),
    noticeId: text.optional(),
    deliveryId: text,
    disposition: z.enum(['acknowledged', 'routed-around']),
  }),
  z.object({
    ...identity,
    type: z.literal('bill'),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    provider: z.enum(['modal', 'blacksmith', 'github-actions', 'convex', 'netlify', 'r2']),
    billedUsd: amount,
    listUsd: amount.nullable(),
    estimateUsd: amount.nullable(),
    basis: text,
    landingIds: z.array(text).optional(),
    runIds: z.array(text).optional(),
  }),
  z.object({
    ...identity,
    type: z.literal('full-result'),
    source: z.enum(['forge', 'github-verify']),
    head: text,
    status: z.enum(['passed', 'failed']),
  }),
  z.object({ ...identity, type: z.literal('culprit'), landingId: text }),
  z.object({
    ...identity,
    type: z.literal('storage'),
    hostedBytes: amount.nullable(),
    r2Bytes: amount.nullable(),
    basis: text,
  }),
]);
export type MetricObservation = z.infer<typeof metricObservationSchema>;
/** A real project billing record, distinct from usage estimates and list price. */
export function githubHostedZeroBill(input: {
  id: string;
  at: string;
  month: string;
  listUsd: number | null;
  estimateUsd: number | null;
  runIds: string[];
}): MetricObservation {
  return metricObservationSchema.parse({
    ...input,
    type: 'bill',
    provider: 'github-actions',
    billedUsd: 0,
    basis:
      'Project billing basis: GitHub-hosted Actions runners cost this public Forge project $0. This is the recorded billed price; list price and execution minutes remain separate.',
  });
}
