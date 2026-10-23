// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { workProject } from './projectWorkHead';
import { invariant } from '../src/errors';
import { digest } from '../src/portable-hash';
import { hostedCommandSchema, hostedEventSchema, type HostedEvent } from '../src/work-types';
import type { Doc } from './_generated/dataModel';
import { report } from './errors';

// No source objects or Work records are read. Revision ranges are immutable;
// every page checks current access and the same selected checkpoint/head.
export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    afterRevision: v.optional(v.number()),
    snapshot: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, user.subject));
      const work = project.work;
      invariant(work, 'PROJECT_WORK_MISSING', 'Start hosted Work from a stored source backup.');
      const backup = await ctx.db.get(work.backupId);
      invariant(
        backup?.projectId === project._id &&
          backup.status === 'stored' &&
          backup.transport === 'objects' &&
          backup.preview.format === 'native',
        'INVALID_WORK_BACKUP',
        'Journal pages require a stored native object checkpoint.',
      );
      const header = {
        projectKey: project.key,
        name: project.name,
        backupId: backup._id,
        archiveSha256: backup.digest,
        manifestSha256: backup.preview.manifestDigest,
        initialRevision: work.initialRevision,
        revision: work.revision,
        head: backup.preview.head,
        ...(work.intentMigration ? { intentMigration: work.intentMigration } : {}),
      };
      const snapshot = digest(JSON.stringify(header));
      invariant(
        !input.snapshot || input.snapshot === snapshot,
        'WORK_STALE',
        'Hosted source or Work changed during journal paging. Retain the original request.',
      );
      const after = input.afterRevision ?? work.initialRevision;
      invariant(
        Number.isSafeInteger(after) && after >= work.initialRevision && after <= work.revision,
        'INVALID_WORK_JOURNAL',
        'Select a revision within this hosted checkpoint.',
      );
      const event = (row: Doc<'projectWorkEvents'>): HostedEvent =>
        hostedEventSchema.parse({
          projectKey: project.key,
          archiveSha256: backup.digest,
          id: row.operationId,
          request: row.request,
          previousRevision: row.previousRevision,
          actor: row.actor,
          at: row.at,
          command: hostedCommandSchema.parse(JSON.parse(row.command)),
          ...(row.automatic ? { automatic: row.automatic } : {}),
        });
      const previous =
        after > work.initialRevision
          ? await ctx.db
              .query('projectWorkEvents')
              .withIndex('by_project_and_revision', q => q.eq('projectId', project._id).eq('revision', after))
              .unique()
          : null;
      invariant(
        after === work.initialRevision || previous,
        'INVALID_WORK_JOURNAL',
        'The preceding hosted journal event is unavailable.',
      );
      const result =
        input.afterRevision === undefined
          ? undefined
          : await ctx.db
              .query('projectWorkEvents')
              .withIndex('by_project_and_revision', q =>
                q.eq('projectId', project._id).gt('revision', after).lte('revision', work.revision),
              )
              .order('asc')
              .paginate({ cursor: null, numItems: 50, maximumRowsRead: 50, maximumBytesRead: 256 * 1024 });
      const events: HostedEvent[] = [];
      let bytes = 0;
      for (const row of result?.page ?? []) {
        const operation = event(row),
          size = new TextEncoder().encode(JSON.stringify(operation)).byteLength;
        // One existing large event remains readable; this is a paging budget, not a write limit.
        if (events.length && bytes + size > 256 * 1024) break;
        events.push(operation);
        bytes += size;
      }
      const nextRevision =
        events.at(-1)?.previousRevision !== undefined ? events.at(-1)!.previousRevision + 1 : after;
      return JSON.stringify({
        header,
        snapshot,
        previousEventSha256: previous ? digest(JSON.stringify(event(previous))) : null,
        events,
        nextRevision,
        isDone: nextRevision === work.revision,
      });
    } catch (error) {
      return report(error);
    }
  },
});
