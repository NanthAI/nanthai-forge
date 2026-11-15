// SPDX-License-Identifier: Apache-2.0
import { useConvexAuth, useConvex } from 'convex/react';
import { useCallback } from 'react';
import type { SourceInput } from './browser-source';
/** The reader is loaded on first use: it carries the language parsers that first paint never needs. */
export function useSourceReview() {
  const client = useConvex();
  const { isAuthenticated } = useConvexAuth();
  return useCallback(
    async (input: SourceInput) =>
      (await import('./browser-source')).readBrowserSource(client, input, !isAuthenticated),
    [client, isAuthenticated],
  );
}
