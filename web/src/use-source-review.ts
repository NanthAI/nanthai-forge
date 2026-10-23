// SPDX-License-Identifier: Apache-2.0
import { useConvex } from 'convex/react';
import { useCallback } from 'react';
import { readBrowserSource, type SourceInput } from './browser-source';
export function useSourceReview() {
  const client = useConvex();
  return useCallback((input: SourceInput) => readBrowserSource(client, input), [client]);
}
