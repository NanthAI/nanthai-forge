// SPDX-License-Identifier: Apache-2.0
'use node';
import type { planProjectCheckLogs } from './projectCheckLogCleanup';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
const parts = ['objects', 'logs', 'shared', 'archives', 'hostedOutputs', 'digests'] as const;
type Identity = { projectId: Id<'hostedProjects'>; actor: string; operationId: string };
export async function readLogCleanup(ctx: ActionCtx, identity: Identity) {
  const original = await ctx.runQuery(internal.projectCheckLogCleanupStore.operation, identity);
  if (!original) return null;
  const state = JSON.parse(original);
  for (const part of parts) state[part] = [];
  let cursor: string | null = null;
  do {
    const page = JSON.parse(
      await ctx.runQuery(internal.projectCheckLogCleanupStore.pages, { ...identity, cursor }),
    );
    for (const row of page.page) state[row.part].push(...JSON.parse(row.value));
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor);
  return state;
}
/** Transport pages keep one-off cleanup receipts independent of project history size. */
export async function prepareLogCleanup(
  ctx: ActionCtx,
  identity: Identity,
  plan: Awaited<ReturnType<typeof planProjectCheckLogs>>,
) {
  const original = await readLogCleanup(ctx, identity);
  if (original?.phase === 'ready') return original;
  invariant(
    !original || original.planDigest === plan.planDigest,
    'EVIDENCE_CHANGED',
    'Resume the original cleanup scope before deletion.',
  );
  const header: Record<string, unknown> = {
    ...plan,
    phase: 'preparing',
    stagedPages: 0,
    totalPages: parts.reduce((sum, part) => sum + Math.ceil(plan[part].length / 25), 0),
    objectCount: plan.objects.length,
  };
  for (const part of parts) delete header[part];
  await ctx.runMutation(internal.projectCheckLogCleanupStore.begin, {
    ...identity,
    value: JSON.stringify(header),
  });
  for (const part of parts)
    for (let offset = 0; offset < plan[part].length; offset += 25)
      await ctx.runMutation(internal.projectCheckLogCleanupStore.stage, {
        ...identity,
        part,
        position: offset,
        planDigest: plan.planDigest,
        value: JSON.stringify(plan[part].slice(offset, offset + 25)),
      });
  return (await readLogCleanup(ctx, identity))!;
}
