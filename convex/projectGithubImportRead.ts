// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { invariant } from '../src/errors';
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
  await activeOwnedProject(ctx, row.projectId, actor);
  return row;
}
