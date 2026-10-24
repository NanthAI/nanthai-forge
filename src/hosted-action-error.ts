// SPDX-License-Identifier: Apache-2.0
import { ConvexError } from 'convex/values';
import { ForgeError } from './errors.js';

/** Server messages can contain private source or credentials. Only copy the
 * platform's hexadecimal request ID into the actionable transport error. */
export function hostedActionError(error: unknown, phase: string): ForgeError {
  if (error instanceof ForgeError) return error;
  if (error instanceof ConvexError && error.data && typeof error.data === 'object') {
    const data = error.data as { code?: unknown; message?: unknown };
    if (typeof data.code === 'string' && typeof data.message === 'string' && data.code !== 'INTERNAL_ERROR')
      return new ForgeError(data.code, data.message);
  }
  const requestId =
    error instanceof Error ? /\[Request ID:\s*([a-f0-9]+)\]/i.exec(error.message)?.[1] : undefined;
  return new ForgeError(
    'HOSTED_ACTION_FAILED',
    `Hosted ${phase} failed${requestId ? ` (Convex request ID: ${requestId})` : ''}. Push again to resume the retained operation; if it persists, inspect the deployment's action logs${requestId ? ' for this request ID' : ''}.`,
  );
}
