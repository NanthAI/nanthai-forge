// SPDX-License-Identifier: Apache-2.0
// The three lifecycle calls of a project the person owns (convex/projectLifecycle.ts), each one retry-safe mutation: the
// operation id is kept per action, project and revision until the call succeeds, so a retry after an unknown outcome
// reconciles on the server instead of repeating. No reads here.
import { useCallback, useRef } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

export type Lifecycle = 'trash' | 'restore' | 'delete';
export type Target = { id: Id<'hostedProjects'>; revision: number };
export type Moved = { slug: string; previousSlug: string } | null;
export type RunLifecycle = (kind: Lifecycle, target: Target, confirm?: string) => Promise<Moved>;

export function useLifecycle(): RunLifecycle {
  const client = useConvex();
  const pending = useRef(new Map<string, string>());
  return useCallback(
    async (kind, target, confirm) => {
      const key = `${kind}:${target.id}:${target.revision}`;
      const operationId = pending.current.get(key) ?? crypto.randomUUID();
      pending.current.set(key, operationId);
      const input = { projectId: target.id, operationId, expectedRevision: target.revision };
      let moved: Moved = null;
      if (kind === 'trash') await client.mutation(api.projectLifecycle.trash, input);
      else if (kind === 'restore') moved = await client.mutation(api.projectLifecycle.restore, input);
      else
        await client.mutation(api.projectLifecycle.permanentlyDelete, {
          ...input,
          ...(confirm === undefined ? {} : { confirm: confirm.trim() }),
        });
      pending.current.delete(key);
      return moved;
    },
    [client],
  );
}
