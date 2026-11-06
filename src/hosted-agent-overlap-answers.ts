// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { OVERLAP_ANSWERS_MAX_LIMIT } from './hosted-overlap.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

const instant = z
  .string()
  .refine(value => Number.isFinite(Date.parse(value)), 'Use an ISO date or timestamp.');
export const hostedOverlapAnswersSchema = z
  .object({
    laneId: z.uuid().optional(),
    /** UTC window [from,to) on the time the answer was stored; send both or neither. */
    from: instant.optional(),
    to: instant.optional(),
    limit: z.number().int().min(1).max(OVERLAP_ANSWERS_MAX_LIMIT).optional(),
    /** `nextCursor` of the previous page of the same query. */
    cursor: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine(input => (input.from === undefined) === (input.to === undefined), 'Send both from and to.')
  .refine(input => input.laneId !== undefined || input.from !== undefined, 'Send laneId or from and to.');
/** One bounded page of stored overlap answers (Issue b78ca196), by Lane or time window. */
export async function overlapAnswersHostedSource(transport: HostedAgentTransport, input: unknown) {
  const parsed = hostedOverlapAnswersSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Invalid hosted overlap-answers parameters. Send laneId or from and to (see overlap-answers --help).',
  );
  const { from, to, ...rest } = parsed.data;
  return transport.query('projectHostedOverlapAnswers:read', {
    ...rest,
    ...(from !== undefined && to !== undefined
      ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
      : {}),
  });
}
