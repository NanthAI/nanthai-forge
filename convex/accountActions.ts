'use node';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference, paginationOptsValidator } from 'convex/server';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { resourceKind, accountSelection, leaveKind } from './accountTypes';
import { metadataBytes } from './accountMetadata';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { report } from './errors';

type Selection = {
  kind: 'project' | 'import' | 'secret' | 'agent' | 'team' | 'view' | 'interest';
  id: string;
  pin: string;
};
type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type Receipt = {
  operationId: string;
  request: string;
  stage: 'preparing' | 'ready' | 'running' | 'completed';
  at: number;
};
type Metadata = Record<string, unknown> & { id: string };
type Inventory = Page<{ kind: Selection['kind']; id: string; pin: string; metadata: Metadata }>;
type Leave = 'readers' | 'zones' | 'teams' | 'projects' | 'secrets';
const receipt = (r: Doc<'accountOperations'>) => ({
  operationId: r.operationId,
  request: r.request,
  stage: r.stage,
  at: r.at,
});
function child(operationId: string, key: string) {
  const d = digest(operationId + '\n' + key);
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-8${d.slice(17, 20)}-${d.slice(20, 32)}`;
}
async function allItems(ctx: ActionCtx, operationId: string) {
  const items: Doc<'accountItems'>[] = [];
  let cursor: string | null = null;
  for (;;) {
    const p: Page<Doc<'accountItems'>> = await ctx.runQuery(internal.accountPlan.items, {
      operationId,
      paginationOpts: { numItems: 50, cursor },
    });
    items.push(...p.page);
    if (p.isDone) return items;
    cursor = p.continueCursor;
  }
}
export const inventory = action({
  args: { kind: resourceKind, paginationOpts: paginationOptsValidator },
  returns: v.any(),
  handler: async (ctx, input): Promise<Inventory> => {
    try {
      const p: Page<Metadata> = await ctx.runQuery(internal.accountResources.page, input);
      const visible = await ctx.runAction(
        makeFunctionReference<'action', { rows: Metadata[] }, Metadata[]>('inventoryAccess:read'),
        { rows: p.page },
      );
      return {
        ...p,
        page: p.page.map((metadata: Metadata, index: number) => ({
          kind: input.kind,
          id: metadata.id,
          pin: digest(metadataBytes(metadata)),
          metadata: visible[index]!,
        })),
      };
    } catch (e) {
      return report(e);
    }
  },
});
// No source/credential bytes: each current ownership family is independently paged and pinned.
export const begin = action({
  args: { operationId: v.string(), selection: v.array(accountSelection), leave: v.array(leaveKind) },
  returns: v.any(),
  handler: async (ctx, input): Promise<Receipt> => {
    try {
      invariant(
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.operationId),
        'BAD_ARGUMENT',
        'Retain the original operation UUID.',
      );
      const selection: Selection[] = [...input.selection].sort((a, b) =>
          (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id),
        ),
        leave: Leave[] = [...new Set(input.leave)].sort();
      invariant(
        new Set(selection.map(x => x.kind + ':' + x.id)).size === selection.length &&
          selection.every(x => /^[a-f0-9]{64}$/.test(x.pin)),
        'BAD_ARGUMENT',
        'Select each original metadata pin once.',
      );
      const request = digest(metadataBytes({ selection, leave }));
      const original: Doc<'accountOperations'> | null = await ctx.runQuery(internal.accountPlan.original, {
        operationId: input.operationId,
      });
      if (original) {
        invariant(
          original.request === request,
          'ACCOUNT_OPERATION_CHANGED',
          'Reconcile the original selected operation.',
        );
        if (original.stage !== 'preparing') return receipt(original);
      }
      const account: Doc<'accountOperations'> | null = await ctx.runMutation(internal.accountPlan.register, {
        operationId: input.operationId,
        request,
        expectedItems: selection.length,
        leave,
      });
      invariant(account, 'ACCOUNT_UNAVAILABLE', 'The original operation is unavailable.');
      const existing = new Set((await allItems(ctx, input.operationId)).map(x => x.key));
      for (const item of selection) {
        const key = item.kind + ':' + item.id;
        if (existing.has(key)) continue;
        const current = await ctx.runQuery(internal.accountResources.current, {
            kind: item.kind,
            id: item.id,
          }),
          observed = metadataBytes(current);
        invariant(
          current && digest(observed) === item.pin,
          'ACCOUNT_CHANGED',
          'Selected metadata changed. The original resources are preserved.',
        );
        await ctx.runMutation(internal.accountPlan.append, {
          operationId: input.operationId,
          items: [
            {
              key,
              kind: item.kind,
              resourceId: item.id,
              pin: item.pin,
              observed,
              operationId: child(input.operationId, key),
              hidden: false,
            },
          ],
        });
      }
      for (const kind of leave) {
        if (account.captured.includes(kind)) continue;
        let cursor: string | null = null;
        for (;;) {
          const p: Page<{ _id: string }> = await ctx.runQuery(internal.accountResources.incoming, {
            kind,
            through: account._creationTime,
            paginationOpts: { cursor, numItems: 40 },
          });
          await ctx.runMutation(internal.accountPlan.append, {
            operationId: input.operationId,
            items: p.page.map((r: { _id: string }) => {
              const observed = metadataBytes(r),
                key = kind + ':' + r._id;
              return {
                key,
                kind,
                resourceId: r._id,
                pin: digest(observed),
                observed,
                operationId: child(input.operationId, key),
                hidden: true,
              };
            }),
          });
          if (p.isDone) break;
          cursor = p.continueCursor;
        }
        await ctx.runMutation(internal.accountPlan.captured, { operationId: input.operationId, kind });
      }
      const saved = await allItems(ctx, input.operationId),
        restored = saved
          .filter(x => !x.hidden)
          .map(x => ({ kind: x.kind, id: x.resourceId, pin: x.pin }))
          .sort((a, b) => (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id));
      return await ctx.runMutation(internal.accountPlan.seal, {
        operationId: input.operationId,
        verifiedRequest: digest(metadataBytes({ selection: restored, leave })),
        verifiedItems: restored.length,
      });
    } catch (e) {
      return report(e);
    }
  },
});
export const advance = action({
  args: { operationId: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.any(),
  handler: async (
    ctx,
    { operationId, cursor },
  ): Promise<Receipt & { cursor: string | null; isDone: boolean }> => {
    try {
      const page: Page<Doc<'accountItems'>> = await ctx.runQuery(internal.accountPlan.items, {
        operationId,
        paginationOpts: { cursor, numItems: 40 },
      });
      for (const item of page.page as Doc<'accountItems'>[]) {
        if (item.state === 'completed' || item.state === 'changed') continue;
        const current = item.hidden
          ? await ctx.runQuery(internal.accountResources.relation, {
              kind: item.kind as Leave,
              id: item.resourceId,
            })
          : await ctx.runQuery(internal.accountResources.current, {
              kind: item.kind as Selection['kind'],
              id: item.resourceId,
            });
        const observed = metadataBytes(current);
        await ctx.runMutation(internal.accountExecute.step, {
          operationId,
          itemId: item._id,
          observed: digest(observed) === item.pin ? observed : 'changed',
        });
      }
      const result: Receipt = await ctx.runMutation(internal.accountPlan.complete, { operationId });
      return { ...result, cursor: page.isDone ? null : page.continueCursor, isDone: page.isDone };
    } catch (e) {
      return report(e);
    }
  },
});
