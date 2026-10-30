// SPDX-License-Identifier: Apache-2.0
import { ConvexError } from 'convex/values';
import { ForgeError } from '../src/errors';
import { internalMutation } from './_generated/server';
/** A ForgeError thrown inside a nested mutation reaches the calling action as a
 * plain `Error` whose code is lost, so a deterministic source failure never
 * settles the job. Source mutations that actions call (`sourceMutation`) throw a ConvexError
 * carrying the code instead; the action reads it back with `sourceDomainError`. */
export const sourceMutation = ((config: { handler: (ctx: unknown, args: unknown) => Promise<unknown> }) =>
  internalMutation({
    ...config,
    handler: async (ctx: unknown, args: unknown) => {
      try {
        return await config.handler(ctx, args);
      } catch (error) {
        if (error instanceof ForgeError)
          throw new ConvexError({
            code: error.code,
            message: error.message,
            ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
          });
        throw error;
      }
    },
  } as never)) as unknown as typeof internalMutation;
/** The domain failure behind `error`, or null for platform failures, which stay retryable. */
export function sourceDomainError(error: unknown): ForgeError | null {
  if (error instanceof ForgeError) return error;
  const data = error instanceof ConvexError ? (error.data as { code?: unknown; message?: unknown }) : null;
  return data && typeof data.code === 'string' && typeof data.message === 'string'
    ? new ForgeError(data.code, data.message)
    : null;
}
