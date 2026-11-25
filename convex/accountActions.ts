// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { v } from 'convex/values';
import { requireOwnerPerson } from './ownerPerson';
import { makeFunctionReference, paginationOptsValidator } from 'convex/server';
import { type ActionCtx, accountAction } from './cliServer';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { resourceKind, accountSelection, leaveKind } from './accountTypes';
import { metadataBytes } from './accountMetadata';
import { incomingStart } from './accountResources';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { report } from './errors';

type Selection = {
  kind: 'project' | 'import' | 'agent' | 'team' | 'view' | 'interest';
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
type Leave = 'readers' | 'zones' | 'teams' | 'projects' | 'projectReaders';
const receipt = (r: Doc<'accountOperations'>) => ({
  operationId: r.operationId,
  request: r.request,
  stage: r.stage,
  at: r.at,
  kept: r.kept ?? 0,
});
function child(operationId: string, key: string) {
  const d = digest(operationId + '\n' + key);
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-8${d.slice(17, 20)}-${d.slice(20, 32)}`;
}
/** The selected (not incoming) items of an operation as saved, a page at a time: the request is rebuilt from them before
 * sealing. Held in memory: at most the size of the request itself. */
async function savedSelection(ctx: ActionCtx, operationId: string) {
  const items: Selection[] = [];
  for (let cursor: string | null = null; ;) {
    const p: Page<Doc<'accountItems'>> = await ctx.runQuery(internal.accountPlan.items, {
      operationId,
      paginationOpts: { numItems: 100, cursor },
      visible: true,
    });
    items.push(...p.page.map(x => ({ kind: x.kind as Selection['kind'], id: x.resourceId, pin: x.pin })));
    if (p.isDone) return items.sort((a, b) => (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id));
    cursor = p.continueCursor;
  }
}
// The export (on press): every owned row with its current provider and grant checks. Person-only.
export const inventory = accountAction('person')({
  args: { kind: resourceKind, paginationOpts: paginationOptsValidator },
  returns: v.any(),
  handler: async (ctx, input): Promise<Inventory> => {
    try {
      const p: Page<Metadata> = await ctx.runQuery(internal.accountResources.page, input);
      const visible = await ctx.runAction(
        makeFunctionReference<'action', { rows: Metadata[] }, Metadata[]>('inventoryAccess:read'),
        { rows: p.page },
      );
      // Joined by id (review s1-astra62 #8): the access read leaves out rows of removed imports, so positions differ.
      const byId = new Map(visible.map(m => [m.id, m]));
      return {
        ...p,
        page: p.page.flatMap((metadata: Metadata) => {
          const shown = byId.get(metadata.id);
          return shown
            ? [{ kind: input.kind, id: metadata.id, pin: digest(metadataBytes(metadata)), metadata: shown }]
            : [];
        }),
      };
    } catch (e) {
      return report(e);
    }
  },
});
type Shared = 'projects' | 'projectReaders' | 'readers' | 'teams' | 'zones';
const SHARED: readonly Shared[] = ['projects', 'projectReaders', 'readers', 'teams', 'zones'];
/** Re-reads what others shared with the person, page by page in SHARED order, exactly as the review did
 * (accountData.shared), and returns where the chain ends. Holds one page at a time; `each` sees every page. */
async function sharedChain(
  ctx: ActionCtx,
  start: string,
  kinds: readonly Shared[],
  each?: (kind: Shared, grants: Record<string, unknown>[]) => Promise<void>,
) {
  let token = start;
  for (const kind of kinds)
    for (let cursor: string | null = null; ;) {
      const p: Page<Record<string, unknown>> & { token: string } = await ctx.runQuery(
        internal.accountResources.incoming,
        { kind, cursor, token },
      );
      token = p.token;
      if (each && p.page.length) await each(kind, p.page);
      if (p.isDone) break;
      cursor = p.continueCursor;
    }
  return token;
}
const changedShared = 'What is shared with you changed after your review. Review again; nothing was deleted.';
const APPEND_CHUNK = 50;
type Appended = {
  key: string;
  kind: string;
  resourceId: string;
  pin: string;
  observed?: string;
  operationId: string;
  hidden: boolean;
};
/** Appends in chunks of at most APPEND_CHUNK; each append takes what fits its byte cap and the rest is sent again. */
async function appendAll(ctx: ActionCtx, operationId: string, items: Appended[]) {
  for (let i = 0; i < items.length;) {
    const taken: number = await ctx.runMutation(internal.accountPlan.append, {
      operationId,
      items: items.slice(i, i + APPEND_CHUNK),
    });
    invariant(taken > 0, 'ACCOUNT_OPERATION_CHANGED', 'The original selection could not be saved.');
    i += taken;
  }
}
// No source/credential bytes. Person-only: the browser session of the account's person, never a device or agent.
export const begin = accountAction('person')({
  args: {
    operationId: v.string(),
    selection: v.array(accountSelection),
    leave: v.array(leaveKind),
    /** The token of the reviewed incoming before-list (accountData.shared); null when nothing is left. */
    incoming: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.any(),
  handler: async (ctx, input): Promise<Receipt> => {
    let request: string | null = null;
    try {
      invariant(
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.operationId),
        'BAD_ARGUMENT',
        'Retain the original operation UUID.',
      );
      const selection: Selection[] = [...input.selection].sort((a, b) =>
          (a.kind + ':' + a.id).localeCompare(b.kind + ':' + b.id),
        ),
        leave: Leave[] = [...new Set(input.leave)].sort(),
        shown = SHARED.filter(kind => leave.includes(kind)),
        incoming = leave.length ? (input.incoming ?? null) : null;
      invariant(
        new Set(selection.map(x => x.kind + ':' + x.id)).size === selection.length &&
          selection.every(x => /^[a-f0-9]{64}$/.test(x.pin)),
        'BAD_ARGUMENT',
        'Select each original metadata pin once.',
      );
      invariant(
        !leave.length || incoming !== null,
        'BAD_ARGUMENT',
        'Review what is shared with you before leaving it.',
      );
      request = digest(metadataBytes({ selection, leave, incoming }));
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
      const start = incomingStart();
      if (selection.some(item => item.kind === 'project'))
        await requireOwnerPerson(ctx, 'permanently delete projects through account cleanup');
      // The reviewed before-list, first without keeping anything: nothing is registered unless it still matches.
      if (incoming !== null)
        invariant((await sharedChain(ctx, start, shown)) === incoming, 'ACCOUNT_CHANGED', changedShared);
      const account: Doc<'accountOperations'> | null = await ctx.runMutation(internal.accountPlan.register, {
        operationId: input.operationId,
        request,
        expectedItems: selection.length,
        leave,
      });
      invariant(account, 'ACCOUNT_UNAVAILABLE', 'The original operation is unavailable.');
      // An overlapping retry of this same request sealed it first (review s1-sol62 #4): that is this begin's answer.
      if (account.stage !== 'preparing') return receipt(account);
      // Owned rows: each pin is checked inside append's own transaction, which also skips rows already appended by an
      // earlier attempt of this operation (no read per item from here).
      await appendAll(
        ctx,
        input.operationId,
        selection.map(item => {
          const key = item.kind + ':' + item.id;
          return {
            key,
            kind: item.kind,
            resourceId: item.id,
            pin: item.pin,
            operationId: child(input.operationId, key),
            hidden: false,
          };
        }),
      );
      // Incoming rows: read again page by page and appended as read (append re-checks each row's bytes in its own
      // transaction); the chain must still end at the reviewed token before anything is sealed.
      let shared = 0;
      const again =
        incoming !== null
          ? await sharedChain(ctx, start, shown, (kind, grants) => {
              shared += grants.length;
              return appendAll(
                ctx,
                input.operationId,
                grants.map(r => {
                  const observed = metadataBytes(r),
                    id = String(r._id),
                    key = kind + ':' + id;
                  return {
                    key,
                    kind,
                    resourceId: id,
                    pin: digest(observed),
                    observed,
                    operationId: child(input.operationId, key),
                    hidden: true,
                  };
                }),
              );
            })
          : null;
      invariant(again === incoming, 'ACCOUNT_CHANGED', changedShared);
      for (const kind of leave)
        await ctx.runMutation(internal.accountPlan.captured, { operationId: input.operationId, kind });
      const restored = await savedSelection(ctx, input.operationId);
      return await ctx.runMutation(internal.accountPlan.seal, {
        operationId: input.operationId,
        verifiedRequest: digest(metadataBytes({ selection: restored, leave, incoming })),
        verifiedItems: restored.length,
        // Every stored item is one this preparation verified just now, and no other (stored items never change).
        verifiedTotal: restored.length + shared,
      });
    } catch (e) {
      // A retry of this same request that sealed it while this one was still preparing answers for both; any other
      // refusal stands.
      if (request !== null) {
        const now: Doc<'accountOperations'> | null = await ctx
          .runQuery(internal.accountPlan.original, { operationId: input.operationId })
          .catch(() => null);
        if (now?.request === request && now.stage !== 'preparing') return receipt(now);
      }
      return report(e);
    }
  },
});
/** One page of the cleanup. Each item is one step mutation that checks its own pin; `waiting` lists the resources
 * whose removal is still running, for the page's reactive watch (accountData.watch) instead of a timer. */
export const advance = accountAction('person')({
  args: { operationId: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.any(),
  handler: async (
    ctx,
    { operationId, cursor },
  ): Promise<
    Receipt & {
      cursor: string | null;
      isDone: boolean;
      waiting: { kind: Selection['kind']; id: string; mark: string }[];
    }
  > => {
    try {
      const page: Page<Doc<'accountItems'>> = await ctx.runQuery(internal.accountPlan.items, {
        operationId,
        paginationOpts: { cursor, numItems: 40 },
      });
      if (
        page.page.some(
          item =>
            item.kind === 'project' && !item.hidden && item.state !== 'completed' && item.state !== 'changed',
        )
      )
        await requireOwnerPerson(ctx, 'permanently delete projects through account cleanup');
      const waiting: { kind: Selection['kind']; id: string; mark: string }[] = [];
      for (const item of page.page as Doc<'accountItems'>[]) {
        if (item.state === 'completed' || item.state === 'changed') continue;
        const r: { state: string; mark?: string } = await ctx.runMutation(internal.accountExecute.step, {
          operationId,
          itemId: item._id,
        });
        if (r.state === 'started')
          waiting.push({ kind: item.kind as Selection['kind'], id: item.resourceId, mark: r.mark ?? 'gone' });
      }
      const result: Receipt = await ctx.runMutation(internal.accountPlan.complete, { operationId });
      return { ...result, cursor: page.isDone ? null : page.continueCursor, isDone: page.isDone, waiting };
    } catch (e) {
      return report(e);
    }
  },
});
