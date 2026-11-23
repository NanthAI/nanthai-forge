// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Old addresses that name a thing only by id: `?project=<id>` links, `/decisions/<id>` and `/review/<id>` (Item
// d61f36fe). One read answers where it lives now. A project the caller cannot read answers null, the same as a missing
// one, so an id never reveals a handle.
import { v } from 'convex/values';
import { query } from './cliServer';
import { decisionRow } from './projectHostedDecisionsStore';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { readProjectRole } from './projectAuthority';
import { readableProject } from './urlProjects';

export type LegacyTarget = { place: 'lanes' | 'plan'; id: string };

/** An Intent's decision belongs to its Item; a project-wide decision has no Lane or Item of its own. */
export function decisionTarget(target: string): LegacyTarget | null {
  return target.startsWith('intent:') ? { place: 'plan', id: target.slice('intent:'.length) } : null;
}

/** A review view (a Candidate) belongs to the Lane it composed first, else to its Intent's Item. */
export function reviewTarget(value: string): LegacyTarget | null {
  let view: { inputs?: { laneId?: unknown }[]; resolution?: { laneId?: unknown }; intentId?: unknown };
  try {
    view = JSON.parse(value);
  } catch {
    return null;
  }
  const lane =
    view.inputs?.find(input => typeof input?.laneId === 'string')?.laneId ?? view.resolution?.laneId;
  if (typeof lane === 'string') return { place: 'lanes', id: lane };
  return typeof view.intentId === 'string' ? { place: 'plan', id: view.intentId } : null;
}

export const resolve = query({
  args: {
    handle: v.optional(v.string()),
    slug: v.optional(v.string()),
    projectId: v.optional(v.string()),
    find: v.optional(v.object({ kind: v.union(v.literal('decision'), v.literal('review')), id: v.string() })),
  },
  returns: v.union(
    v.object({
      handle: v.string(),
      slug: v.string(),
      to: v.union(
        v.null(),
        v.object({ place: v.union(v.literal('lanes'), v.literal('plan')), id: v.string() }),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, { find, ...input }) => {
    const found = await readableProject(ctx, input);
    if (!found) return null;
    const { handle, slug, project } = found;
    let to: LegacyTarget | null = null;
    if (find) {
      // A decision or view names Work ids; public visibility is not a role, so only the project's own people learn them.
      const user = await ctx.auth.getUserIdentity();
      if (!user || !(await readProjectRole(ctx, project, user.subject))) return { handle, slug, to };
      if (find.kind === 'decision') {
        const row = await decisionRow(ctx, found.id, find.id);
        to = row ? decisionTarget(row.target) : null;
      } else {
        const generation = await selectedGeneration(ctx, project);
        const row = generation ? await record(ctx, recordPartition(generation), 'views', find.id) : null;
        to = row ? reviewTarget(row.value) : null;
      }
    }
    return { handle, slug, to };
  },
});
