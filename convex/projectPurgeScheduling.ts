// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

/** Publish each page and its scheduler receipt together; old deliveries cannot fork the chain. */
export async function scheduleR2Purge(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  cursor = project.r2Purge?.cursor ?? null,
  failures = 0,
  delay = 0,
) {
  const generation = (project.r2Purge?.generation ?? 0) + 1;
  const task = await ctx.scheduler.runAfter(
    delay,
    makeFunctionReference<'action'>('projectR2Maintenance:purgeDeletedProjectPage'),
    { projectId: project._id, generation, cursor },
  );
  await ctx.db.patch(project._id, {
    task,
    r2Purge: { generation, cursor, failures },
    purgeBlocked: undefined,
  });
}
