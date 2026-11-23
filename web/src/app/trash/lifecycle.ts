// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The three lifecycle calls of a project the person owns (convex/projectLifecycle.ts), each one retry-safe mutation: the
// operation id is kept per action, project and revision until the call succeeds, so a retry after an unknown outcome
// reconciles on the server instead of repeating. No reads here.
import { useCallback, useRef } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

export type Lifecycle = 'trash' | 'restore' | 'delete';
/** `afterRestore` makes a trash the Undo of a restore: its receipt's restore id (the revision is the receipt's). */
export type Target = { id: Id<'hostedProjects'>; revision: number; afterRestore?: string };
/** What a restore answered: the receipt Undo presents (and the new address when the old one was taken), or null when
 * it changed nothing because the project was already restored. */
export type Receipt = { restoreId: string; revision: number; slug?: string; previousSlug?: string } | null;
export type RunLifecycle = (kind: Lifecycle, target: Target, confirm?: string) => Promise<Receipt>;

export function useLifecycle(): RunLifecycle {
  const client = useConvex();
  const pending = useRef(new Map<string, string>());
  return useCallback(
    async (kind, target, confirm) => {
      const key = `${kind}:${target.id}:${target.revision}:${target.afterRestore ?? ''}`;
      const operationId = pending.current.get(key) ?? crypto.randomUUID();
      pending.current.set(key, operationId);
      const input = { projectId: target.id, operationId, expectedRevision: target.revision };
      let receipt: Receipt = null;
      if (kind === 'trash')
        await client.mutation(api.projectLifecycle.trash, {
          ...input,
          ...(target.afterRestore === undefined ? {} : { afterRestore: target.afterRestore }),
        });
      else if (kind === 'restore') receipt = await client.mutation(api.projectLifecycle.restore, input);
      else
        await client.mutation(api.projectLifecycle.permanentlyDelete, {
          ...input,
          ...(confirm === undefined ? {} : { confirm: confirm.trim() }),
        });
      pending.current.delete(key);
      return receipt;
    },
    [client],
  );
}
