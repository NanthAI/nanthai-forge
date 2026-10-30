// SPDX-License-Identifier: Apache-2.0
'use node';
import { ConvexError } from 'convex/values';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

export const retryCode = 'WORK_INDEX_RETRY';
const contexts = new WeakSet<ActionCtx>();
export function indexReadFailure(ctx: ActionCtx, error: unknown) {
  return contexts.has(ctx) && indexTransient(error);
}
function code(error: unknown): unknown {
  if (error instanceof ConvexError && error.data && typeof error.data === 'object')
    return (error.data as { code?: unknown }).code;
  return error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
}
/** Typed application/validation/access failures never become transport retries. */
export function indexTransient(error: unknown): boolean {
  const value = code(error);
  if (value === retryCode || value === 'EXCHANGE_REQUEST_TIMEOUT' || value === 'EXCHANGE_REQUEST_FAILED')
    return true;
  if (
    !(error instanceof ConvexError) &&
    !(error instanceof Error && error.name === 'ForgeError') &&
    ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET'].includes(String(value))
  )
    return true;
  if (error instanceof ConvexError) return false;
  if (value !== undefined) return false;
  return (
    error instanceof Error &&
    /\btransient error\b|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET)\b|\b(?:request|storage|fetch|query) (?:timed out|timeout)\b/i.test(
      error.message,
    )
  );
}

export async function indexRead<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!indexTransient(error) || code(error) === retryCode) throw error;
      if (attempt === 2)
        throw new ConvexError({
          code: retryCode,
          message: 'Transient index read; resume the saved build cursor.',
        });
      await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

/** Only reads retry in-place. Cursor mutations retain their existing CAS/replay
 * semantics; exhausted child reads carry a typed signal across action boundaries. */
export function indexReadContext(ctx: ActionCtx): ActionCtx {
  if (contexts.has(ctx)) return ctx;
  const result: ActionCtx = {
    ...ctx,
    runQuery: (ref, args) => indexRead(() => ctx.runQuery(ref, args)),
    runAction: (ref, args) => indexRead(() => ctx.runAction(ref, args)),
    storage: {
      ...ctx.storage,
      get: (id: Id<'_storage'>) => indexRead(() => ctx.storage.get(id)),
      getMetadata: (id: Id<'_storage'>) => indexRead(() => ctx.storage.getMetadata(id)),
      getUrl: (id: Id<'_storage'>) => indexRead(() => ctx.storage.getUrl(id)),
    },
  };
  contexts.add(result);
  return result;
}

export const isIndexReadContext = (ctx: ActionCtx) => contexts.has(ctx);
/** Attach the exact raw/recipe object pin without retrying an exhausted child. */
export async function indexObjectRead<T>(
  ctx: ActionCtx,
  pin: { sha256: string; size: number },
  operation: () => Promise<T>,
): Promise<T> {
  if (!contexts.has(ctx)) return operation();
  try {
    return await indexRead(operation);
  } catch (error) {
    if (error instanceof ConvexError && code(error) === retryCode)
      throw new ConvexError({
        ...(error.data as Record<string, unknown>),
        pin: (error.data as { pin?: { sha256: string; size: number } }).pin ?? {
          sha256: pin.sha256,
          size: pin.size,
        },
      });
    throw error;
  }
}
