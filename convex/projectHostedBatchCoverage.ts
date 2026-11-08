// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { findObject } from './projectObjectFind';
import { batchCoverageGaps, proveMerged, type BatchMemberPaths } from '../src/hosted-batch-coverage';

/** Issue 55bcad06: a batch receipt may say LANDED only when the shared State carries every member.
 * Normal path: the member and shared changed-path lists already read, no further read. Only a
 * member with a path gap costs a bounded first-parent walk over recorded State parents (at most
 * 2 * members + 2 indexed rows); a gap that walk cannot close is returned and never published. */
export async function batchCoverageFailure(
  ctx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    head: string;
    base: string;
    shared: readonly string[] | null | undefined;
    members: readonly BatchMemberPaths[];
  },
) {
  const gaps = batchCoverageGaps(input.shared, input.members);
  if (!gaps.length) return null;
  const merged = await proveMerged(
    input.head,
    input.base,
    gaps.map(gap => gap.head),
    async id => (await findObject(ctx, input.projectId, id))?.stateParents ?? null,
    2 * input.members.length + 2,
  );
  return merged ? null : gaps[0]!;
}
