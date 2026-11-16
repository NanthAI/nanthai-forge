// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

// Request metadata is immutable within an invocation and propagated through
// runMutation. Cache only the job id, never the rest of the request metadata.
const owners = new WeakMap<MutationCtx['meta'], Promise<string | null>>();
/** A running mutation still appears pending in the system table. Check its
 * request owner first; cancelling a running action would also poison its children.
 * A caller that already read this task passes it (including null) without rereading. */
export async function cancelPendingTask(
  ctx: MutationCtx,
  id: Id<'_scheduled_functions'> | null | undefined,
  knownTask?: { state: { kind: string } } | null,
) {
  if (!id) return false;
  let owner = owners.get(ctx.meta);
  if (!owner) {
    owner = ctx.meta.getRequestMetadata().then(metadata => metadata.scheduledFunctionId);
    owners.set(ctx.meta, owner);
  }
  if ((await owner) === id) return false;
  const task = knownTask === undefined ? await ctx.db.system.get(id) : knownTask;
  if (task?.state.kind !== 'pending') return false;
  await ctx.scheduler.cancel(id);
  return true;
}
