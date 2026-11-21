// SPDX-License-Identifier: Apache-2.0
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { v, type Infer } from 'convex/values';
import { getPage } from 'convex-helpers/server/pagination';
import type { Doc } from '../../../node_modules/@convex-dev/auth/dist/components/passkey/_generated/dataModel.js';
import {
  query,
  type QueryCtx,
} from '../../../node_modules/@convex-dev/auth/dist/components/passkey/_generated/server.js';
import { PASSKEY_PAGE_SIZE, displayPasskey, firstPasskeyPage, passkeyPosition } from '../../authPasskeyPage';
import schema from './schema';

type Position = Infer<typeof passkeyPosition>;

function position(row: Doc<'passkeys'>) {
  return { passkeyId: row._id, createdAt: row._creationTime };
}

function display(row: Doc<'passkeys'>) {
  return { ...position(row), ...(row.name ? { name: row.name } : {}) };
}

function encodeCursor({ createdAt, passkeyId }: Position) {
  return JSON.stringify([createdAt, passkeyId]);
}

function decodeCursor(cursor: string): Position {
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new Error('InvalidCursor');
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isFinite(value[0]) ||
    typeof value[1] !== 'string'
  )
    throw new Error('InvalidCursor');
  return { createdAt: value[0], passkeyId: value[1] };
}

function comparePositions(left: Position, right: Position) {
  return (
    left.createdAt - right.createdAt ||
    (left.passkeyId < right.passkeyId ? -1 : left.passkeyId === right.passkeyId ? 0 : 1)
  );
}

function readPage(ctx: QueryCtx, userId: string, start?: Position, end?: Position | null) {
  // Supply both bounds in one index walk. The account prefix comes only from auth.
  return getPage(ctx, {
    table: 'passkeys',
    index: 'by_userId',
    schema,
    startIndexKey: start ? [userId, start.createdAt, start.passkeyId] : [userId],
    startInclusive: !start,
    endIndexKey: end ? [userId, end.createdAt, end.passkeyId] : [userId],
    absoluteMaxRows: PASSKEY_PAGE_SIZE,
  });
}

export const first = query({
  args: { userId: v.string() },
  returns: firstPasskeyPage,
  handler: async (ctx, { userId }) => {
    const { page, hasMore } = await readPage(ctx, userId);
    return {
      page: page.map(display),
      continueAfter: hasMore ? position(page.at(-1)!) : null,
    };
  },
});

export const more = query({
  args: { userId: v.string(), after: passkeyPosition, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(displayPasskey),
  handler: async (ctx, { userId, after, paginationOpts }) => {
    const { cursor, endCursor } = paginationOpts;
    const start = cursor === null ? after : decodeCursor(cursor);
    const end = endCursor ? decodeCursor(endCursor) : null;
    if (comparePositions(start, after) < 0 || (end && comparePositions(end, start) <= 0))
      throw new Error('InvalidCursor');
    const { page, hasMore } = await readPage(ctx, userId, start, end);
    if (endCursor && hasMore)
      return {
        page: page.map(display),
        isDone: false,
        continueCursor: endCursor,
        splitCursor: encodeCursor(position(page[Math.floor(page.length / 2) - 1]!)),
        pageStatus: 'SplitRequired' as const,
      };
    return {
      page: page.map(display),
      isDone: !end && !hasMore,
      continueCursor: endCursor ?? (hasMore ? encodeCursor(position(page.at(-1)!)) : ''),
    };
  },
});
