import { postAcceptMoves } from './post-accept-coverage.js';
// SPDX-License-Identifier: Apache-2.0
import { effectivePolicy } from './autonomy-policy.js';
import type { WorkData } from './work-types.js';
export const latestMain = (data: WorkData) =>
  postAcceptMoves(data.channelMoves)
    .filter(move => move.channel === 'main' && move.status === 'accepted')
    .at(-1);
/** A fast/scoped acceptance waits for its full post-accept check. */
export function isGreenMain(data: WorkData) {
  const move = latestMain(data);
  if (!move) return false;
  return data.runs.some(
    run =>
      run.status === 'passed' &&
      run.head === move.head &&
      (move.postAccept ? run.id === move.postAcceptRunId : run.viewId === move.viewId),
  );
}
export function pendingGithubPush(data: WorkData) {
  const policy = effectivePolicy(data).githubMirror,
    move = latestMain(data);
  if (!policy?.autoPush || !move || !isGreenMain(data)) return false;
  const status = data.githubAutoPush;
  if (
    status?.repository === policy.repo &&
    status.acceptanceId === move.id &&
    ['needs-you', 'failed'].includes(status.status)
  )
    return false;
  const binding = data.githubSync;
  return (
    binding?.repository.toLowerCase() !== policy.repo.toLowerCase() ||
    binding.commits[binding.pushed - 1]?.acceptanceId !== move.id
  );
}
