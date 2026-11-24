// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import type { GithubSyncCommit } from '../src/github-sync-types';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { composePageSchema } from '../src/hosted-compose';
import { LANDING_MESSAGE_BYTES, landingMessage, landingNote, mirrorMessage } from '../src/landing-message';
import { landingMessageText } from './projectHostedLandingMessageBody';
import {
  cohortMessageFields,
  cohortReceipt,
  readCohortReceipts,
  selectCohortReceipts,
} from './projectHostedAcceptanceMessage';
import { acceptancePage, acceptanceRow } from './projectHostedAcceptanceStore';

/** Default save/resolve notes written when the caller omitted a message (never preferred over Intent outcome). */
const DEFAULT_SAVE_MESSAGES = new Set([
  'Agent change',
  'Save before sync',
  'Bring the Lane binding up to date',
]);
const MAX_SAVE_SYNC_HOPS = 5;
const MAX_SAVE_INPUT_LANES = 8;
/** Total DB document reads save-message resolution may spend across one mirror begin() transaction
 * (single, cohort or catch-up). Keeps catch-up strictly bounded; once spent, falls back gracefully. */
const MAX_SAVE_LOOKUP_READS = 64;
const utf8 = new TextEncoder();
type LookupBudget = { reads: number };

const takeRead = (budget: LookupBudget) => {
  if (budget.reads <= 0) return false;
  budget.reads--;
  return true;
};

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function meaningfulSaveMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Escaping reserved Forge lines can expand text slightly; keep a wide margin below the 16 KiB cap.
  const bounded = utf8.encode(value).length <= LANDING_MESSAGE_BYTES / 2 ? value : landingNote(value);
  const clean = landingMessage(bounded).replace(/^\n+/, '');
  const trimmed = clean.trim();
  return trimmed && !DEFAULT_SAVE_MESSAGES.has(trimmed) ? clean : undefined;
}

/** Resolve the landed save's message for one pinned Lane input (friction 127ddf49). Walks at most
 * MAX_SAVE_SYNC_HOPS syncs/resolutions back to the save that created the Lane's source changes, and
 * never crosses another save (so a default placeholder save never borrows an earlier landing's note).
 * Never throws on unexpected metadata: mirror begin() falls back to Intent outcome instead of stalling. */
async function laneSaveMessage(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  entry: { laneId: string; head: string; sourceVersion: number },
  budget: LookupBudget,
): Promise<string | undefined> {
  let { laneId, head, sourceVersion } = entry;
  const seen = new Set<string>();
  for (let hop = 0; hop <= MAX_SAVE_SYNC_HOPS; hop++) {
    if (seen.has(head) || !takeRead(budget)) return undefined;
    seen.add(head);
    const state = await ctx.db
      .query('projectHostedStates')
      .withIndex('by_project_and_head', q => q.eq('projectId', projectId).eq('head', head))
      .first();
    if (!state || !takeRead(budget)) return undefined;
    const save = await ctx.db
      .query('projectHostedSaves')
      .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', state.jobId))
      .first();
    if (save) {
      const parsed = parseJson(save.value) as {
        request?: { laneId?: string; expected?: { sourceVersion?: number }; message?: string };
      } | null;
      const request = parsed?.request;
      if (request?.laneId !== laneId || request.expected?.sourceVersion !== sourceVersion - 1)
        return undefined;
      return meaningfulSaveMessage(request.message);
    }
    if (!takeRead(budget)) return undefined;
    const sync = await ctx.db
      .query('projectHostedSyncs')
      .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', state.jobId))
      .first();
    if (!sync) return undefined;
    const value = parseJson(sync.value) as {
      request?: {
        kind?: string;
        laneId?: string;
        message?: string;
        expected?: { head?: string; sourceVersion?: number };
      };
      origin?: { laneId: string; head: string; sourceVersion: number };
      resolutionLaneId?: string;
    } | null;
    const request = value?.request;
    if (!request) return undefined;
    if (
      (request.kind === 'sync' || request.kind === 'resolve') &&
      request.laneId === laneId &&
      request.expected?.sourceVersion === sourceVersion - 1 &&
      typeof request.expected.head === 'string'
    ) {
      if (request.kind === 'resolve') {
        const note = meaningfulSaveMessage(request.message);
        if (note) return note;
      }
      head = request.expected.head;
      sourceVersion = request.expected.sourceVersion;
      continue;
    }
    if (request.kind === 'sync' && value.resolutionLaneId === laneId && sourceVersion === 0 && value.origin) {
      laneId = value.origin.laneId;
      head = value.origin.head;
      sourceVersion = value.origin.sourceVersion;
      continue;
    }
    if (request.kind === 'revert' && value.resolutionLaneId === laneId && sourceVersion === 0)
      return meaningfulSaveMessage(request.message);
    return undefined;
  }
  return undefined;
}

/** Bounded save-message lookup for a receipt whose landing omitted its own message (0 reads when
 * a landing message was supplied). Reads only input page 0 (at most MAX_SAVE_INPUT_LANES Lanes),
 * shares one read cap across the whole mirror begin() step, and never throws on malformed rows. */
async function landedSaveMessage(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  receiptId: string,
  budget: LookupBudget,
): Promise<string | undefined> {
  if (!takeRead(budget)) return undefined;
  const page = await acceptancePage(ctx, { projectId, receiptId, kind: 'inputs', index: 0 });
  if (!page) return undefined;
  const parsed = composePageSchema.safeParse(parseJson(page.value));
  if (!parsed.success) return undefined;
  const messages: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const entry of parsed.data.entries.slice(0, MAX_SAVE_INPUT_LANES)) {
    if (!('laneId' in entry)) continue;
    const message = await laneSaveMessage(ctx, projectId, entry, budget);
    if (!message || seen.has(message)) continue;
    const added = utf8.encode(message).length + (messages.length ? 2 : 0);
    if (bytes + added > LANDING_MESSAGE_BYTES) break;
    seen.add(message);
    messages.push(message);
    bytes += added;
  }
  return messages.length ? messages.join('\n\n') : undefined;
}

/** Adjacent publishes resolve the selected receipt or cohort. Catch-up uses the same bounded
 * receipts. seed() pins the message before GitHub IO, including on a lost-reply replay. */
export async function mirrorPublishMessage(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  receipt: HostedAcceptance,
  sequence: number,
  binding: GithubSyncCommit | null,
  fallback: () => Promise<string>,
) {
  const budget: LookupBudget = { reads: MAX_SAVE_LOOKUP_READS };
  const input = {
    ...receipt,
    state: receipt.candidate.head,
    acceptanceId: receipt.id,
    viewId: receipt.candidate.id,
  };
  if (!binding || receipt.previous.head === binding.state) {
    let fields = cohortReceipt(receipt)
      ? await cohortMessageFields(
          ctx,
          projectId,
          receipt,
          sequence,
          await readCohortReceipts(ctx, projectId, receipt, sequence),
        )
      : undefined;
    if (fields) {
      let resolved = false;
      const members = [];
      for (const member of fields.members) {
        if (member.message !== undefined || !member.acceptanceId) {
          members.push(member);
          continue;
        }
        const save = await landedSaveMessage(ctx, projectId, member.acceptanceId, budget);
        if (save === undefined) {
          members.push(member);
          continue;
        }
        resolved = true;
        members.push({ ...member, message: save });
      }
      if (resolved)
        fields = {
          ...fields,
          cohortMessages: members.flatMap(member => (member.message === undefined ? [] : [member.message])),
          members,
        };
    }
    const explicit = fields?.members.at(-1)?.message ?? (await landingMessageText(ctx, projectId, receipt));
    const message =
      fields || explicit !== undefined
        ? explicit
        : await landedSaveMessage(ctx, projectId, receipt.id, budget);
    return mirrorMessage({
      ...input,
      ...fields,
      message,
      fallback: message !== undefined || fields?.cohortMessages.length ? '' : await fallback(),
    });
  }
  const previous = await acceptanceRow(ctx, { projectId, receiptId: binding.acceptanceId });
  const covered = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_sequence', q =>
      q
        .eq('projectId', projectId)
        .gt('sequence', previous?.sequence ?? 0)
        .lte('sequence', sequence),
    )
    .order('asc')
    .take(21);
  // Native/import mappings may precede the first hosted receipt and its nonzero source revision.
  const count = sequence - (previous?.sequence ?? (covered[0]?.sequence ?? sequence) - 1);
  const landings = covered
    .slice(0, 20)
    .map(row => ({ sequence: row.sequence, receipt: hostedAcceptanceSchema.parse(JSON.parse(row.value)) }));
  const members: { message: string | undefined; agentClient: string | undefined }[] = [];
  for (const { receipt: landing } of landings) {
    const message =
      (await landingMessageText(ctx, projectId, landing)) ??
      (await landedSaveMessage(ctx, projectId, landing.id, budget));
    members.push({ message, agentClient: landing.agentClient });
  }
  const selected = new Map(landings.map(({ receipt }, index) => [receipt.id, members[index]!]));
  const lines: string[] = [];
  for (const [index, { receipt: landing, sequence }] of landings.entries()) {
    let cohortSubject = landing.cohortMessages?.[0];
    if (landing.cohortSize !== undefined) {
      const candidates =
        sequence - landing.cohortSize < landings[0]!.sequence
          ? await readCohortReceipts(ctx, projectId, landing, sequence)
          : landings;
      for (const member of selectCohortReceipts(projectId, landing, sequence, candidates)) {
        const cached = selected.get(member.id);
        cohortSubject = cached
          ? cached.message
          : ((await landingMessageText(ctx, projectId, member)) ??
            (await landedSaveMessage(ctx, projectId, member.id, budget)));
        if (cohortSubject !== undefined) break;
      }
    }
    const subject = (cohortSubject ?? members[index]!.message ?? 'Forge landing').split('\n')[0];
    lines.push(`- ${subject || 'Forge landing'} (${landing.id.slice(0, 8)})`);
  }
  if (count > lines.length) lines.push(`…and ${count - lines.length} more`);
  return mirrorMessage({
    ...input,
    message: undefined,
    cohortMessages: undefined,
    members,
    fallback: `Catch up ${count} Forge landings\n\n${lines.join('\n')}`,
  });
}
