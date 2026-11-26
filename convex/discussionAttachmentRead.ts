// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { invariant } from '../src/errors';
import type { Doc } from './_generated/dataModel';
import { guard } from './cliServer';
import { report } from './errors';
import { commentOnItem } from './planningCommentRead';
import { accessibleProject, readProjectRole } from './projectAuthority';
import { storeItem } from './projectWorkStoreReads';
import { publicWorkPlan } from './publicWorkPlan';
import { projectPrefix } from './r2Operations';
import { internalQuery, type QueryCtx } from './server';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// Owner-approved file size, also the integrity reader's maximum allocation.
const fileBytes = 25_000_000;
const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/i;

/** Permanent deletion retains comment headers. The current Item's durable
 * tombstone ends downloads even before the redaction sweep reaches those rows. */
export async function retainedItem(ctx: QueryCtx, project: Doc<'hostedProjects'>, itemId: string) {
  const item = await storeItem(ctx, project._id, itemId);
  return Boolean(item && !item.purged);
}

/** The same transaction checks discussion access and reads the committed artifact pin.
 * No signing target or metadata reaches a reader without access to the exact comment. */
export const resolve = internalQuery({
  args: { projectId: v.string(), itemId: v.string(), commentId: v.string(), attachmentId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      projectId: v.id('hostedProjects'),
      r2Key: v.string(),
      size: v.number(),
      digest: v.string(),
      contentType: v.string(),
    }),
  ),
  handler: async (ctx, input) => {
    try {
      const viewer = await ctx.auth.getUserIdentity();
      invariant(viewer, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const guarded = { ...ctx, ...(await guard(ctx, 'cli')) };
      const projectId = ctx.db.normalizeId('hostedProjects', input.projectId);
      const attachmentId = ctx.db.normalizeId('artifactBlobs', input.attachmentId);
      if (!projectId || !attachmentId || !uuid.test(input.itemId) || !uuid.test(input.commentId)) return null;
      const project = await accessibleProject(guarded, projectId, viewer.subject);
      if (!(await retainedItem(guarded, project, input.itemId))) return null;
      if (
        project.visibility === 'public' &&
        !(await readProjectRole(guarded, project, viewer.subject)) &&
        !(await publicWorkPlan(guarded, project, new Map()).selectionVisible(input.itemId))
      )
        return null;
      if (!(await commentOnItem(guarded, project, input.itemId, input.commentId))) return null;
      const artifact = await ctx.db.get(attachmentId);
      const namespace = `${projectPrefix(projectId)}discussion/${input.itemId}/${input.commentId}`;
      if (
        !artifact?.committed ||
        artifact.removed ||
        artifact.namespace !== namespace ||
        artifact.r2Key !== `${namespace}/a/${artifact.digest}` ||
        !/^[a-f0-9]{64}$/.test(artifact.digest) ||
        !Number.isSafeInteger(artifact.size) ||
        artifact.size < 0 ||
        artifact.size > fileBytes
      )
        return null;
      return {
        projectId,
        r2Key: artifact.r2Key,
        size: artifact.size,
        digest: artifact.digest,
        contentType: contentType.test(artifact.contentType)
          ? artifact.contentType
          : 'application/octet-stream',
      };
    } catch (error) {
      return report(error);
    }
  },
});
