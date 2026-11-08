// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';

/** A clean batch composition accounts for every named member exactly once: merged into the
 * result or retained as a dropped conflict. A member that is neither was silently skipped, and
 * publishing that State would report its work as landed (Issue 55bcad06). */
export function assertBatchAccounted(
  members: readonly string[],
  merged: readonly string[],
  dropped: readonly { candidateId: string }[] = [],
) {
  const seen = [...merged, ...dropped.map(drop => drop.candidateId)];
  const missing = members.filter(id => !seen.includes(id));
  invariant(
    !missing.length && seen.length === members.length && new Set(seen).size === seen.length,
    'SOURCE_JOB_INVALID',
    `Batch composition must merge or retain every member; unaccounted: ${missing.join(', ') || 'duplicate'}.`,
  );
}

export type BatchMemberPaths = {
  submissionId: string;
  /** The member's own Candidate head. */
  head: string;
  /** Paths the member's own Candidate changed against its base; absent when unknown. */
  paths: readonly string[] | null | undefined;
};
export type BatchCoverageGap = { submissionId: string; head: string; missing: string[]; more: number };

/** Members whose own changed paths are not all among the shared State's changed paths. Both lists
 * are on the Candidate records acceptance already reads, so this costs no call. An unknown list is
 * a gap. A gap is not yet a loss: a path can be net-unchanged in the shared State because its base
 * already had the member's bytes, or a later member reverted them; `proveMerged` decides. */
export function batchCoverageGaps(
  shared: readonly string[] | null | undefined,
  members: readonly BatchMemberPaths[],
): BatchCoverageGap[] {
  const changed = new Set(shared ?? []);
  const gaps: BatchCoverageGap[] = [];
  for (const member of members) {
    const missing = shared && member.paths ? member.paths.filter(path => !changed.has(path)) : [];
    if (shared && member.paths && !missing.length) continue;
    gaps.push({
      submissionId: member.submissionId,
      head: member.head,
      missing: missing.slice(0, 10),
      more: Math.max(0, missing.length - 10),
    });
  }
  return gaps;
}

/** Each composition step writes merge(prefix, member) or fast-forwards to a member head, so every
 * merged member is a State on the first-parent spine from the shared head down to its base, or a
 * later parent of one. `parents` returns recorded parents, or null when unknown. The walk is
 * bounded by the batch size; unknown or longer spines prove nothing. */
export async function proveMerged(
  head: string,
  base: string,
  memberHeads: readonly string[],
  parents: (id: string) => Promise<readonly string[] | null>,
  limit: number,
): Promise<boolean> {
  const covered = new Set<string>();
  let node = head;
  for (let steps = 0; node !== base; steps++) {
    if (steps >= limit) return false;
    covered.add(node);
    const edges = await parents(node);
    if (!edges?.length) return false;
    for (const edge of edges.slice(1)) covered.add(edge);
    node = edges[0]!;
  }
  covered.add(base);
  return memberHeads.every(id => covered.has(id));
}
