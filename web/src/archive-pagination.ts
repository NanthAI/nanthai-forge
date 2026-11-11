// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { useConvex, useQueries } from 'convex/react';
import type {
  PaginatedQueryArgs,
  PaginatedQueryItem,
  PaginatedQueryReference,
  PaginationStatus,
} from 'convex/react';
import { getFunctionName, makeFunctionReference, type FunctionReference } from 'convex/server';
import { convexToJson, type Value } from 'convex/values';
import { hasJournalHistory, hydrateLandingHistory } from '../../src/landing-capsule-client';

type Page = { page: unknown[]; isDone: boolean; continueCursor: string };
type Cached = { token: string; value?: Page; error?: Error };
/** Keep the original live page subscriptions. Only a cold marker adds an authorized action.
 * Every page's viewer commitment keys its hydration, so a role change hides all stale pages. */
export function useArchivePaginatedQuery<Q extends PaginatedQueryReference>(
  query: Q,
  args: PaginatedQueryArgs<Q> | 'skip',
  options: { initialNumItems: number; throwOnError?: boolean },
) {
  const client = useConvex(),
    name = getFunctionName(query);
  const selection =
    args === 'skip' ? null : `${name}:${JSON.stringify(convexToJson(args as Record<string, Value>))}`;
  const [requested, setRequested] = useState({
    selection,
    pages: [{ cursor: null as string | null, numItems: options.initialNumItems }],
  });
  const pages =
    requested.selection === selection
      ? requested.pages
      : [{ cursor: null as string | null, numItems: options.initialNumItems }];
  const requests = useMemo(
    () =>
      selection === null
        ? {}
        : Object.fromEntries(
            pages.map((page, i) => [
              String(i),
              {
                query: query as FunctionReference<'query'>,
                args: { ...(args as Record<string, Value>), paginationOpts: page } as Record<string, Value>,
              },
            ]),
          ),
    [selection, JSON.stringify(pages)],
  );
  const observed = useQueries(requests);
  const [cached, setCached] = useState<Record<string, Cached>>({});
  const current = useRef(new Map<string, string>()),
    pending = useRef(new Set<string>()),
    mounted = useRef(false);
  const candidates = Object.entries(requests).map(([id, request]) => {
    const raw = observed[id],
      token = `${selection}:${id}:${raw instanceof Error && !hasJournalHistory(raw) ? raw.message : JSON.stringify(raw instanceof Error ? (raw as Error & { data?: unknown }).data : raw)}`;
    return { id, request, raw, token };
  });
  current.current = new Map(candidates.map(item => [item.id, item.token]));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const tokens = candidates.map(item => item.token).join('\n');
  useEffect(() => {
    for (const item of candidates) {
      if (
        item.raw === undefined ||
        (item.raw instanceof Error && !hasJournalHistory(item.raw)) ||
        !hasJournalHistory(item.raw) ||
        cached[item.id]?.token === item.token ||
        pending.current.has(item.token)
      )
        continue;
      pending.current.add(item.token);
      void hydrateLandingHistory(name, item.request.args, item.raw, (name, input) =>
        client.action(makeFunctionReference<'action'>(name), {
          ...input,
          projectId: item.request.args.projectId,
        }),
      )
        .then(value => (typeof value === 'string' ? JSON.parse(value) : value))
        .then(
          value => {
            if (mounted.current && current.current.get(item.id) === item.token)
              setCached(old => ({ ...old, [item.id]: { token: item.token, value: value as Page } }));
          },
          error => {
            if (mounted.current && current.current.get(item.id) === item.token)
              setCached(old => ({
                ...old,
                [item.id]: {
                  token: item.token,
                  error: error instanceof Error ? error : new Error(String(error)),
                },
              }));
          },
        )
        .finally(() => pending.current.delete(item.token));
    }
  }, [client, name, tokens, cached]);
  let error: Error | undefined,
    loading = false;
  const resolved: Page[] = [];
  for (const item of candidates) {
    if (item.raw instanceof Error && !hasJournalHistory(item.raw)) {
      error = item.raw;
      break;
    }
    const hit = cached[item.id]?.token === item.token ? cached[item.id] : undefined;
    if (hit?.error) {
      error = hit.error;
      break;
    }
    const value = item.raw !== undefined && !hasJournalHistory(item.raw) ? (item.raw as Page) : hit?.value;
    if (!value) {
      loading = true;
      break;
    }
    resolved.push(value);
  }
  const last = resolved.at(-1);
  const status: PaginationStatus | 'Error' = error
    ? 'Error'
    : loading
      ? resolved.length
        ? 'LoadingMore'
        : 'LoadingFirstPage'
      : last?.isDone || selection === null
        ? 'Exhausted'
        : 'CanLoadMore';
  if (error && options.throwOnError) throw error;
  return {
    results: resolved.flatMap(page => page.page) as PaginatedQueryItem<Q>[],
    status,
    error,
    loadMore: (numItems: number) => {
      if (status !== 'CanLoadMore' || !last) return;
      setRequested({ selection, pages: [...pages, { cursor: last.continueCursor, numItems }] });
    },
  };
}
