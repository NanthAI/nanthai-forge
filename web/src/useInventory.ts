// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import {
  makeFunctionReference,
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';

type Page = { page: unknown[]; isDone: boolean; continueCursor: string };
/** Invalidate reactively without returning locations from an unauthorised query. */
export function useInventory<F extends FunctionReference<'action', 'public', Record<string, unknown>, Page>>(
  action: F,
  kind: 'sourceZones' | 'savedViews' | 'interests',
  args: { importId?: Id<'imports'> } | 'skip',
  initialNumItems: number,
) {
  const client = useConvex();
  const actionName = getFunctionName(action);
  const [count, setCount] = useState(initialNumItems);
  const signature = JSON.stringify(args);
  const version = useQuery(
    makeFunctionReference<
      'query',
      { kind: typeof kind; importId?: Id<'imports'>; paginationOpts: { numItems: number; cursor: null } },
      string
    >('inventoryChanges:watch'),
    args === 'skip' ? 'skip' : { kind, ...args, paginationOpts: { numItems: count, cursor: null } },
  );
  const [result, setResult] = useState<{
    version: string;
    signature: string;
    value: FunctionReturnType<F>;
  }>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (version === undefined || signature === '"skip"') return;
    let active = true;
    const input = {
      ...JSON.parse(signature),
      paginationOpts: { numItems: count, cursor: null },
    } as FunctionArgs<F>;
    void client
      .action(
        makeFunctionReference<'action', Record<string, unknown>, FunctionReturnType<F>>(actionName),
        input,
      )
      .then(
        value => {
          if (active) {
            setResult({ version, signature, value });
            setError(undefined);
          }
        },
        reason => {
          if (active) setError(reason);
        },
      );
    return () => {
      active = false;
    };
  }, [client, actionName, version, signature, count]);
  if (error) throw error;
  const current =
    result && result.version === version && result.signature === signature ? result.value : undefined;
  return {
    results: (current?.page ?? []) as FunctionReturnType<F>['page'],
    status: !current ? 'LoadingFirstPage' : current.isDone ? 'Exhausted' : 'CanLoadMore',
    loadMore: (amount: number) => setCount(value => value + amount),
  };
}

export function useInterest(importId: Id<'imports'>) {
  const client = useConvex();
  const version = useQuery(
    makeFunctionReference<
      'query',
      {
        kind: 'interestCurrent';
        importId: Id<'imports'>;
        paginationOpts: { numItems: number; cursor: null };
      },
      string
    >('inventoryChanges:watch'),
    { kind: 'interestCurrent', importId, paginationOpts: { numItems: 1, cursor: null } },
  );
  type Interest = import('../../convex/_generated/dataModel').Doc<'projectInterests'> | null;
  const [result, setResult] = useState<{ version: string; value: Interest }>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (version === undefined) return;
    let active = true;
    void client
      .action(makeFunctionReference<'action', { importId: Id<'imports'> }, Interest>('interests:current'), {
        importId,
      })
      .then(
        value => {
          if (active) {
            setResult({ version, value });
            setError(undefined);
          }
        },
        reason => {
          if (active) setError(reason);
        },
      );
    return () => {
      active = false;
    };
  }, [client, importId, version]);
  if (error) throw error;
  return result && result.version === version ? result.value : undefined;
}
