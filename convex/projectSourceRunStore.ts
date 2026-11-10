// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { submitHostedSave } from './projectHostedSaveJobs';
import { submitHostedSync } from './projectHostedSyncJobs';
import { submitHostedCompose } from './projectHostedComposeJobs';
import { invariant } from '../src/errors';
import { report } from './errors';

/** The submit transaction of `projectSourceRun:submit`, for the authenticated actor that action
 * read. The same submit as the public mutation, with the dispatch inline. */
export const submit = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    actor: v.string(),
    kind: v.union(v.literal('save'), v.literal('sync'), v.literal('compose')),
    clientMs: v.optional(v.number()),
    index: v.optional(v.number()),
    page: v.optional(v.string()),
    /** A save that settles on the scheduler (feature save-settle-background): no inline run. */
    background: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, { kind, index, page, clientMs, background, ...auth }) => {
    try {
      invariant(
        kind === 'save' || (index === undefined && page === undefined),
        'BAD_ARGUMENT',
        'Only a save submits a delta page.',
      );
      invariant(!background || kind === 'save', 'BAD_ARGUMENT', 'Only a save settles in the background.');
      const submitted =
        kind === 'save'
          ? await submitHostedSave(ctx, { ...auth, index, page, clientMs }, !background, background === true)
          : kind === 'sync'
            ? await submitHostedSync(ctx, auth, true)
            : await submitHostedCompose(ctx, auth, true);
      return JSON.stringify(submitted);
    } catch (error) {
      return report(error);
    }
  },
});
