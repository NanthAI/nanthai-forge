// SPDX-License-Identifier: Apache-2.0
// Real Convex action hooks are stable; preserve that contract in this synthetic preview.
export * from './hosted-tree/convex-react.mjs';
import { useCallback } from 'react';
import { getFunctionName } from 'convex/server';
export const useAction = reference => {
  const name = getFunctionName(reference);
  return useCallback(async args => globalThis.__forgeTree?.actions?.[name]?.(args) ?? null, [name]);
};

export const useMutation = reference => {
  const name = getFunctionName(reference);
  return useCallback(async args => globalThis.__forgeTree?.mutations?.[name]?.(args) ?? null, [name]);
};
