// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { changeItemRetention } from './projectItemRetentionStore';
import { wakeJournal, journalGraceMs } from './projectJournalWake';
import { JournalNeeded } from './projectJournalStore';
import type { QueryCtx } from './_generated/server';
import { canonicalPayload } from '../src/hosted-source-operation';
import { findWorkEvent, type StoredWorkEvent } from './projectWorkEventStore';
import { retainedEventPage } from './projectWorkEventPage';
import { verifyPurgedEvents } from './projectWorkPurgedRows';
import { requireSourceAuthority } from '../src/hosted-source-authority';
import { indexActivity } from '../src/work-hosted-index';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { commandProjection } from './projectWorkProjection';
import { memberPlanningWrite } from './projectPlanningWriteAccess';
import type { PlanningWriteContext } from './projectWorkCommandContext';
import { workProject, setWorkHead } from './projectWorkHead';
import { acceptanceEvidence } from './autonomyFields';
import { acceptanceActor } from './projectAutonomy';
import {
  effectivePolicy,
  reviewReason,
  hostedAcceptanceCommandSchema as hostedChannelCommandSchema,
} from '../src/autonomy-policy';
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query, internalQuery, internalMutation } from './cliServer';
import { projectDocument, hostedWorkEventDocument } from './schema';
import {
  ownedProject,
  accessibleProject,
  activeOwnedProject,
  activeProject,
  requireDeviceLandingPaths,
} from './projectAuthority';
import { intentAuthority } from './projectContributors';
import { metadataCommandSchema } from '../src/work-intent-types';
import { planningCommentPurgeSchema, planningPurgeSchema } from '../src/work-planning-types';
import { invariant } from '../src/errors';
import { acceptancePolicyDigest } from '../src/policy-digest';
import { indexEntry } from './projectWorkIndexFields';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { internal } from './_generated/api';
import { report } from './errors';
import { chargeAccountChannel } from './accountLimits';
import { emitChange, workChange } from './coordinationWrite';
import { movePlanLaneMark } from './projectPlanLaneMarks';
import { storeProjection } from './projectWorkStore';
import { bornRecordStore } from './projectHostedBirth';
import { projectForViewer } from './projectViewerFields';

/** The project record every open tab subscribes to (name, owner, selected source). A non-owner gets only the
 * fields the screens read (convex/projectViewerFields.ts, Item 5ba7c7f9). It does not read the
 * Work head row, so a journal write does not re-run it for each tab; `work.revision` here is the seed
 * value, not the live one. The live revision is `projectWorkIndex:workspace` (and the internal `get`). */
export const state = query({
  args: { projectId: v.id('hostedProjects') },
  returns: projectDocument,
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      return projectForViewer(await accessibleProject(ctx, projectId, user.subject), user.subject);
    } catch (error) {
      return report(error);
    }
  },
});
// Observe only the selected backup row, including an in-place transport conversion.
export const sourceTransport = query({
  args: { projectId: v.id('hostedProjects'), backupId: v.id('projectBackups') },
  returns: v.object({
    backupId: v.id('projectBackups'),
    digest: v.string(),
    head: v.string(),
    kind: v.union(v.literal('native'), v.literal('git')),
    transport: v.union(v.literal('archive'), v.literal('objects')),
    manifestDigest: v.string(),
  }),
  handler: async (ctx, { projectId, backupId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      await accessibleProject(ctx, projectId, user.subject);
      const backup = await ctx.db.get(backupId);
      invariant(
        backup?.projectId === projectId && backup.status === 'stored',
        'PROJECT_UNAVAILABLE',
        'Select this project’s stored source and Work.',
      );
      return {
        backupId,
        digest: backup.digest,
        head: backup.preview.head,
        kind: backup.preview.format === 'native' ? ('native' as const) : ('git' as const),
        transport: backup.transport ?? ('archive' as const),
        manifestDigest:
          backup.scrubbed?.root.sha256 ?? backup.objectManifest?.digest ?? backup.preview.manifestDigest,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const get = internalQuery({
  args: { projectId: v.id('hostedProjects'), owner: v.string() },
  returns: projectDocument,
  handler: async (ctx, { projectId, owner }) => {
    try {
      return await workProject(ctx, await accessibleProject(ctx, projectId, owner));
    } catch (error) {
      return report(error);
    }
  },
});
export const owner = internalQuery({
  args: { projectId: v.id('hostedProjects'), owner: v.string() },
  returns: projectDocument,
  handler: async (ctx, { projectId, owner }) => {
    try {
      return await ownedProject(ctx, projectId, owner);
    } catch (error) {
      return report(error);
    }
  },
});
export const find = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    command: v.optional(v.string()),
  },
  returns: v.union(hostedWorkEventDocument, v.null()),
  handler: async (ctx, { projectId, owner, operationId, command }) => {
    try {
      await accessibleProject(ctx, projectId, owner);
      const event = await findWorkEvent(ctx, projectId, operationId, command ? { command } : undefined);
      invariant(
        !event || event.actor === owner,
        'WORK_OPERATION_CHANGED',
        'This operation belongs to another actor.',
      );
      return event;
    } catch (error) {
      return report(error);
    }
  },
});
export const events = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    initialRevision: v.number(),
    revision: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.union(
    paginationResultValidator(hostedWorkEventDocument),
    v.object({ journalHistory: v.literal(true), index: v.string() }),
  ),
  handler: journalWorkEvents,
});
export const initialize = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    backupId: v.id('projectBackups'),
    operationId: v.string(),
    revision: v.number(),
    workSchema: v.optional(v.number()),
    importRequired: v.optional(v.literal(true)),
  },
  returns: projectDocument,
  handler: async (ctx, { projectId, owner, backupId, operationId, revision, workSchema, importRequired }) => {
    try {
      const project = await activeOwnedProject(ctx, projectId, owner),
        backup = await ctx.db.get(backupId);
      invariant(
        backup?.projectId === projectId && backup.status === 'stored',
        'PROJECT_UNAVAILABLE',
        'Select this project’s stored source and Work.',
      );
      if (project.work) {
        invariant(
          (project.work.originBackupId ?? project.work.backupId) === backupId &&
            project.work.operationId === operationId,
          'PROJECT_WORK_EXISTS',
          'This project already has hosted Work. Its source and journal remain selected.',
        );
        return project;
      }
      const imported = backup.initialWorkImport;
      const completedImport = imported?.operationId === operationId && imported.next === imported.total;
      invariant(
        (!importRequired && revision === 0) ||
          (project.currentBackup === backupId &&
            (project.workStoreCutoverRevision === revision || completedImport)),
        'INVALID_WORK_BACKUP',
        'Initialize nonempty Work only after its selected backup imported the record store.',
      );
      const initialGeneration =
        workSchema === undefined || project.currentBackup !== backupId
          ? null
          : await ctx.db
              .query('projectWorkGenerations')
              .withIndex('by_project_and_backup_and_revision_and_format_and_work_schema', q =>
                q
                  .eq('projectId', projectId)
                  .eq('backupId', backupId)
                  .eq('revision', revision)
                  .eq('format', HOSTED_WORK_INDEX_FORMAT)
                  .eq('workSchema', workSchema),
              )
              .unique();
      const generationId = initialGeneration?.status === 'ready' ? initialGeneration._id : undefined;
      const emptyResume =
        !importRequired &&
        revision === 0 &&
        project.workStoreCutoverRevision === undefined &&
        project.workStoreEventWindows === undefined;
      await ctx.db.patch(projectId, {
        ...(completedImport || emptyResume ? bornRecordStore(revision) : {}),
        work: {
          backupId,
          operationId,
          initialRevision: revision,
          revision,
          ...(generationId ? { generationId } : {}),
        },
        revision: project.revision + 1,
      });
      if (completedImport) await ctx.db.patch(backupId, { initialWorkImport: undefined });
      return (await ctx.db.get(projectId))!;
    } catch (error) {
      return report(error);
    }
  },
});
export const append = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    request: v.string(),
    previousRevision: v.number(),
    command: v.string(),
    authorityEpoch: v.optional(v.number()),
    projection: v.optional(
      v.object({
        generationId: v.id('projectWorkGenerations'),
        acceptance: v.optional(acceptanceEvidence),
        metadata: v.string(),
        entries: v.array(indexEntry),
        at: v.string(),
      }),
    ),
    /** A server-scheduled write as the owner (not charged to the account limiter). */
    server: v.optional(v.literal(true)),
  },
  returns: hostedWorkEventDocument,
  handler: appendWork,
});

export async function appendWork(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    owner: string;
    operationId: string;
    request: string;
    previousRevision: number;
    command: string;
    projection?: ReturnType<typeof commandProjection>;
    authorityEpoch?: number;
    planning?: PlanningWriteContext | undefined;
    planningRestore?: string | undefined;
    /** In-process proof from executeCommand after checking the exact Item and the member-write allowlist. */
    memberPlanning?: 'item' | 'tick';
    /** A server job writing as the owner (speed-budget Issues, a member's start): not charged. */
    server?: true;
  },
) {
  const { planning } = input;
  try {
    const project =
      planning?.project ?? (await workProject(ctx, await activeProject(ctx, input.projectId, input.owner)));
    const channelCommand = hostedChannelCommandSchema.safeParse(JSON.parse(input.command));
    if (channelCommand.success)
      requireSourceAuthority(project, { mode: 'native-owner', epoch: input.authorityEpoch ?? 0 });
    const parsed = metadataCommandSchema.safeParse(JSON.parse(input.command));
    // A purge is never a client command: only the server's purge step appends it, with its projection, so the
    // tombstone and its live checks (Deleted, expected version) land in the same mutation (Item 4c9e961e).
    const raw = JSON.parse(input.command);
    const purge = parsed.success
      ? undefined
      : (raw?.action === 'purge-planning-comment'
          ? planningCommentPurgeSchema
          : planningPurgeSchema
        ).safeParse(raw);
    if (purge?.success)
      invariant(
        project.owner === input.owner && purge.data.operationId === input.operationId && input.projection,
        'BAD_ARGUMENT',
        'Append a permanent deletion only from the server’s purge step, with its projection.',
      );
    const action = parsed.success ? parsed.data.action : purge?.success ? purge.data.action : undefined;
    const frozen =
      // F3 still reads old event windows and keeps anchored notes and comment purges in the journal.
      project.workStoreEventWindows?.at(-1)?.storeFirst === true &&
      (action === 'note' ||
        action === 'intent' ||
        action === 'intent-status' ||
        action === 'put-planning-item' ||
        action === 'comment-planning-item' ||
        action === 'purge-planning-item') &&
      (!parsed.success || parsed.data.action !== 'note' || !parsed.data.anchor);
    if (
      parsed.success &&
      (parsed.data.action === 'put-planning-item' || parsed.data.action === 'comment-planning-item')
    ) {
      invariant(
        project.owner === input.owner ||
          (input.memberPlanning &&
            input.projection &&
            memberPlanningWrite(parsed.data, input.memberPlanning === 'tick', true)),
        'PROJECT_UNAVAILABLE',
        'Project planning is available to its current owner.',
      );
      invariant(
        parsed.data.operationId === input.operationId,
        'BAD_ARGUMENT',
        'Use the planning command’s original operation UUID.',
      );
    } else if (project.owner !== input.owner) {
      const command = metadataCommandSchema.parse(JSON.parse(input.command));
      invariant(
        command.action === 'intent' || command.action === 'note' || command.action === 'intent-status',
        'PROJECT_UNAVAILABLE',
        'Select your existing contributor Work command.',
      );
      if (command.action !== 'intent')
        await intentAuthority(ctx, input.projectId, input.owner, command.intentId);
    }
    // The batch context comes from executeCommand after it checked this exact replay.
    const original = planning
      ? null
      : await findWorkEvent(ctx, input.projectId, input.operationId, { command: input.command });
    if (original) {
      invariant(
        original.actor === input.owner &&
          original.request === input.request &&
          original.previousRevision === input.previousRevision,
        'WORK_OPERATION_CHANGED',
        'Reconcile this operation’s original command and revision.',
      );
      return original;
    }
    if (channelCommand.success) {
      const actor = await acceptanceActor(ctx, channelCommand.data.agent),
        policy = effectivePolicy(project),
        evidence = input.projection?.acceptance;
      invariant(
        actor.id === input.owner && project.owner === actor.id,
        'PROJECT_UNAVAILABLE',
        'Channel acceptance requires the current signed-in project owner.',
      );
      invariant(
        evidence && acceptancePolicyDigest(evidence.policy) === acceptancePolicyDigest(policy),
        'POLICY_CHANGED',
        'Project policy changed during acceptance. Refresh before accepting.',
      );
      invariant(
        evidence.containsPrevious,
        'CHANNEL_DIVERGED',
        'Acceptance would lose the current Channel head.',
      );
      // A folder-grant device cannot move a Channel (df06081d): this route's changed-file list is complete only
      // when protected paths are set, so its files are treated as unknown. Device sign-ins only.
      await requireDeviceLandingPaths(ctx, null);
      const reason = reviewReason(policy, actor, evidence.paths);
      invariant(!reason, 'REVIEW_REQUIRED', reason ?? 'Waiting for review by a person');
      if (actor.kind === 'agent') {
        const generation = await selectedGeneration(ctx, project);
        invariant(
          generation && generation._id === input.projection?.generationId,
          'WORK_STALE',
          'Hosted source changed during acceptance.',
        );
        const storedRun = evidence.automatic?.runId
          ? await record(ctx, recordPartition(generation), 'runs', evidence.automatic.runId)
          : null;
        const run = storedRun ? JSON.parse(storedRun.value) : null;
        invariant(
          run?.status === 'passed' &&
            run.checkSelection?.scope !== 'partial' &&
            run.head === channelCommand.data.head &&
            run.viewId === channelCommand.data.viewId,
          'CHECK_REQUIRED',
          'Automatic acceptance requires a passing check for this exact View at the Channel boundary.',
        );
      }
      invariant(
        actor.kind === 'person' || (evidence.automatic?.actor === actor.id && evidence.automatic.runId),
        'CHECK_REQUIRED',
        'Automatic acceptance requires exact-View passing evidence.',
      );
    }
    invariant(
      (planning ? planning.revision : project.work?.revision) === input.previousRevision,
      'WORK_STALE',
      'Hosted Work changed. Your request and existing work remain available.',
    );
    const generation = input.projection
      ? (planning?.selected ?? (await selectedGeneration(ctx, project)))
      : null;
    if (input.projection)
      invariant(
        generation?._id === input.projection.generationId,
        'WORK_STALE',
        'Hosted source or Work changed.',
      );
    invariant(
      !frozen || input.projection,
      'SOURCE_UNAVAILABLE',
      'Retain the primary Work version before acknowledging its command.',
    );
    // Comments, puts, notes and new Intents carry messages: one shared per-account daily limit and the
    // suspend switch, charged only for a fresh, validated operation (replays and stale requests are free).
    if (parsed.success && !input.server) {
      const own = project.owner === input.owner;
      if (parsed.data.action === 'intent') await chargeAccountChannel(ctx, input.owner, 'start');
      else if (['put-planning-item', 'comment-planning-item', 'note'].includes(parsed.data.action))
        await chargeAccountChannel(ctx, input.owner, own ? 'planning' : 'contributed');
    }
    const event = {
      projectId: input.projectId,
      operationId: input.operationId,
      request: input.request,
      previousRevision: input.previousRevision,
      revision: input.previousRevision + 1,
      command: input.command,
      ...(input.projection?.acceptance?.automatic
        ? { automatic: input.projection.acceptance.automatic }
        : {}),
      actor: input.owner,
      at: input.projection?.at ?? new Date().toISOString(),
      ...(JSON.parse(input.command).action === 'intent' ? { baseBackupId: project.work!.backupId } : {}),
    };
    let retained: StoredWorkEvent | null = null;
    if (input.projection) {
      for (const entry of input.projection.entries) {
        const old = await (planning?.record(entry.collection, entry.key) ??
          record(ctx, recordPartition(generation!), entry.collection, entry.key));
        planning?.invalidate(entry.collection, entry.key);
        if (
          entry.collection === 'planningItems' &&
          (action === 'put-planning-item' ||
            action === 'comment-planning-item' ||
            action === 'purge-planning-item')
        ) {
          const previous = old ? JSON.parse(old.value) : null;
          const next = JSON.parse(entry.value);
          await changeItemRetention(ctx, project._id, previous, next, entry.position);
          await movePlanLaneMark(ctx, project._id, previous, next);
        }
        const restoresLink = entry.collection === 'planningSearch' && input.planningRestore;
        if (old) {
          if (!entry.collection.endsWith(':payload')) {
            const payloadKey = JSON.parse(old.value).payloadKey;
            if (payloadKey && JSON.parse(entry.value).payloadKey !== payloadKey)
              await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.retirePayload, {
                projectId: project._id,
                generationId: recordPartition(generation!),
                collection: entry.collection,
                key: entry.key,
                payloadKey,
              });
          }
          const replacedLink =
            entry.collection === 'planningSearch' &&
            'planningRestored' in old &&
            JSON.parse(old.value).parentId !== JSON.parse(entry.value).parentId;
          await ctx.db.patch(old._id, {
            ...entry,
            ...indexActivity(entry),
            ...(restoresLink || replacedLink ? { planningRestored: input.planningRestore } : {}),
          });
        } else
          await ctx.db.insert('projectWorkRecords', {
            ...entry,
            ...indexActivity(entry),
            ...(restoresLink ? { planningRestored: input.planningRestore } : {}),
            projectId: project._id,
            generationId: recordPartition(generation!),
          });
      }
      retained = await storeProjection(
        ctx,
        project,
        input.projection.entries,
        frozen
          ? {
              projectId: event.projectId,
              operationId: event.operationId,
              request: event.request,
              revision: event.revision,
              actor: event.actor,
              at: event.at,
              command: event.command,
              ...(event.baseBackupId ? { baseBackupId: event.baseBackupId } : {}),
            }
          : undefined,
        action === 'intent' ? input.operationId : undefined,
      );
      const metadata = JSON.parse(input.projection.metadata);
      if (parsed.success && (parsed.data.action === 'intent' || parsed.data.action === 'intent-status')) {
        const active = await ctx.db
          .query('projectWorkRecords')
          .withIndex('by_generation_and_collection_and_status_and_position', q =>
            q
              .eq('generationId', recordPartition(generation!))
              .eq('collection', 'intents')
              .eq('status', 'active'),
          )
          .order('desc')
          .take(1);
        const last =
          active[0] ??
          (
            await ctx.db
              .query('projectWorkRecords')
              .withIndex('by_generation_and_collection_and_position', q =>
                q.eq('generationId', recordPartition(generation!)).eq('collection', 'intents'),
              )
              .order('desc')
              .take(1)
          )[0];
        metadata.defaultIntentId = last?.key;
      }
      await setWorkHead(
        ctx,
        project._id,
        project.work!.backupId,
        input.previousRevision + 1,
        JSON.stringify(metadata),
        planning,
      );
    }
    invariant(
      !frozen || retained,
      'SOURCE_UNAVAILABLE',
      'Retain the primary Work version before acknowledging its command.',
    );
    if (retained)
      await wakeJournal(
        ctx,
        { projectId: input.projectId, operationId: `work:${input.operationId}` },
        Date.now() + journalGraceMs,
      );
    const saved = retained ?? (await ctx.db.get(await ctx.db.insert('projectWorkEvents', event)))!;
    await emitChange(ctx, {
      projectId: input.projectId,
      actor: input.owner,
      operationId: `work:${input.operationId}`,
      source: 'work',
      ...workChange(input.command),
    });
    if (!input.projection) {
      await setWorkHead(ctx, project._id, project.work!.backupId, input.previousRevision + 1);
      await ctx.db.patch(project._id, { work: { ...project.work!, generationId: undefined } });
    }
    return saved;
  } catch (error) {
    return report(error);
  }
}

export async function journalWorkEvents(
  ctx: QueryCtx,
  {
    projectId,
    owner,
    initialRevision,
    revision,
    paginationOpts,
  }: {
    projectId: Id<'hostedProjects'>;
    owner: string;
    initialRevision: number;
    revision: number;
    paginationOpts: {
      cursor: string | null;
      numItems: number;
      maximumBytesRead?: number;
      maximumRowsRead?: number;
    };
  },
) {
  try {
    const project = await accessibleProject(ctx, projectId, owner);
    if (project.workStoreCutoverRevision !== undefined && revision > project.workStoreCutoverRevision)
      return await retainedEventPage(ctx, project, { initialRevision, revision, paginationOpts });
    const page = await ctx.db
      .query('projectWorkEvents')
      .withIndex('by_project_and_revision', q =>
        q.eq('projectId', projectId).gt('revision', initialRevision).lte('revision', revision),
      )
      .order('asc')
      .paginate(paginationOpts);
    await verifyPurgedEvents(ctx, projectId, page.page);
    return page;
  } catch (error) {
    if (error instanceof JournalNeeded)
      return { journalHistory: true as const, index: canonicalPayload(error.index) };
    return report(error);
  }
}
