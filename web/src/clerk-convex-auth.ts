// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useAuth } from '@clerk/react';
import { useCallback } from 'react';

/** The Convex template lasts ten minutes, so open queries do not rerun on every Clerk session-token refresh. */
export function useConvexTokenAuth() {
  const auth = useAuth();
  const { getToken } = auth;
  const convexToken = useCallback(
    (options?: Parameters<typeof getToken>[0]) => getToken({ ...options, template: 'convex' }),
    [getToken],
  );
  return { ...auth, getToken: convexToken } as typeof auth;
}
