// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
const gitId = z.string().regex(/^[0-9a-f]{40}$/);
/** Empty means a root commit / a branch that did not exist yet. */
const optionalGitId = z.string().regex(/^([0-9a-f]{40})?$/);
const identity = z.object({ name: z.string().min(1), email: z.string().min(1) });
export const githubSyncCommitSchema = z.object({
  excludedPaths: z.array(z.string()).optional(),
  operationId: z.uuid(),
  state: z.string().regex(/^[0-9a-f]{64}$/),
  acceptanceId: z.uuid(),
  viewId: z.uuid(),
  commit: gitId,
  parent: optionalGitId,
  tree: gitId,
  message: z.string(),
  author: identity,
  committer: identity,
  seconds: z.number().int().safe(),
});
export const githubSyncSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: z.string().min(1),
    adoptedCommit: optionalGitId,
    commits: z.array(githubSyncCommitSchema).min(1),
    pushed: z.number().int().nonnegative(),
    pushedAt: z.string().datetime().optional(),
    /** Last accepted main move already covered: a commit, or a move with no source change. */
    cursor: z.object({ acceptanceId: z.uuid(), state: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
  })
  .refine(value => value.pushed <= value.commits.length);
export const githubSyncHistorySchema = z.object({
  id: z.uuid(),
  replacedAt: z.string().datetime(),
  binding: githubSyncSchema,
});
export type GithubSyncBinding = z.infer<typeof githubSyncSchema>;
export type GithubSyncCommit = z.infer<typeof githubSyncCommitSchema>;

export const githubAutoPushSchema = z.object({
  id: z.literal('github-auto-push'),
  worker: z.object({ pid: z.number().int(), startTime: z.string().optional() }).optional(),
  repository: z.string(),
  acceptanceId: z.uuid(),
  state: z.string(),
  operationId: z.uuid(),
  status: z.enum(['queued', 'pushing', 'retrying', 'pushed', 'needs-you', 'failed']),
  attempts: z.number().int().nonnegative(),
  at: z.string(),
  nextAttemptAt: z.string().optional(),
  code: z.string().optional(),
  detail: z.string().optional(),
  expectedHead: z.string().optional(),
  remoteHead: z.string().optional(),
  localHead: z.string().optional(),
  undo: z.string(),
});
export type GithubAutoPush = z.infer<typeof githubAutoPushSchema>;
