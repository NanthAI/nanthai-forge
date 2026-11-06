// SPDX-License-Identifier: Apache-2.0
/** One bounded policy for GitHub read-after-write lag on objects the mirror job
 * itself just created or uploaded (incident 8568bc76; adff6f58). Pure data and
 * patterns, so Convex mutations and the mirror runner share it. */

/** Scheduled backoff before each extra try; its length is the retry budget. */
export const missingObjectDelays = [2_000, 10_000] as const;

/** POST git/trees: "tree.sha X is not a valid blob" for a blob this job uploaded. */
export const treeBlobPattern = /\btree\.sha ([0-9a-f]{40}) is not a valid blob\b/;

/** POST git/commits: "Tree SHA does not exist" for the tree this job just created. */
export const commitTreePattern = /\bTree SHA(?: [0-9a-f]{40})? does not exist\b/i;

/** True when a 422 from git/trees or git/commits names a missing or invalid
 * SHA of this job's own objects. Every other 422 stays terminal. */
export function isMissingObject(status: number, operation: string, githubError: string | undefined): boolean {
  if (status !== 422 || !githubError) return false;
  if (operation === 'POST git/trees') return treeBlobPattern.test(githubError);
  if (operation === 'POST git/commits') return commitTreePattern.test(githubError);
  return false;
}
