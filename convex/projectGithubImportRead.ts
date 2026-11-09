// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { invariant } from '../src/errors';
import { projectExecution } from './projectExecution';
export async function readJob(
  ctx: QueryCtx,
  { id, actor }: { id: import('./_generated/dataModel').Id<'projectGithubImports'>; actor: string },
) {
  const row = await ctx.db.get(id);
  invariant(
    row && row.owner === actor,
    'PROJECT_UNAVAILABLE',
    'This import is unavailable with current access.',
  );
  projectExecution(ctx, row.projectId);
  await activeOwnedProject(ctx, row.projectId, actor);
  return row;
}
/** The job as its owner should see it: a stopped worker task reads as a
 * structured, resumable failure rather than a phase that never moves. */
export async function readJobState(
  ctx: QueryCtx,
  input: { id: import('./_generated/dataModel').Id<'projectGithubImports'>; actor: string },
) {
  const row = await readJob(ctx, input);
  if (row.phase === 'ready' || row.phase === 'error' || !row.task) return row;
  const task = await ctx.db.system.get(row.task);
  if (!task || ['failed', 'canceled'].includes(task.state.kind))
    return {
      ...row,
      phase: 'error' as const,
      error: {
        code: 'GITHUB_IMPORT_INTERRUPTED',
        message:
          'Import worker stopped. Retry the original operation to resume its saved commit and progress.',
      },
    };
  return row;
}
