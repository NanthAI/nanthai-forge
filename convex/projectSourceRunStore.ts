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
    index: v.optional(v.number()),
    page: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, { kind, index, page, ...auth }) => {
    try {
      invariant(
        kind === 'save' || (index === undefined && page === undefined),
        'BAD_ARGUMENT',
        'Only a save submits a delta page.',
      );
      const submitted =
        kind === 'save'
          ? await submitHostedSave(ctx, { ...auth, index, page }, true)
          : kind === 'sync'
            ? await submitHostedSync(ctx, auth, true)
            : await submitHostedCompose(ctx, auth, true);
      return JSON.stringify(submitted);
    } catch (error) {
      return report(error);
    }
  },
});
