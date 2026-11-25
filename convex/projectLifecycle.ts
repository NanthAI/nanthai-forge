// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { cancelPendingTask } from './schedulerCancel';
import { queueProjectSnapshots } from './publicSnapshotJobs';
import { scheduleR2Purge } from './projectPurgeScheduling';
import { noteDeleteOutcome } from './projectDeleteRequestOutcome';
import { claimSlug, ensureProjectSlug, restoreProjectSlug, slugTaken } from './urlIdentity';
import { blobStore } from './blobStore';
import { invariant as check } from '../src/errors';
import { purgeExchangeObjects } from './projectObjectLifecycle';
import { v } from 'convex/values';
import { requireOwnerPerson } from './ownerPerson';
import { isDeviceIdentity, mutation } from './cliServer';
import { heldReplay, holdSetting, settingKey, settingReply } from './projectSettingApprovals';
import type { ApprovalRow } from './projectHostedApprovalStore';
import { activeOwnedProject } from './projectAuthority';
import { canonicalPayload } from '../src/hosted-source-operation';
import { internalMutation, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import { report } from './errors';
import { projectExecution } from './projectExecution';
import { startRetention, stopRetention, purgeSettleMs } from './projectRetention';
import { purgeProjectRowsPage } from './projectPurgeRows';
import { projectPurgeWriter } from './projectFinishReadWriter';
import { dropProjectOrder, restoreProjectOrder } from './accountProjectOrder';
import { latestLanding } from './projectLatestLanding';
import { receiptOf, restoreReceipt, undoOpen, type RestoreReceipt } from './projectRestoreReceipt';

const args = { projectId: v.id('hostedProjects'), operationId: v.string(), expectedRevision: v.number() };
async function schedule(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  if (project.task) {
    const task = await ctx.db.system.get(project.task);
    if (task && ['pending', 'inProgress'].includes(task.state.kind)) return;
  }
  if (project.r2Purge && !project.r2PrefixPurged) return scheduleR2Purge(ctx, project);
  const task = await ctx.scheduler.runAfter(0, internal.projectLifecycle.purge, { projectId: project._id });
  await ctx.db.patch(project._id, { task });
}
export async function transition(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; operationId: string; expectedRevision: number; confirm?: string },
  action: 'trash' | 'restore' | 'delete',
  /** Account deletion carries its own reviewed plan as the confirmation. `guard` checks a caller's own evidence pin
   * on a new owner transition, after authority and replay and before the revision check. */
  options: { confirmed?: boolean; guard?: (project: Doc<'hostedProjects'>) => Promise<void> } = {},
): Promise<RestoreReceipt | null> {
  const user = await ctx.auth.getUserIdentity(),
    project = await ctx.db.get(input.projectId);
  projectExecution(
    ctx,
    input.projectId,
    user && project?.owner === user.subject ? project.name : undefined,
    user && project?.owner === user.subject ? project.key : undefined,
  );
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage your Forge project.');
  if (action === 'delete') await requireOwnerPerson(ctx, 'permanently delete projects');
  // Delete reconciliation has no existence oracle.
  if (action === 'delete' && (!project || project.owner !== user.subject)) return null;
  invariant(
    project?.owner === user.subject,
    'PROJECT_UNAVAILABLE',
    'This Forge project is unavailable with the current account.',
  );
  invariant(
    input.operationId.trim() && Number.isSafeInteger(input.expectedRevision),
    'BAD_ARGUMENT',
    'Retain the original project operation and revision.',
  );
  if (project.lifecycle?.operationId === input.operationId) {
    invariant(
      project.lifecycle.action === action && project.lifecycle.expectedRevision === input.expectedRevision,
      'WORK_OPERATION_CHANGED',
      'Reconcile this original project operation.',
    );
    if (project.removal === 'deleting') await schedule(ctx, project);
    // A retried restore answers as the first one did (its response may have been lost).
    return action === 'restore' ? receiptOf(project.lifecycle) : null;
  }
  // SM-D guards (machine M1): restoring an active project and trashing a trashed one already
  // hold the state they ask for. They return before the revision check and write nothing, so a stale
  // second tab neither bumps the revision (which would fail every other holder with WORK_STALE) nor
  // re-measures retention and moves its expiry. A restore that changed nothing has no receipt, so it offers no Undo.
  if ((action === 'restore' && !project.removal) || (action === 'trash' && project.removal === 'trash'))
    return null;
  await options.guard?.(project);
  invariant(
    project.revision === input.expectedRevision,
    'WORK_STALE',
    'Project changed. Its original source and your operation remain available.',
  );
  if (action === 'delete' && ['deleting', 'deleted'].includes(project.removal ?? '')) {
    // A pre-receipt `deleting` row gets its owner-confirmed purge grant from this retry.
    if (project.removal === 'deleting' && !project.purge)
      await ctx.db.patch(project._id, {
        purge: {
          operationId: input.operationId,
          reason: 'owner',
          startedAt: Date.now(),
          rows: 0,
          bytes: 0,
          pages: 0,
        },
      });
    if (project.removal === 'deleting') await schedule(ctx, (await ctx.db.get(project._id))!);
    return null;
  }
  invariant(
    !['deleting', 'deleted'].includes(project.removal ?? ''),
    'PROJECT_UNAVAILABLE',
    'Permanent project removal is already underway.',
  );
  if (action === 'delete')
    invariant(
      options.confirmed ||
        (!!input.confirm?.trim() && input.confirm.trim() === (project.slug ?? project.name)),
      'BAD_ARGUMENT',
      'Type the project slug to confirm permanent deletion.',
    );
  if (action === 'restore') {
    invariant(
      !project.retention || Date.now() < project.retention.purgeAt,
      'PROJECT_UNAVAILABLE',
      'The 90-day restore window for this project has ended.',
    );
    invariant(
      !project.retention?.revoking,
      'WORK_STALE',
      'Access revocation for this deletion is still finishing. Retry restore shortly.',
    );
  }
  await stopRetention(ctx, project);
  const removal =
    action === 'restore' ? undefined : action === 'trash' ? ('trash' as const) : ('deleting' as const);
  await ctx.db.patch(project._id, {
    removal,
    removedAt: removal ? (project.removedAt ?? Date.now()) : undefined,
    revision: project.revision + 1,
    lifecycle: { operationId: input.operationId, action, expectedRevision: input.expectedRevision },
    retention: undefined,
    ...(action === 'delete'
      ? {
          purge: {
            operationId: input.operationId,
            reason: 'owner' as const,
            startedAt: Date.now(),
            rows: 0,
            bytes: 0,
            pages: 0,
          },
        }
      : {}),
  });
  // The person-order rows follow removal in the same transaction (Item 3d5d8839).
  if (action === 'restore') await restoreProjectOrder(ctx, (await ctx.db.get(project._id))!);
  else await dropProjectOrder(ctx, project._id);
  if (action === 'trash') await startRetention(ctx, project._id);
  if (action === 'delete') await schedule(ctx, (await ctx.db.get(project._id))!);
  if (removal && project.visibility === 'public')
    await queueProjectSnapshots(ctx, { ...project, removal }, true);
  if (action === 'restore') {
    // Item eb631a53: a live project may have taken this address while it was removed.
    const restored = (await ctx.db.get(project._id))!;
    const address = await restoreProjectSlug(ctx, restored);
    if (project.visibility === 'public')
      await queueProjectSnapshots(ctx, { ...restored, slug: address.slug }, true, address.previousSlug);
    if (address.moved) {
      const moved = { slug: address.slug, previousSlug: address.previousSlug! };
      await ctx.db.patch(project._id, {
        lifecycle: {
          operationId: input.operationId,
          action,
          expectedRevision: input.expectedRevision,
          address: moved,
        },
      });
      return { restoreId: input.operationId, revision: input.expectedRevision + 1, ...moved };
    }
  }
  return action === 'restore' ? { restoreId: input.operationId, revision: input.expectedRevision + 1 } : null;
}
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Project slugs are at most 100 characters, like repository names and the derived default (uniqueUrlName). */
const SLUG_MAX = 100;
type RenameInput = { operationId: string; expectedRevision: number; name: string; slug?: string };

/** Item eb631a53: the project's name and address. The owner person changes them directly; an agent's change (any
 * device sign-in) is held for the owner person on the approve page, like membership. The old address stays an alias
 * that resolves to the project (the web moves to the new address); an address held only by removed projects is free. */
export const rename = mutation({
  args: { ...args, name: v.string(), slug: v.optional(v.string()) },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        project = await ctx.db.get(input.projectId);
      projectExecution(
        ctx,
        input.projectId,
        user && project?.owner === user.subject ? project.name : undefined,
        user && project?.owner === user.subject ? project.key : undefined,
      );
      invariant(
        user && project?.owner === user.subject && !project.removal,
        'PROJECT_UNAVAILABLE',
        'This Forge project is unavailable with the current account.',
      );
      if (isDeviceIdentity(user)) return await holdRename(ctx, project, user.subject, input);
      await applyRename(ctx, project, input);
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
function renameRequest(input: RenameInput) {
  const name = input.name.trim();
  invariant(
    name && input.operationId.trim() && Number.isSafeInteger(input.expectedRevision),
    'BAD_ARGUMENT',
    'Enter a project name and retain the original operation.',
  );
  check(
    input.slug === undefined || SLUG.test(input.slug),
    'BAD_ARGUMENT',
    'Use lowercase letters, numbers and hyphens for the project slug.',
  );
  check(
    input.slug === undefined || input.slug.length <= SLUG_MAX,
    'BAD_ARGUMENT',
    `Use at most ${SLUG_MAX} characters for the project slug.`,
  );
  return { name, ...(input.slug !== undefined ? { slug: input.slug } : {}) };
}
/** What an agent asked for and what the owner sees: the request, the project's name and address when it was made (at
 * `expectedRevision`), and the fully resolved result. The approval digest covers all of it. */
type AddressRequest = {
  asked: { name: string; slug: string | null; expectedRevision: number };
  before: { name: string; slug: string };
  after: { name: string; slug: string };
};
const staleWords =
  "The project's name or address changed after this request; nothing was applied. Ask for the change again.";
/** One request row per project (a newer request replaces an open one). Item eb631a53 review: a request binds the
 * revision it was made at, so a grant applies only the exact before -> after it showed, and an old request replayed
 * after a later change is refused, never reopened: each request applies at most once. */
async function holdRename(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  requester: string,
  input: RenameInput,
) {
  const change = renameRequest(input);
  const asked = { name: change.name, slug: change.slug ?? null, expectedRevision: input.expectedRevision };
  const key = settingKey('address');
  const replay = await heldReplay(ctx, project._id, key, input.operationId, stored => {
    const held = JSON.parse(stored) as AddressRequest;
    return canonicalPayload(held.asked) === canonicalPayload(asked);
  });
  if (replay) return canonicalPayload({ rule: 'held', ...settingReply(replay) });
  invariant(project.revision === input.expectedRevision, 'WORK_STALE', staleWords);
  const slug = await ensureProjectSlug(ctx, project);
  const request: AddressRequest = {
    asked,
    before: { name: project.name, slug },
    after: { name: change.name, slug: change.slug ?? slug },
  };
  const row = await holdSetting(ctx, {
    projectId: project._id,
    key,
    origin: 'address',
    requester,
    operationId: input.operationId,
    request: canonicalPayload(request),
    summary: request.after.slug !== slug ? `Move the project to ${request.after.slug}` : 'Rename the project',
  });
  return canonicalPayload({ rule: 'held', ...settingReply(row) });
}
/** The owner person's grant of a held rename: exactly the before -> after the request showed, at the revision it was
 * made against. Anything else (a later rename, a restore, another grant) fails with WORK_STALE. */
export async function applyApprovedAddress(ctx: MutationCtx, row: ApprovalRow) {
  const user = await requireOwnerPerson(ctx, 'change the project address');
  const project = await activeOwnedProject(ctx, row.projectId, user.subject);
  const request = JSON.parse(row.setting!.request) as AddressRequest;
  invariant(
    project.revision === request.asked.expectedRevision &&
      project.name === request.before.name &&
      project.slug === request.before.slug,
    'WORK_STALE',
    staleWords,
  );
  await applyRename(ctx, project, {
    operationId: row.operationId,
    expectedRevision: request.asked.expectedRevision,
    name: request.after.name,
    slug: request.after.slug,
  });
  return { rule: 'owner-approved', slug: request.after.slug };
}
async function applyRename(ctx: MutationCtx, project: Doc<'hostedProjects'>, input: RenameInput) {
  const { name } = renameRequest(input);
  if (project.nameChange?.operationId === input.operationId) {
    invariant(
      project.nameChange.name === name &&
        project.nameChange.slug === input.slug &&
        project.nameChange.expectedRevision === input.expectedRevision,
      'WORK_OPERATION_CHANGED',
      'Reconcile the original rename request.',
    );
    return;
  }
  invariant(
    project.revision === input.expectedRevision,
    'WORK_STALE',
    'Project changed. Refresh its current name before making another change.',
  );
  const previousSlug = await ensureProjectSlug(ctx, project);
  const slug = input.slug ?? previousSlug;
  check(
    !(await slugTaken(ctx, project.owner, slug, project._id)),
    'BAD_ARGUMENT',
    'This project slug is already taken.',
  );
  // The old address stays this project's alias; one held only by a removed project moves to this one.
  await claimSlug(ctx, project, slug);
  await ctx.db.patch(project._id, {
    name,
    slug,
    revision: project.revision + 1,
    nameChange: {
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      name,
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
    },
  });
  if (project.visibility === 'public')
    await queueProjectSnapshots(ctx, { ...project, slug, name }, true, previousSlug);
}
/** `expectedLastLanding` (Loose ends, Item fc1831eb): the landing receipt id the reader saw, or null for none. A
 * project that landed since is refused as WORK_STALE (a landing does not move the project revision), and the reply
 * says whether this operation moved the project (`applied`), so a project another tab trashed is not claimed as
 * this caller's. Callers that omit it keep the null reply. */
export const trash = mutation({
  args: {
    ...args,
    expectedLastLanding: v.optional(v.union(v.string(), v.null())),
    /** Undo of a restore (Item 966cb821): the restore's own operation id from its receipt; `expectedRevision` is the
     * receipt's revision. Refused as WORK_STALE once another transition ran or a person joined after that restore. */
    afterRestore: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.object({ applied: v.boolean() })),
  handler: async (ctx, { expectedLastLanding, afterRestore, ...input }) => {
    try {
      if (expectedLastLanding === undefined && afterRestore === undefined) {
        await transition(ctx, input, 'trash');
        return null;
      }
      await transition(ctx, input, 'trash', {
        guard: async project => {
          if (afterRestore !== undefined)
            invariant(
              undoOpen(project, afterRestore),
              'WORK_STALE',
              'The project changed after you restored it, so Undo left it alone.',
            );
          if (expectedLastLanding !== undefined)
            invariant(
              ((await latestLanding(ctx, project._id))?._id ?? null) === expectedLastLanding,
              'WORK_STALE',
              'The project landed work since you looked. It was left alone.',
            );
        },
      });
      if (expectedLastLanding === undefined) return null;
      const after = await ctx.db.get(input.projectId);
      return { applied: after?.removal === 'trash' && after.lifecycle?.operationId === input.operationId };
    } catch (error) {
      return report(error);
    }
  },
});
export const restore = mutation({
  args,
  /** Undo's receipt (Item 966cb821), or null when this call changed nothing (the project was already restored). */
  returns: v.union(v.null(), restoreReceipt),
  handler: async (ctx, input) => {
    try {
      return await transition(ctx, input, 'restore');
    } catch (error) {
      return report(error);
    }
  },
});
export const permanentlyDelete = mutation({
  args: { ...args, confirm: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      await transition(ctx, input, 'delete');
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

export async function retainUploadCleanup(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  row: Doc<'projectBackups'> | Doc<'projectProposals'>,
  kind: 'backup' | 'proposal',
) {
  const old = await ctx.db
    .query('projectUploadCleanup')
    .withIndex('by_upload', q => q.eq('uploadId', row._id))
    .unique();
  if (old) return old;
  // An archive that never received its R2 upload target holds no bytes and needs no binding.
  if (row.location !== 'r2' || !row.r2Key) return null;
  if (project.removal !== 'deleting') {
    const artifact = await ctx.db
      .query('artifactBlobs')
      .withIndex('by_namespace_and_digest', q =>
        q.eq('namespace', `v1/p/${project._id}/archives/${row._id}`).eq('digest', row.digest),
      )
      .unique();
    if (artifact) await blobStore(ctx).delete(`r2blob:${artifact._id}`);
  }
  const id = await ctx.db.insert('projectUploadCleanup', {
    projectId: project._id,
    owner: project.owner,
    actor: 'actor' in row ? row.actor : project.owner,
    uploadId: row._id,
    operationId: row.operationId,
    kind,
    nonce: row.nonce,
    digest: row.digest,
    size: row.size,
    r2Key: row.r2Key,
  });
  return (await ctx.db.get(id))!;
}
export const purge = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    projectExecution(ctx, projectId, project?.name, project?.key);
    if (project?.removal !== 'deleting' || (project.r2Purge && !project.r2PrefixPurged)) return null;
    ctx = projectPurgeWriter(ctx);
    // Access is already revoked. Signed uploads issued before deletion can still finish
    // until they expire; purging after that means no bytes or receipts can arrive later.
    const settleAt = (project.removedAt ?? 0) + purgeSettleMs;
    if (Date.now() < settleAt) {
      const task = await ctx.scheduler.runAt(settleAt, internal.projectLifecycle.purge, { projectId });
      await ctx.db.patch(projectId, { task });
      return null;
    }
    const imports = await ctx.db
      .query('projectGithubImports')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .take(50);
    for (const job of imports) {
      if (job.task) {
        await cancelPendingTask(ctx, job.task);
      }
      if (job.protocol === undefined) await blobStore(ctx).delete(job.cursor);
      await ctx.db.delete(job._id);
    }
    if (imports.length === 50) {
      await ctx.db.patch(projectId, { task: undefined });
      await schedule(ctx, (await ctx.db.get(projectId))!);
      return null;
    }

    // Plain project rows (grants, Work, journals, settings) go in the inventory-guarded
    // row stage below, which also cancels their scheduled functions and frees their files.
    for (const table of ['projectProposals', 'projectBackups'] as const) {
      const rows =
        table === 'projectProposals'
          ? await ctx.db
              .query(table)
              .withIndex('by_project_and_operation', q => q.eq('projectId', projectId))
              .take(1)
          : await ctx.db
              .query(table)
              .withIndex('by_project', q => q.eq('projectId', projectId))
              .take(1);
      if (!rows.length) continue;
      const row = rows[0]!;
      // The binding keeps the archive's R2 key for the guarded key purge after the row is gone.
      await retainUploadCleanup(ctx, project, row, table === 'projectBackups' ? 'backup' : 'proposal');
      await ctx.db.delete(row._id);
      await ctx.db.patch(projectId, { task: undefined });
      await schedule(ctx, (await ctx.db.get(projectId))!);
      return null;
    }
    if (!(await purgeExchangeObjects(ctx, project))) {
      await ctx.db.patch(projectId, { task: undefined });
      await schedule(ctx, (await ctx.db.get(projectId))!);
      return null;
    }
    // The row phase leaves the artifact namespace for after the guarded R2 stage.
    if (!(await purgeProjectRowsPage(ctx, project))) {
      await ctx.db.patch(projectId, { task: undefined });
      await schedule(ctx, (await ctx.db.get(projectId))!);
      return null;
    }
    if (!project.r2PrefixPurged) {
      await scheduleR2Purge(ctx, (await ctx.db.get(projectId))!);
      return null;
    }
    // Root projections predate projectId coverage; remove by their source identity too.
    const rootRead = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_source', q => q.eq('kind', 'hostedProjects').eq('sourceId', projectId))
      .unique();
    if (rootRead) await ctx.db.delete(rootRead._id);
    // The owner/key tombstone prevents an old initial-upload retry from silently recreating this project.
    const finished = (await ctx.db.get(projectId))!;
    await ctx.db.patch(projectId, {
      name: '',
      slug: undefined,
      ...(finished.purge ? { purge: { ...finished.purge, completedAt: Date.now() } } : {}),
      nameChange: undefined,
      hostingRequest: undefined,
      agentGuidance: undefined,
      autonomyPolicy: undefined,
      currentBackup: null,
      work: undefined,
      removal: 'deleted',
      task: undefined,
      purgeBlocked: undefined,
    });
    await noteDeleteOutcome(ctx, finished, 'deleted');
    return null;
  },
});
