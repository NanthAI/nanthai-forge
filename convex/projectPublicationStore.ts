// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, mutation } from './cliServer';
import { internalQuery, internalMutation } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { publicationDocument } from './projectPublicationFields';
import { METADATA_PUBLICATION, PUBLICATION_PAGE_BYTES, publicationChain } from '../src/publication-metadata';
import { invariant } from '../src/errors';
import { isStored } from './projectObjectFields';
import { report } from './errors';
const status = v.object({ id: v.id('projectPublications'), cursor: v.number(), chain: v.string() });
const identity = { projectId: v.id('hostedProjects'), operationId: v.string() };
const idFields = { id: v.id('projectPublications'), owner: v.string() };

export const capabilities = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.union(v.literal(METADATA_PUBLICATION), v.null()),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      const project = await activeOwnedProject(ctx, projectId, user.subject);
      return project.r2Writes ? METADATA_PUBLICATION : null;
    } catch (error) {
      return report(error);
    }
  },
});
export const begin = mutation({
  args: {
    ...identity,
    request: v.string(),
    digest: v.string(),
    size: v.number(),
    metadataDigest: v.string(),
    pages: v.number(),
  },
  returns: status,
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      invariant(
        project.r2Writes,
        'PUBLICATION_CAPABILITY_CHANGED',
        'Use the existing publication path after R2 opt-out.',
      );
      invariant(
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId) &&
          /^[a-f0-9]{64}$/.test(input.digest) &&
          /^[a-f0-9]{64}$/.test(input.metadataDigest) &&
          Number.isSafeInteger(input.size) &&
          input.size >= 0 &&
          Number.isSafeInteger(input.pages) &&
          input.pages > 0,
        'BAD_ARGUMENT',
        'Retain exact publication pins and page count.',
      );
      const original = await ctx.db
        .query('projectPublications')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (original) {
        invariant(
          original.owner === user.subject &&
            Object.entries(input).every(([key, value]) => original[key as keyof typeof input] === value),
          'WORK_OPERATION_CHANGED',
          'Retry the original publication metadata.',
        );
        return { id: original._id, cursor: original.cursor, chain: original.chain };
      }
      const id = await ctx.db.insert('projectPublications', {
        ...input,
        owner: user.subject,
        cursor: 0,
        chain: '',
        validated: false,
      });
      return { id, cursor: 0, chain: '' };
    } catch (error) {
      return report(error);
    }
  },
});
export const append = mutation({
  args: { id: v.id('projectPublications'), position: v.number(), previous: v.string(), body: v.string() },
  returns: status,
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity(),
        session = await ctx.db.get(input.id);
      invariant(
        user && session && session.owner === user.subject,
        'PROJECT_UNAVAILABLE',
        'Publication unavailable.',
      );
      const project = await activeOwnedProject(ctx, session.projectId, user.subject);
      invariant(
        project.r2Writes,
        'PUBLICATION_CAPABILITY_CHANGED',
        'Use the existing publication path after R2 opt-out.',
      );
      invariant(
        Number.isSafeInteger(input.position) &&
          input.position >= 0 &&
          input.position < session.pages &&
          new TextEncoder().encode(JSON.stringify(input)).length <= PUBLICATION_PAGE_BYTES,
        'BAD_ARGUMENT',
        'Send one bounded publication page.',
      );
      const chain = publicationChain(input.previous, input.body);
      if (input.position < session.cursor) {
        const page = await ctx.db
          .query('projectPublicationPages')
          .withIndex('by_publication_and_position', q =>
            q.eq('publicationId', input.id).eq('position', input.position),
          )
          .unique();
        invariant(
          page?.chain === chain && page.body === input.body && page.previous === input.previous,
          'WORK_OPERATION_CHANGED',
          'Retry the original publication page.',
        );
      } else {
        invariant(
          input.position === session.cursor && input.previous === session.chain,
          'WORK_OPERATION_CHANGED',
          'Resume at the retained publication cursor.',
        );
        await ctx.db.insert('projectPublicationPages', {
          projectId: session.projectId,
          publicationId: input.id,
          position: input.position,
          body: input.body,
          previous: input.previous,
          chain,
        });
        await ctx.db.patch(input.id, { cursor: input.position + 1, chain });
      }
      return {
        id: input.id,
        cursor: Math.max(session.cursor, input.position + 1),
        chain: input.position < session.cursor ? session.chain : chain,
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const load = internalQuery({
  args: { ...identity, owner: v.string() },
  returns: v.union(publicationDocument, v.null()),
  handler: async (ctx, input) => {
    try {
      await activeOwnedProject(ctx, input.projectId, input.owner);
      return ctx.db
        .query('projectPublications')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
    } catch (error) {
      return report(error);
    }
  },
});
/** R3b consumes these immutable DB pages, never file-storage cursor blobs. */
export const read = internalQuery({
  args: { ...idFields, position: v.number() },
  returns: v.string(),
  handler: async (ctx, { id, owner, position }) => {
    try {
      const session = await ctx.db.get(id);
      invariant(session && session.owner === owner, 'PROJECT_UNAVAILABLE', 'Publication unavailable.');
      await activeOwnedProject(ctx, session.projectId, owner);
      const page = await ctx.db
        .query('projectPublicationPages')
        .withIndex('by_publication_and_position', q => q.eq('publicationId', id).eq('position', position))
        .unique();
      invariant(page, 'INVALID_WORK_BACKUP', 'Publication page is missing.');
      return page.body;
    } catch (error) {
      return report(error);
    }
  },
});
export const validated = internalMutation({
  args: { ...idFields, metadataDigest: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, owner, metadataDigest }) => {
    try {
      const session = await ctx.db.get(id);
      invariant(session && session.owner === owner, 'PROJECT_UNAVAILABLE', 'Publication unavailable.');
      const project = await activeOwnedProject(ctx, session.projectId, owner);
      invariant(
        project.r2Writes && session.cursor === session.pages && session.metadataDigest === metadataDigest,
        'WORK_OPERATION_CHANGED',
        'Validate the complete original publication metadata.',
      );
      await ctx.db.patch(id, { validated: true });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const pins = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    pins: v.array(v.object({ sha256: v.string(), size: v.number() })),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      await activeOwnedProject(ctx, input.projectId, input.owner);
      invariant(input.pins.length <= 100, 'BAD_ARGUMENT', 'Check committed pins in pages of 100.');
      for (const pin of input.pins) {
        const row = await ctx.db
          .query('projectObjects')
          .withIndex('by_project_and_digest', q =>
            q.eq('projectId', input.projectId).eq('digest', pin.sha256),
          )
          .unique();
        invariant(
          row && isStored(row) && !row.removed && row.size === pin.size,
          'PUBLISH_PIN_MISSING',
          'Publication pin has no committed object row.',
        );
      }
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
