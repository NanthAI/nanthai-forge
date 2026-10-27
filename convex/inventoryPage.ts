// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { report } from './errors';
import type { ActionCtx } from './cliServer';

/** Raw rows are internal; public lists check current GitHub access in an action. */
export async function inventoryPage<T extends { page: unknown[] }>(
  ctx: ActionCtx,
  name: string,
  args: unknown,
): Promise<T> {
  try {
    const page = await ctx.runQuery(
      makeFunctionReference<'query', Record<string, unknown>, T>(name),
      args as Record<string, unknown>,
    );
    const rows = await ctx.runAction(
      makeFunctionReference<'action', { rows: unknown[] }, unknown[]>('inventoryAccess:read'),
      { rows: page.page },
    );
    return { ...page, page: rows } as T;
  } catch (error) {
    return report(error);
  }
}
