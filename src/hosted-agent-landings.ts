// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { invariant } from './errors.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

/** The wire request bound. Keep the server's landing-cost views off the cold CLI path. */
const requestLimit = 30;

const fileHistoryHelp =
  'For a file, use history {"op":"log","path":"FILE"} or history {"op":"blame","path":"FILE"}.';
const instant = z
  .string()
  .refine(value => Number.isFinite(Date.parse(value)), 'Use an ISO date or timestamp.');
export const hostedLandingsSchema = z
  .object(
    {
      /** UTC window [from,to) on commit time. */
      from: instant.optional(),
      to: instant.optional(),
      /** One landing by its receipt id or a unique 8+ character prefix; no window then. */
      receiptId: z.string().min(8).max(64).optional(),
      /** Read one receipt's retained message and any cohort messages. */
      message: z.literal(true).optional(),
      /** One canonical submission with its request message and cohort hold. */
      submissionId: z.uuid().optional(),
      limit: z.number().int().min(1).max(requestLimit).optional(),
      /** Only landings an agent run built, or only those a person built; `builtBy` on each row says which. */
      kind: z.enum(['agent', 'person']).optional(),
      /** `nextCursor` of the previous page of the same window. */
      cursor: z.string().min(1).max(64).optional(),
    },
    {
      error: issue =>
        issue.code === 'unrecognized_keys' && issue.keys.includes('path') ? fileHistoryHelp : undefined,
    },
  )
  .strict()
  .refine(
    input =>
      input.receiptId || input.submissionId
        ? !input.from &&
          !input.to &&
          !input.cursor &&
          !input.kind &&
          !(input.submissionId && (input.receiptId || input.message))
        : !input.message && (input.cursor ? input.from && input.to : !input.from === !input.to),
    'Pass from and to for a window, nothing or limit alone for the newest landings (max 30, one page), kind: agent or person to filter, receiptId with optional message:true, or submissionId alone.',
  );
/** One bounded page of accepted landings (Issue b78ca196), read from rows already stored. */
export async function landingsHostedSource(transport: HostedAgentTransport, input: unknown) {
  const parsed = hostedLandingsSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    `Invalid hosted landings parameters: ${parsed.success ? '' : parsed.error.issues.map(issue => issue.message).join('; ')}. Use landings --help. ${fileHistoryHelp}`,
  );
  const { from, to, ...rest } = parsed.data;
  const result = await transport.query<Record<string, unknown>>('projectHostedLandings:read', {
    ...(from && to ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() } : {}),
    ...rest,
  });
  if (typeof result.messageBase64 !== 'string') {
    if (Array.isArray(result.landings))
      return {
        ...result,
        landings: result.landings.map(entry => {
          const item = entry as { mirror?: Record<string, unknown>; deploys?: unknown } | null;
          if (!item || item.deploys !== undefined || item.mirror?.deploys === undefined) return entry;
          const { deploys, ...restMirror } = item.mirror;
          if (Object.keys(restMirror).length) return { ...item, mirror: restMirror, deploys };
          const next = { ...item, deploys };
          delete next.mirror;
          return next;
        }),
      };
    return result;
  }
  const { messageBase64, ...identity } = result;
  return { ...identity, ...JSON.parse(Buffer.from(messageBase64, 'base64').toString('utf8')) };
}
