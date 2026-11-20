// SPDX-License-Identifier: Apache-2.0
// Purged Work journal rows (Item 4c9e961e, purge Lane 1). A purged row keeps its envelope (operation id, revision,
// actor, time, request hash) and, as its facts, its own command with every word replaced (redactPlanningWrite); it
// has no segment. Every reader accepts a row under one rule: it hashes to its request, or it names a purge command
// that exists, is itself whole, comes later in the journal and names the same Item. Healthy rows cost nothing extra;
// purged rows cost at most two indexed reads (two tables) per distinct purge in a page.
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import {
  planningPurgeSchema,
  purgedPlanningRowSchema,
  type PurgedPlanningRow,
} from '../src/work-planning-types';
import { metadataRequest } from '../src/work-metadata';

type Purge = { revision: number; itemId: string } | null;
type PurgeCache = Map<string, Purge>;

/** The redacted command a purged row keeps, or a journal refusal when it is malformed or still holds words. */
export function purgedFacts(command: string, purged: string) {
  let parsed;
  try {
    parsed = purgedPlanningRowSchema.safeParse({
      action: 'purged-planning-row',
      purgeOperationId: purged,
      command: JSON.parse(command),
    });
  } catch {
    parsed = { success: false as const };
  }
  invariant(parsed.success, 'INVALID_WORK_JOURNAL', 'A purged Work row has no valid facts.');
  return parsed.data.command;
}

/** The reducer's view of a purged row: the purge that removed its words and its redacted command. */
export function purgedHostedCommand(row: { command: string; purged: string }): PurgedPlanningRow {
  return {
    action: 'purged-planning-row',
    purgeOperationId: row.purged,
    command: purgedFacts(row.command, row.purged),
  };
}

/** The whole purge command an operation id names (its revision and Item), or null when there is none. */
async function purgeCommand(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
): Promise<Purge> {
  const event = await ctx.db
    .query('projectWorkEvents')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
  const body = event
    ? null
    : await ctx.db
        .query('projectHostedRecordBodies')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', projectId).eq('operationId', operationId),
        )
        .unique();
  const row = event ?? body;
  if (!row || row.purged !== undefined || row.revision === undefined || row.request === undefined)
    return null;
  // An archived purge keeps {action, itemId} as its facts (convex/projectJournalEffects.ts); a whole one must
  // still hash to its request.
  const text = row.command ?? (body?.journalSegment ? body.journalCommand : undefined);
  if (text === undefined) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw?.action !== 'purge-planning-item' || typeof raw.itemId !== 'string') return null;
  if (row.command !== undefined) {
    const command = planningPurgeSchema.safeParse(raw);
    if (!command.success || command.data.operationId !== operationId) return null;
    if (metadataRequest(command.data) !== row.request) return null;
  }
  return { revision: row.revision, itemId: raw.itemId };
}

/** Refuses a purged row unless its redacted command is its own operation's and the purge it names exists, is
 * whole, is later and names the same Item. */
export async function verifyPurgedRow(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  row: { operationId: string; revision: number; command: string; purged: string },
  cache: PurgeCache = new Map(),
) {
  const facts = purgedFacts(row.command, row.purged);
  invariant(
    facts.operationId === row.operationId,
    'INVALID_WORK_JOURNAL',
    'A purged Work row holds another operation’s command.',
  );
  if (!cache.has(row.purged)) cache.set(row.purged, await purgeCommand(ctx, projectId, row.purged));
  const purge = cache.get(row.purged)!;
  invariant(
    purge && purge.revision > row.revision && purge.itemId === facts.itemId,
    'INVALID_WORK_JOURNAL',
    'A purged Work row names no later purge of its Item.',
  );
  return facts;
}

/** Verify every purged row of one event page (one lookup per distinct purge; none when no row is purged). */
export async function verifyPurgedEvents(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  events: readonly { operationId: string; revision: number; command: string; purged?: string }[],
) {
  const cache: PurgeCache = new Map();
  for (const event of events)
    if (event.purged !== undefined)
      await verifyPurgedRow(ctx, projectId, { ...event, purged: event.purged }, cache);
}

/** A purged issue, comment or Intent version keeps its header and digest. It reads as purged only when the purge
 * it names exists and is for the Item the version belongs to; otherwise it stays the integrity failure it is. */
export async function verifiedPurgedRecord(
  ctx: QueryCtx | MutationCtx,
  row: { projectId: Id<'hostedProjects'>; kind: string; key: string; parent: string; purged: string },
) {
  const purge = await purgeCommand(ctx, row.projectId, row.purged);
  const itemId = row.kind === 'comment' ? row.parent : row.key;
  return !!purge && ['issue', 'comment', 'intent'].includes(row.kind) && purge.itemId === itemId;
}
