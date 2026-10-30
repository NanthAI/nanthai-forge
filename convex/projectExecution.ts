// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
const traced = new WeakMap<object, Set<string>>();
/** Request-tree attribution only: no source, arguments, writes or extra reads.
 * The provider supplies request/execution IDs on this console event. */
export function projectExecution(ctx: Pick<QueryCtx, 'db'>, projectId: string, name?: string, key?: string) {
  let ids = traced.get(ctx);
  if (!ids) traced.set(ctx, (ids = new Set()));
  if (ids.has(projectId)) return;
  ids.add(projectId);
  console.log(
    `FORGE_PROJECT_EXECUTION ${JSON.stringify({ projectId, name: name || null, ...(key ? { key } : {}) })}`,
  );
}
