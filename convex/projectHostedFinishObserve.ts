// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { finishRow } from './projectHostedFinishWake';
import { loadLanding } from './projectHostedLandingStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { sourceAuthority } from '../src/hosted-source-authority';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Finite selected-request pages. Every page/subscription rechecks current access;
 * neither reading nor reconnecting wakes a controller. Versions are durable offsets,
 * not authorization. An older record without retained versions is resnapshotted. */
export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    nextVersion: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to observe hosted submissions.');
      const project = await accessibleProject(ctx, input.projectId, user.subject);
      invariant(
        Number.isSafeInteger(input.nextVersion) && input.nextVersion >= 0,
        'BAD_ARGUMENT',
        'Select a submission version.',
      );
      const rows = await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .take(2);
      invariant(rows.length === 1, 'NOT_FOUND', 'Select one hosted landing operation.');
      const { state } = await loadLanding(ctx, {
        projectId: input.projectId,
        submissionId: rows[0]!.submissionId,
      });
      const finish = await finishRow(ctx, { projectId: input.projectId, submissionId: state.id });
      const pendingAttempt = finish ? JSON.parse(finish.value).pending : null;
      const events = [];
      let nextVersion = input.nextVersion,
        resnapshot = false;
      // Exact indexed reads keep both documents and ranges bounded, including gaps
      // in pre-journal history. Never scan unrelated operations or Work/source data.
      for (let n = 0; n < 20 && nextVersion <= state.version; n++) {
        const row = await ctx.db
          .query('projectHostedLandingObservations')
          .withIndex('by_project_and_submission_and_version', q =>
            q.eq('projectId', input.projectId).eq('submissionId', state.id).eq('version', nextVersion),
          )
          .unique();
        if (!row) {
          events.push({ submission: state, pendingAttempt });
          nextVersion = state.version + 1;
          resnapshot = true;
          break;
        }
        events.push(JSON.parse(row.value));
        nextVersion++;
      }
      return canonicalPayload({
        projectId: input.projectId,
        operationId: input.operationId,
        authority: sourceAuthority(project),
        submission: state,
        pendingAttempt,
        events,
        nextVersion,
        isDone: nextVersion > state.version,
        resnapshot,
      });
    } catch (error) {
      return report(error);
    }
  },
});
