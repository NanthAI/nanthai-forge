// SPDX-License-Identifier: Apache-2.0
import { useMemo } from 'react';
import { useQueries } from 'convex/react';
import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from 'convex/server';
import { convexToJson, type Value } from 'convex/values';

/**
 * A live read that reports a server refusal or failure as `error` instead of throwing during render,
 * so one failed sub-read degrades only the panel that needs it. Same subscription as `useQuery`.
 */
export function useSafeQuery<Query extends FunctionReference<'query'>>(
  query: Query,
  args: FunctionArgs<Query> | 'skip',
): { value: FunctionReturnType<Query> | undefined; error: Error | undefined } {
  const key = args === 'skip' ? null : JSON.stringify(convexToJson(args));
  const name = getFunctionName(query);
  // `api.x.y` is a fresh reference every render: key on its name and arguments, like `useQuery`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const requests = useMemo(
    (): Record<string, { query: FunctionReference<'query'>; args: Record<string, Value> }> =>
      key === null ? {} : { read: { query, args: args as Record<string, Value> } },
    [name, key],
  );
  const result = useQueries(requests).read;
  return result instanceof Error
    ? { value: undefined, error: result }
    : { value: result as FunctionReturnType<Query> | undefined, error: undefined };
}
