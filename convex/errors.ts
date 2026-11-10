// SPDX-License-Identifier: Apache-2.0
import { ConvexError } from 'convex/values';
import { SourceAuthorityStaleError } from '../src/hosted-source-authority';
import { ForgeError } from '../src/errors';

/** Convex refused to store a document (the deployed schema lacks a field the write carries). Named and
 * terminal, never HOSTED_REQUEST_FAILED: a retry fails the same way (Issue 1eb42254 follow-up). The
 * message keeps the table, path and field names only; Convex's text also quotes the rejected value. */
const schemaName = (value: string | undefined) =>
  value && /^[\w.$[\]-]{1,160}$/.test(value) ? value : undefined;
export function schemaRejection(message: string) {
  if (!/does not match the schema|that is not in the validator/i.test(message)) return undefined;
  const table = schemaName(/in table "([^"]+)"/.exec(message)?.[1]),
    path = schemaName(/^Path: *(\S+)/m.exec(message)?.[1]?.replace(/^\./, '')),
    extra = schemaName(/extra field `([^`]+)`/.exec(message)?.[1]),
    field = [table, path, extra].filter(Boolean).join('.') || undefined;
  return {
    code: 'HOSTED_SCHEMA_REJECTED',
    ...(field ? { field } : {}),
    message: `This Forge server cannot store ${field ?? 'this request'}${extra ? ' (no such field in its schema)' : ' (the value does not match its schema)'}; the write was refused. A retry fails the same way until the server is updated.`,
  };
}
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
  const rejected = error instanceof Error ? schemaRejection(error.message) : undefined;
  if (rejected) throw new ConvexError(rejected);
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
          ...(error instanceof SourceAuthorityStaleError ? { authority: error.authority } : {}),
          message: error.message,
          ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
          // ITEM_CHANGED names the item and both versions (flip 5); other codes keep their recovery server-side.
          ...(error.code === 'ITEM_CHANGED' && error.recovery
            ? { recovery: error.recovery as Record<string, string | number> }
            : {}),
        }
      : { code: 'HOSTED_REQUEST_FAILED', message: 'The Forge request failed. Retry the original request.' },
  );
}
