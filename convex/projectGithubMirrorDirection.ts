// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { effectivePolicy } from '../src/autonomy-policy';

/** Pre-P8 disabled policies had no resume marker and stored inbound:false for CLI compatibility.
 * The last enabled policy is selected by index, even after unrelated policy edits; no history scan. */
export async function mirrorResumeInbound(ctx: QueryCtx | MutationCtx, project: Doc<'hostedProjects'>) {
  const mirror = effectivePolicy(project).githubMirror;
  if (!mirror || mirror.autoPush) return mirror?.inbound === true;
  if (project.githubMirrorPausedInbound !== undefined) return project.githubMirrorPausedInbound;
  if (mirror.inbound) return true;
  const last = await ctx.db
    .query('projectPolicyChanges')
    .withIndex('by_project_and_previous_mirror', q =>
      q.eq('projectId', project._id).eq('previous.githubMirror.autoPush', true),
    )
    .order('desc')
    .first();
  const previous = last?.previous.githubMirror;
  return previous?.repo.toLowerCase() === mirror.repo.toLowerCase() && previous.inbound === true;
}
