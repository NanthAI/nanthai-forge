// SPDX-License-Identifier: Apache-2.0
import { ConvexError } from 'convex/values';
import { ForgeError } from '../src/errors';

export function report(error: unknown): never {
  if (error instanceof ConvexError) {
    if (
      error.data &&
      typeof error.data === 'object' &&
      'code' in error.data &&
      error.data.code === 'INTERNAL_ERROR'
    )
      throw new ConvexError({
        code: 'HOSTED_ACTION_FAILED',
        message:
          'The hosted request failed before its outcome was known. Retry the original operation ID and payload to reconcile its receipt.',
      });
    throw error;
  }
  if (
    error instanceof Error &&
    /(?:Documents read from or written to|OptimisticConcurrencyControl|OCC conflict)/i.test(error.message)
  )
    throw new ConvexError({
      code: 'HOSTED_CONFLICT',
      message:
        'Concurrent hosted Work transaction changed during this request. Retry the original operation ID and payload to reconcile its receipt.',
    });
  if (!(error instanceof ForgeError)) {
    // Log diagnostic strings only: custom error fields/cause can contain requests or credentials.
    // Convex validation messages include the rejected document; omit that payload.
    const diagnostic = (value: string) =>
      value.replace(/Object: [\s\S]*?(?=Validator:|$)/g, 'Object: [redacted]\n');
    console.error('Unexpected Forge error', {
      name: error instanceof Error ? error.name : 'NonError',
      message: error instanceof Error ? diagnostic(error.message) : 'A non-Error value was thrown.',
      stack: error instanceof Error && error.stack ? diagnostic(error.stack) : undefined,
    });
  }
  throw new ConvexError(
    error instanceof ForgeError
      ? {
          code: error.code,
          message: error.message,
          ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        }
      : { code: 'HOSTED_REQUEST_FAILED', message: 'The Forge request failed. Retry the original request.' },
  );
}
