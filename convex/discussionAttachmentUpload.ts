// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { action, mutation } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './server';
import { removeArtifact, reserveArtifact } from './artifactStorage';
import { chargeStored, namespaceOf } from './discussionAttachmentStored';
import { commentOnItem } from './planningCommentRead';
import { retainedItem } from './discussionAttachmentRead';
import { report } from './errors';
import { activeProject } from './projectAuthority';
import { presignPut, r2Config } from './r2';
import { invariant } from '../src/errors';
import {
  ATTACHMENT_LIMITS,
  attachmentByteLimit,
  attachmentName,
  storedMediaType,
} from '../src/discussion-attachment-limits';

/** Discussion attachment uploads (Issue 9a3d6f5f). Three calls per file, none per byte:
 * `prepare` (one mutation: access, the project's stored bytes, one reservation, one signed create-only PUT and one
 * scheduled clean-up), the PUT straight to R2, and `commit` (one query, an R2 HEAD, one mutation). The comment that
 * names the file is the existing comment command; it only checks the committed binding. A file whose comment never
 * arrives is removed by the scheduled clean-up, which returns its bytes to the project's allowance. Idle costs zero. */
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** After the signature (15 minutes) and the longest upload that can follow it. */
const orphanMs = 60 * 60_000;
const pin = {
  projectId: v.id('hostedProjects'),
  itemId: v.string(),
  commentId: v.string(),
};

/** Planning writers (the project owner today) add attachments, to an Item that is still retained. */
async function writer(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; itemId: string; commentId: string },
) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to attach files.');
  const project = await activeProject(ctx, input.projectId, user.subject);
  invariant(
    project.owner === user.subject,
    'PROJECT_UNAVAILABLE',
    'Project planning is available to its current owner.',
  );
  invariant(
    uuid.test(input.itemId) && uuid.test(input.commentId),
    'BAD_ARGUMENT',
    'Name the Item and the comment by UUID.',
  );
  invariant(
    await retainedItem(ctx, project, input.itemId),
    'NOT_FOUND',
    'Select an existing Issue or Initiative.',
  );
  return project;
}

const target = v.object({
  kind: v.literal('r2'),
  url: v.string(),
  headers: v.record(v.string(), v.string()),
});
const result = v.object({
  attachment: v.object({ id: v.string(), name: v.string(), size: v.number(), contentType: v.string() }),
  /** Absent when the exact bytes are already committed for this comment (a retried upload). */
  put: v.optional(target),
});

export const prepare = mutation({
  args: {
    ...pin,
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    digest: v.string(),
  },
  returns: result,
  handler: async (ctx, input) => {
    try {
      await writer(ctx, input);
      const name = attachmentName(input.name);
      const contentType = storedMediaType(input.contentType, name);
      const limit = attachmentByteLimit(contentType);
      invariant(
        Number.isSafeInteger(input.size) && input.size > 0 && /^[a-f0-9]{64}$/.test(input.digest),
        'BAD_ARGUMENT',
        'Send the exact size (at least one byte) and SHA-256 of the file.',
      );
      invariant(
        input.size <= limit,
        'QUOTA_EXCEEDED',
        `${contentType.startsWith('image/') && limit === ATTACHMENT_LIMITS.imageBytes ? 'An image' : 'A file'} can be at most ${limit / 1_000_000} MB; this one is ${input.size} bytes.`,
      );
      const namespace = namespaceOf(input.projectId, input.itemId, input.commentId);
      const existing = await ctx.db
        .query('artifactBlobs')
        .withIndex('by_namespace_and_digest', q => q.eq('namespace', namespace).eq('digest', input.digest))
        .unique();
      if (!existing) {
        // The comment holds at most four files; a fifth binding for it is refused before it is counted.
        const siblings = await ctx.db
          .query('artifactBlobs')
          .withIndex('by_namespace_and_digest', q => q.eq('namespace', namespace))
          .take(ATTACHMENT_LIMITS.perComment + 1);
        invariant(
          siblings.filter(row => !row.removed).length < ATTACHMENT_LIMITS.perComment,
          'BAD_ARGUMENT',
          `A comment holds at most ${ATTACHMENT_LIMITS.perComment} files.`,
        );
        await chargeStored(ctx, input.projectId, input.size);
      }
      const row = await reserveArtifact(ctx, {
        namespace,
        digest: input.digest,
        size: input.size,
        contentType,
      });
      if (!existing)
        await ctx.scheduler.runAfter(orphanMs, internal.discussionAttachmentUpload.sweep, {
          ...pin2(input),
          attachmentId: row._id,
        });
      const attachment = { id: row._id as string, name, size: row.size, contentType: row.contentType };
      return row.committed
        ? { attachment }
        : {
            attachment,
            put: await presignPut(r2Config(), row.r2Key, { digest: row.digest, size: row.size }),
          };
    } catch (error) {
      return report(error);
    }
  },
});
const pin2 = (input: { projectId: Id<'hostedProjects'>; itemId: string; commentId: string }) => ({
  projectId: input.projectId,
  itemId: input.itemId,
  commentId: input.commentId,
});

/** The same writer check, and the binding must be this comment's. */
export const authorize = internalQuery({
  args: { ...pin, attachmentId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      await writer(ctx, input);
      const id = ctx.db.normalizeId('artifactBlobs', input.attachmentId);
      const row = id ? await ctx.db.get(id) : null;
      invariant(
        row && !row.removed && row.namespace === namespaceOf(input.projectId, input.itemId, input.commentId),
        'NOT_FOUND',
        'This upload is not prepared for this comment.',
      );
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

/** Confirms the PUT (R2 HEAD: exact size and checksum) and commits the binding. A retry of a committed file is a no-op. */
export const commit = action({
  args: { ...pin, attachmentId: v.string() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    try {
      await ctx.runQuery(internal.discussionAttachmentUpload.authorize, input);
      await ctx.runAction(internal.artifactStorage.commit, { ref: `r2blob:${input.attachmentId}` });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

/** Removes a file whose comment never arrived (the upload or the comment failed, or the client left). */
export const sweep = internalMutation({
  args: { ...pin, attachmentId: v.id('artifactBlobs') },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row: Doc<'artifactBlobs'> | null = await ctx.db.get(input.attachmentId);
    if (!row || row.removed) return null;
    const project = await ctx.db.get(input.projectId);
    if (project && (await commentOnItem(ctx, project, input.itemId, input.commentId))) return null;
    await removeArtifact(ctx, row);
    return null;
  },
});
