// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { shellQuote } from './shell-quote.js';

const detail = {
  laneId: z.uuid().optional(),
  paths: z.array(z.string()).max(10),
  more: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  next: z.string(),
};
/** One existing advice channel: accepted-main overlap or a proven merge
 * conflict on an unaccepted predecessor. Neither variant settles a request. */
export const wouldConflictSchema = z.union([
  z
    .object({
      ...detail,
      landedSubmissionId: z.string(),
      /** The Lane this entry composed, when the mark could name it (older marks omit it). */
      laneId: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      ...detail,
      code: z.literal('COMPOSITION_CONFLICT'),
      resolution: z
        .object({
          early: z.boolean(),
          mode: z.enum(['automatic', 'on', 'off']),
          failureRate: z.number().nullable().optional(),
          resolveMs: z.number().nullable().optional(),
          waitSavedMs: z.number().nullable().optional(),
          breakEven: z.number().nullable().optional(),
          samples: z.number().optional(),
          measuredCosts: z.number().optional(),
          reason: z.string(),
        })
        .strict()
        .optional(),
      predecessor: z
        .object({
          groupId: z.uuid(),
          submissionId: z.uuid(),
          head: z.string().regex(/^[0-9a-f]{64}$/),
          receiptId: z.uuid(),
        })
        .strict(),
    })
    .strict(),
]);
export type WouldConflict = z.infer<typeof wouldConflictSchema>;

/** Same bytes are not a conflict (Item 36fd3295, incident 5e3c3a3c): a file main changed that holds
 * the same bytes as the queued Candidate is not path advice, and land --save syncs main in once
 * instead of rejoining a stale entry. This is the largest Candidate file listing the would-conflict
 * pass reads; a larger one keeps path advice. */
export const SAME_BYTES_LISTING_BYTES = 1024 * 1024;
type FileEntry = { blob: string; mode: string } | null;
/** The paths whose bytes main holds now equal the Candidate's result bytes, from the Candidate's own
 * file listing. A path the listing does not name stays advice: unknown is never "same". */
export function sameBytesPaths(
  paths: readonly string[],
  main: ReadonlyMap<string, { blob: string; mode: string }>,
  listing: { files: { path: string; after: FileEntry }[] },
) {
  const after = new Map(listing.files.map(file => [file.path, file.after]));
  return paths.filter(path => {
    if (!after.has(path)) return false;
    const mine = after.get(path) ?? null,
      theirs = main.get(path) ?? null;
    return mine === null
      ? theirs === null
      : theirs !== null && mine.blob === theirs.blob && mine.mode === theirs.mode;
  });
}
export type SyncRequiredAdvice = WouldConflict;

/** The accepted-main variant on a still-queued entry: main already took files this entry changes, so
 * the Lane syncs and lands again (Issue f7539ebb). An early predecessor decision instead returns
 * exact pinned sync guidance while the predecessor remains pending. */
export function syncRequiredAdvice(
  value: unknown,
  submission?: { phase?: string; observation?: { state?: string } } | null,
): SyncRequiredAdvice | undefined {
  if (submission && (submission.phase !== 'queued' || submission.observation?.state !== 'pending'))
    return undefined;
  const parsed = wouldConflictSchema.safeParse(value);
  return parsed.success && ('landedSubmissionId' in parsed.data || parsed.data.resolution?.early)
    ? parsed.data
    : undefined;
}

export const syncRequiredSummary = (advice: Pick<SyncRequiredAdvice, 'paths' | 'more'>) =>
  `main changed ${advice.paths.length + advice.more} file(s) this queued landing also changes (${advice.paths.join(', ')}${advice.more ? ', …' : ''})`;

/** Server-side guidance text, shared by the mark and every read that shows it. */
export const syncRequiredNext = (
  advice: Pick<WouldConflict, 'paths' | 'more' | 'laneId'> & { predecessor?: unknown; next?: string },
) =>
  advice.predecessor
    ? advice.next!
    : `SYNC_REQUIRED: ${syncRequiredSummary(advice)}. Do not keep waiting on this entry: run land --save ` +
      `${advice.laneId ? `{"laneId":"${advice.laneId}"} ` : 'in its Lane '}` +
      'now; it syncs main in, saves and lands again, superseding this entry.';

/** Shared continuation: sync the exact early predecessor, or land --save against accepted main.
 * Every client surface (wait, land, observe, MCP) returns the same action for the same advice. */
export function syncRequiredContinuation(
  root: string,
  advice: SyncRequiredAdvice,
  input: { laneId?: string | undefined; message?: string | null | undefined } = {},
) {
  if ('predecessor' in advice) {
    const { groupId: _group, ...predecessor } = advice.predecessor;
    void _group;
    const parameters = { ...(input.laneId ? { laneId: input.laneId } : {}), predecessor };
    const command = `nforge agent ${shellQuote(root)} save --sync ${shellQuote(JSON.stringify(parameters))}`;
    return {
      code: 'COMPOSITION_CONFLICT' as const,
      earlyResolution: true,
      next: { action: 'sync', ...parameters },
      command,
      nextCommand: command,
      inProgress: false,
      instruction: `${advice.next} After the sync, edit and resolve the conflict it returns, then land --save; the exact predecessor head and receipt fence its check and acceptance.`,
    };
  }
  const laneId = advice.laneId ?? input.laneId;
  const parameters = {
    ...(laneId ? { laneId } : {}),
    ...(input.message ? { message: input.message } : {}),
  };
  const command = `nforge agent ${shellQuote(root)} land --save ${shellQuote(JSON.stringify(parameters))}`;
  return {
    code: 'SYNC_REQUIRED' as const,
    syncRequired: {
      paths: advice.paths,
      more: advice.more,
      landedSubmissionId: advice.landedSubmissionId,
      ...(laneId ? { laneId } : {}),
    },
    next: { action: 'land', save: true, ...parameters },
    command,
    nextCommand: command,
    inProgress: false,
    instruction:
      `SYNC_REQUIRED: ${syncRequiredSummary(advice)}. Stop waiting on this operation. Run command` +
      `${laneId ? '' : ' inside the Lane checkout'}: it syncs main in, saves and lands again, and ` +
      'the new landing supersedes this queued entry. Resolve any sync conflict it reports first.',
  };
}

/** One exact target and action for both cohort advice and save-time conflict notices. */
export function predecessorConflictAdvice(input: {
  predecessor: { submissionId: string; head: string; receiptId: string; groupId: string };
  laneId?: string;
  paths: string[];
  more: number;
  at: string;
  early: boolean;
  /** The waiting landing's own operation: early resolution off recommends waiting on it. */
  operationId?: string;
}) {
  const { groupId: _group, ...pin } = input.predecessor;
  void _group;
  const target = input.laneId
    ? `predecessor Lane ${input.laneId}`
    : `predecessor submission ${pin.submissionId}`;
  const files = `${input.paths.length ? input.paths.join(', ') : 'the retained conflict files'}${input.more ? ` (and ${input.more} more files)` : ''}`;
  // Item 577927f1: one recommended action with its plain reason and a complete command, and what a resolution made
  // now depends on. Run inside this Lane's checkout, the command needs no other argument.
  const command = `nforge agent . save --sync ${shellQuote(JSON.stringify({ predecessor: pin }))}`;
  const provisional =
    `A resolution made now is provisional: it is built on ${target} exactly as saved (State ${pin.head}, ` +
    `receipt ${pin.receiptId}) and lands only after that lands. If it fails or is replaced, this Lane goes back to ` +
    'its own last save, the combined save stays in history, and you resolve again.';
  return wouldConflictSchema.parse({
    code: 'COMPOSITION_CONFLICT',
    predecessor: input.predecessor,
    resolution: {
      early: input.early,
      mode: input.early ? 'on' : 'off',
      reason: input.early ? 'enabled' : 'owner-off',
    },
    paths: input.paths,
    more: input.more,
    at: input.at,
    next: input.early
      ? `Conflict: ${files} also changed in ${target}, which is ahead of this Lane and not on main yet. ` +
        `Recommended: Resolve now against this exact predecessor, so both land without waiting for it. Run: ${command}. ${provisional}`
      : `Conflict: ${files} also changed in ${target}, which is ahead of this Lane and not on main yet. ` +
        'Early resolution is off for this project, so the recommended action is to keep waiting: if it lands, ' +
        'this landing stops with COMPOSITION_CONFLICT and land --save syncs main in and lands again; if it fails, ' +
        'this landing goes on without it.' +
        (input.operationId
          ? ` Run: nforge agent . wait ${shellQuote(JSON.stringify({ operationIds: [input.operationId] }))}.`
          : '') +
        ` Or choose sync to resolve now: ${command}. ${provisional}`,
  });
}
