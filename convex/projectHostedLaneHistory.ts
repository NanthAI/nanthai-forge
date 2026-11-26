// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { JournalNeeded, journalReadReply, journalDependency } from './projectJournalStore';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { query, type QueryCtx } from './cliServer';
import { hostedRecordBody, readHostedRecord } from './projectHostedRecords';
import { accessibleProject, authorizedReadProject, readProjectRole } from './projectAuthority';
import { isDeviceIdentity } from './cliServer';
import { mayReturnLaneSave } from './projectLaneAuthority';
import { saveRow } from './projectHostedSaveStore';
import { liveLaneFinish } from './projectHostedLaneFinish';
import { sourceAuthority } from '../src/hosted-source-authority';
import { hostedRecordSchema } from '../src/hosted-records';
import { saveExpectedSchema, saveRequestSchema } from '../src/hosted-save';
import type { OverlapChange } from '../src/hosted-overlap';
import { laneHolderFor } from './projectAudience';
import { deploysForSequence } from './projectDeployStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { isPlanningPrefix, planningIdMaxCandidates } from '../src/planning-id';
import { hostedLaneSchema } from '../src/hosted-lane';
import { invariant } from '../src/errors';
import { report } from './errors';

/** One Lane's history from rows already stored: when it opened, the main it started from, the main it
 * was last synced to, and its landing. Six indexed reads (head, record body, first record, its body, overlap
 * row), a few hundred bytes of reply, no writes, no idle work. Works for open, landed and abandoned Lanes. */
export const read = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string() },
  returns: v.string(),
  handler: journalLaneHistoryRead,
});

/** Open History only: eight save headers, bodies and original save metadata, no source objects.
 * The overlap preview is already capped at save time; only the first three paths leave the server. */
const SAVE_PAGE = 8;
export const saves = query({
  args: { projectId: v.id('hostedProjects'), laneId: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    authorityEpoch: v.number(),
    expected: v.object({
      head: v.string(),
      version: v.number(),
      sourceVersion: v.number(),
      lifecycleVersion: v.number(),
    }),
    refusal: v.union(v.null(), v.literal('closed'), v.literal('native'), v.literal('not-yours')),
    waiting: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
    items: v.array(
      v.object({
        id: v.string(),
        head: v.string(),
        at: v.string(),
        summary: v.union(v.string(), v.null()),
        fileCount: v.union(v.number(), v.null()),
        paths: v.array(v.string()),
      }),
    ),
  }),
  handler: async (ctx, { projectId, laneId, cursor }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read this Lane’s saves.');
      const actor = user.subject;
      const current = await readHostedRecord(ctx, { projectId, actor, kind: 'lane', key: laneId });
      invariant(current, 'NOT_FOUND', 'This Lane is not on this project.');
      const lane = hostedLaneSchema.parse(JSON.parse(current.value));
      const project = authorizedReadProject(ctx, projectId);
      invariant(
        project,
        'PROJECT_UNAVAILABLE',
        'This Forge project is unavailable with the current account.',
      );
      const authority = sourceAuthority(project);
      const role = await readProjectRole(ctx, project, actor);
      const refusal: 'closed' | 'native' | 'not-yours' | null =
        lane.state !== 'active'
          ? 'closed'
          : authority.mode === 'native-owner'
            ? 'native'
            : isDeviceIdentity(user) ||
                (role !== 'owner' && role !== 'write') ||
                !mayReturnLaneSave(project, lane, actor)
              ? 'not-yours'
              : null;
      const page = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_parent', q =>
          q.eq('projectId', projectId).eq('kind', 'save').eq('parent', laneId),
        )
        .order('desc')
        .paginate({ cursor, numItems: SAVE_PAGE, maximumRowsRead: SAVE_PAGE, maximumBytesRead: 16 * 1024 });
      const [items, live] = await Promise.all([
        Promise.all(
          page.page.map(async head => {
            const row = await ctx.db.get(head.recordId);
            invariant(
              row?.projectId === projectId &&
                row.kind === 'save' &&
                row.parent === laneId &&
                row.key === head.key,
              'SOURCE_UNAVAILABLE',
              'A selected Lane save is unavailable.',
            );
            const save = hostedRecordSchema.options[2].parse(JSON.parse(await hostedRecordBody(ctx, row)));
            const metadata = await saveRow(ctx, {
              projectId,
              actor: save.actor,
              operationId: save.operationId,
            });
            const stored = metadata
              ? (JSON.parse(metadata.value) as { request?: unknown; overlapChanges?: string })
              : null;
            const request = saveRequestSchema.safeParse(stored?.request);
            const pins =
              request.success &&
              request.data.laneId === laneId &&
              request.data.expected.head === save.expectedHead &&
              request.data.expected.sourceVersion === save.expectedSourceVersion
                ? request.data
                : null;
            const preview: OverlapChange[] =
              pins && stored?.overlapChanges ? JSON.parse(stored.overlapChanges) : [];
            return {
              id: save.id,
              head: save.head,
              at: save.at,
              summary:
                pins?.message
                  .split('\n')
                  .find(line => line.trim())
                  ?.trim()
                  .slice(0, 240) ?? null,
              fileCount: pins?.changeCount ?? null,
              paths: preview.slice(0, 3).map(change => change.path),
            };
          }),
        ),
        !refusal && (cursor !== null || page.page.length > 1 || !page.isDone)
          ? liveLaneFinish(ctx, { projectId, laneId, headWrittenAt: lane.at })
          : null,
      ]);
      return {
        authorityEpoch: authority.epoch,
        expected: saveExpectedSchema.parse(lane),
        refusal,
        waiting: Boolean(live),
        nextCursor: page.isDone ? null : page.continueCursor,
        items,
      };
    } catch (error) {
      return report(error);
    }
  },
});

/** Full ids of this project's Lanes whose id starts with `prefix` (8 to 35 lowercase hex), for a short
 * Lane id the CLI could not resolve from the Lanes this machine opened (ad80e037). One range read on the
 * existing record-heads index, at most one row past the candidate limit; no bodies, no writes. */
export const resolveLaneId = query({
  args: { projectId: v.id('hostedProjects'), prefix: v.string() },
  returns: v.string(),
  handler: async (ctx, { projectId, prefix }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted work.');
      await accessibleProject(ctx, projectId, user.subject);
      invariant(
        isPlanningPrefix(prefix) && prefix === prefix.toLowerCase(),
        'BAD_ARGUMENT',
        'prefix must be 8 to 35 lowercase hex characters.',
      );
      const rows = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_key', q =>
          q.eq('projectId', projectId).eq('kind', 'lane').gte('key', prefix).lt('key', `${prefix}\uffff`),
        )
        .take(planningIdMaxCandidates + 1);
      return canonicalPayload({
        ids: rows.slice(0, planningIdMaxCandidates).map(row => row.key),
        more: rows.length > planningIdMaxCandidates,
      });
    } catch (error) {
      return report(error);
    }
  },
});

export async function journalLaneHistoryRead(
  ctx: QueryCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string },
) {
  try {
    const user = await ctx.auth.getUserIdentity();
    invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted work.');
    const key = {
      projectId: input.projectId,
      actor: user.subject,
      kind: 'lane' as const,
      key: input.laneId,
    };
    const current = await readHostedRecord(ctx, key);
    invariant(current, 'NOT_FOUND', 'Hosted Lane not found on this project.');
    const lane = hostedLaneSchema.parse(JSON.parse(current.value));
    // readHostedRecord authorized this exact project row; the holder follows the coordination audience.
    const project = authorizedReadProject(ctx, input.projectId);
    const holder = project ? await laneHolderFor(ctx, project, user.subject, lane.holder) : undefined;
    const landed = (
      await ctx.db
        .query('projectHostedOverlapLanes')
        .withIndex('by_project_and_lane', q => q.eq('projectId', input.projectId).eq('laneId', input.laneId))
        .unique()
    )?.landed;
    journalDependency(ctx, 'landing-stamp', landed ?? null);
    const acceptance = landed
      ? await ctx.db
          .query('projectHostedAcceptances')
          .withIndex('by_project_and_receipt', q =>
            q.eq('projectId', input.projectId).eq('receiptId', landed.receiptId),
          )
          .unique()
      : null;
    const deploys =
      acceptance && project ? await deploysForSequence(ctx, project, acceptance.sequence) : null;
    // Version 0 is the record written at start: its time is the open time, its base the first main.
    const first = lane.version === 0 ? current : await readHostedRecord(ctx, { ...key, version: 0 });
    const opened = first ? hostedLaneSchema.parse(JSON.parse(first.value)) : null;
    return JSON.stringify({
      schema: 1,
      laneId: lane.id,
      intentId: lane.intentId,
      state: lane.state,
      openedAt: opened?.at ?? null,
      // The main the Lane started from, and the main its pinned base is now (they differ after a sync).
      startBase: opened?.base ?? null,
      lastSyncedBase: lane.base,
      synced: opened ? opened.base.receiptId !== lane.base.receiptId : null,
      head: lane.head,
      version: lane.version,
      lastActivityAt: lane.at,
      holder: holder ?? null,
      // Present once an accepted receipt carried one of this Lane's saved heads; null otherwise
      // (never landed, or landed before the landing stamp existed).
      landing: landed
        ? {
            receiptId: landed.receiptId,
            commit: landed.commit,
            head: landed.laneHead,
            at: landed.at,
            // A reverted landing is off main: not current even while the Lane still holds that head.
            current: landed.laneHead === lane.head && !landed.revertedBy,
            ...(landed.revertedBy ? { revertedBy: landed.revertedBy } : {}),
            // Main-red holds it waited under before this landing (held, released; Item 687d1eda).
            ...(landed.mainRedHolds ? { mainRedHolds: landed.mainRedHolds } : {}),
            // First successful deploy per target whose head contains this landing (Item 8b6efb50).
            ...(deploys ? { deploys } : {}),
          }
        : null,
    });
  } catch (error) {
    if (error instanceof JournalNeeded) return journalReadReply(ctx, error, input.projectId);
    return report(error);
  }
}
