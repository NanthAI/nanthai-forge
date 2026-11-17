// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { LANDINGS_MAX_LIMIT } from './hosted-landings-view.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

const fileHistoryHelp =
  'For a file, use history {"op":"log","path":"FILE"} or history {"op":"blame","path":"FILE"}.';
const instant = z
  .string()
  .refine(value => Number.isFinite(Date.parse(value)), 'Use an ISO date or timestamp.');
export const hostedLandingsSchema = z
  .object(
    {
      /** UTC window [from,to) on commit time. */
      from: instant,
      to: instant,
      limit: z.number().int().min(1).max(LANDINGS_MAX_LIMIT).optional(),
      /** `nextCursor` of the previous page of the same window. */
      cursor: z.string().min(1).max(64).optional(),
    },
    {
      error: issue =>
        issue.code === 'unrecognized_keys' && issue.keys.includes('path') ? fileHistoryHelp : undefined,
    },
  )
  .strict();
/** One bounded page of accepted landings (Issue b78ca196), read from rows already stored. */
export async function landingsHostedSource(transport: HostedAgentTransport, input: unknown) {
  const parsed = hostedLandingsSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    `Invalid hosted landings parameters. Use landings --help. ${fileHistoryHelp}`,
  );
  const { from, to, ...rest } = parsed.data;
  return transport.query('projectHostedLandings:read', {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    ...rest,
  });
}
