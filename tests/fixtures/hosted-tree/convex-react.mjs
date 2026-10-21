// SPDX-License-Identifier: Apache-2.0
// Test double for convex/react: answers queries from globalThis.__forgeTree by function name.
import { createElement, Fragment } from 'react';
import { getFunctionName } from 'convex/server';

const tree = () => globalThis.__forgeTree ?? { queries: {}, pages: {}, actions: {} };
const name = reference => getFunctionName(reference);
export class ConvexReactClient {
  constructor(url) {
    this.url = url;
  }
}
const empty = args => (args?.paginationOpts ? { page: [], isDone: true, continueCursor: '' } : null);
const client = {
  query: async (reference, args) => {
    const answer = tree().queries[name(reference)];
    return answer ? answer(args) : empty(args);
  },
  action: async (reference, args) => tree().actions?.[name(reference)]?.(args) ?? null,
  mutation: async (reference, args) => tree().mutations?.[name(reference)]?.(args) ?? null,
};
export const ConvexProvider = ({ children }) => createElement(Fragment, null, children);
export const useConvex = () => client;
export const useConvexAuth = () => ({ isAuthenticated: true, isLoading: false });
export const useConvexConnectionState = () => ({ isWebSocketConnected: true, hasEverConnected: true });
export const useQuery = (reference, args) =>
  args === 'skip' ? undefined : tree().queries[name(reference)]?.(args ?? {});
export const usePaginatedQuery = (reference, args) => ({
  results: args === 'skip' ? [] : (tree().pages[name(reference)]?.(args ?? {}) ?? []),
  status: 'Exhausted',
  isLoading: false,
  loadMore() {},
});
export const useMutation = () => async () => null;
export const useAction = reference => async args => tree().actions?.[name(reference)]?.(args) ?? null;

export const useQueries = queries => Object.fromEntries(Object.entries(queries).map(([key, { query, args }]) => [key, useQuery(query, args)]));
