// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > Project, Visibility (Item 966cb821). Who may see the project is the owner's call, by a signed-in person in a
// browser: an agent or any forge-cli credential is refused (docs/access.md `ownerPersonOnly`). Making a project public
// needs its name typed, like permanent delete. One mutation, retry-safe per operation id; it reads and writes the one
// project row, its operation row and its listing row, and nothing runs while idle.
import { v } from 'convex/values';
import { accountMutation } from './cliServer';
import { requireOwnerPerson } from './ownerPerson';
import { activeOwnedProject } from './projectAuthority';
import { publicRow, ensurePublicRow } from './publicListing';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Set the project public or private. A private project keeps no listing: its row (stars stay) stops being `listed`.
 * Links to a private project's pages and its GitHub status links follow the project's visibility at read time
 * (Item d357d772), so nothing else is copied or cleared here. A repeat of the same operation answers as the first;
 * a new one must name the revision it saw (WORK_STALE otherwise), and a change advances it. Cached copies of public
 * pages can outlive the change by the CDN lifetime (convex/publicHttp.ts PUBLIC_CACHE, 30 seconds). */
export const setVisibility = accountMutation('person')({
  args: {
    projectId: v.id('hostedProjects'),
    visibility: v.union(v.literal('public'), v.literal('private')),
    operationId: v.string(),
    /** The project revision the person saw when they confirmed; a later change (rename, trash, another visibility
     * change) makes an unused confirmation stale. */
    expectedRevision: v.number(),
    /** Required to make a private project public: the project's exact name. */
    confirm: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await requireOwnerPerson(ctx, 'change who can see the project');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      invariant(input.operationId.trim(), 'BAD_ARGUMENT', 'Retain the visibility change operation id.');
      const key = `visibility:${input.visibility}`;
      const old = await ctx.db
        .query('projectAccessOperations')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .unique();
      if (old) {
        invariant(
          old.owner === user.subject && old.person === key,
          'WORK_OPERATION_CHANGED',
          'Retry this visibility change with its original values.',
        );
        return null;
      }
      invariant(
        project.revision === input.expectedRevision,
        'WORK_STALE',
        'The project changed since you opened this. Reload it and confirm again.',
      );
      const current = project.visibility === 'public' ? 'public' : 'private';
      if (current !== input.visibility) {
        if (input.visibility === 'public')
          invariant(
            input.confirm?.trim() === project.name,
            'BAD_ARGUMENT',
            "Type the project's name to make it public.",
          );
        await ctx.db.patch(project._id, { visibility: input.visibility, revision: project.revision + 1 });
        const next = { ...project, visibility: input.visibility };
        if (input.visibility === 'public' || (await publicRow(ctx, project._id)))
          await ensurePublicRow(ctx, next);
      }
      await ctx.db.insert('projectAccessOperations', {
        projectId: input.projectId,
        owner: user.subject,
        operationId: input.operationId,
        person: key,
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
