// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { publicPlanVisible, type PlanRow } from './publicVisibility';
import { maxIntentChain, successorIntentId } from '../src/hosted-intent-chain';
import { getDocumentSize } from 'convex/values';
export type PublicPlanRoot = PlanRow & Record<string, unknown>;
type LookupBudget = { take: () => boolean; refund: (size: number) => void };
const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** Reuse current roots a page already read. History and comment pages resolve only their selected
 * Items and referenced parents: O(page) indexed document reads inside the existing query, no board scan,
 * additional function call, fixed root window, body hydration or capability limit. */
export function publicWorkPlan(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  loaded: Map<string, PublicPlanRoot>,
) {
  const known = new Map<string, PublicPlanRoot | null>(loaded);
  const pending = new Map<string, Promise<PublicPlanRoot | null>>();
  let generation: ReturnType<typeof selectedGeneration> | undefined;
  const lookup = async (id: unknown, budget?: LookupBudget): Promise<PublicPlanRoot | null> => {
    if (typeof id !== 'string' || !id) return null;
    if (known.has(id)) return known.get(id)!;
    let read = pending.get(id);
    if (!read) {
      if (budget && !budget.take()) return null;
      read = (async () => {
        const selected = await (generation ??= selectedGeneration(ctx, project));
        const row = selected ? await record(ctx, recordPartition(selected), 'planningSearch', id) : null;
        if (budget) budget.refund(row ? getDocumentSize(row) : 0);
        const root = row ? (JSON.parse(row.value) as PublicPlanRoot) : null;
        known.set(id, root);
        return root;
      })();
      pending.set(id, read);
    }
    return read;
  };
  type Row = Pick<PublicPlanRoot, 'hidden' | 'initiativeId' | 'parentId'> & { status?: string | undefined };
  /** The one rule for a row this read holds, its Initiative and parent looked up (cached). */
  const rowAllowed = async (item: Row | null, related = lookup) => {
    if (project.visibility !== 'public' || project.planVisibility === 'members') return false;
    if (!item) return false;
    const [initiative, parent] = await Promise.all([related(item.initiativeId), related(item.parentId)]);
    const parentInitiative = await related(parent?.initiativeId);
    return publicPlanVisible({
      projectVisibility: 'public',
      item,
      ...(project.planVisibility ? { planVisibility: project.planVisibility } : {}),
      initiative: initiative ?? undefined,
      parent: parent ?? undefined,
      parentInitiative: parentInitiative ?? undefined,
    });
  };
  const allowed = async (id: unknown) => {
    if (project.visibility !== 'public' || project.planVisibility === 'members') return false;
    return rowAllowed(await lookup(id));
  };
  let chains: Map<string, string> | undefined;
  /** The Item an Intent belongs to, when the read can tie it: the Intent is that Item (one cached indexed lookup), or a
   * follow-up Intent of an Item this read already loaded (follow-up ids are hashes of the Item id: computed, never
   * read). Null when the read cannot tie it to an Item. */
  const itemOf = async (intentId: string): Promise<string | null> => {
    if (await lookup(intentId)) return intentId;
    if (!chains) {
      chains = new Map();
      for (const [id, root] of [...known])
        if (root && root.kind !== 'initiative')
          for (let next = id, hop = 0; hop < maxIntentChain; hop++)
            chains.set((next = successorIntentId(next)), id);
    }
    return chains.get(intentId) ?? null;
  };
  /** Whether a Lane's title must stay hidden from a viewer without a role (C1R-03). Visible only when the read ties
   * the Lane's Intent to a visible Item. An Intent the read cannot tie to an Item stays hidden, like an unlooked-up
   * Initiative; a members-only plan hides every title. */
  const intentHidden = async (intentId: unknown): Promise<boolean> => {
    if (project.planVisibility === 'members') return true;
    if (typeof intentId !== 'string' || !intentId) return true;
    const item = await itemOf(intentId);
    return item ? !(await allowed(item)) : true;
  };
  /** Whether work selected by an Item or Intent id (its Lanes, landings, totals) belongs to plan work a viewer without a
   * role may not see: a hidden Item, a follow-up Intent of one, or any Item of a members-only plan. Unlike plan text,
   * an id tied to no Item is not hidden here: its Lanes carry no plan data, and their titles follow intentHidden. */
  const workHidden = async (id: unknown): Promise<boolean> => {
    if (typeof id !== 'string' || !id) return false;
    const item = await itemOf(id);
    return item ? !(await allowed(item)) : false;
  };
  /** Whether a role-less viewer's selection by Item or Intent id may run as asked: the read ties the id to an Item it
   * may see. Any other id (a hidden Item, any Item of a members-only plan, an Intent the read cannot tie) answers as an
   * absent one (publicWorkSelection). */
  const selectionVisible = async (id: string): Promise<boolean> => {
    const item = await itemOf(id);
    return item ? allowed(item) : false;
  };
  return {
    allowed,
    rowAllowed,
    intentHidden,
    workHidden,
    selectionVisible,
    async *visibleLoaded(keep: (row: PublicPlanRoot) => boolean) {
      // Only history counts may omit an unproved row. Reuse resolved relations and leave space for
      // the generation lookup and response projection. Concurrent lookups reserve a full document first.
      const metrics = await ctx.meta?.getTransactionMetrics?.();
      let bytes = (metrics?.bytesRead.remaining ?? Infinity) - 2 * MAX_DOCUMENT_BYTES;
      let documents = (metrics?.documentsRead.remaining ?? Infinity) - 2;
      let queries = (metrics?.databaseQueries.remaining ?? Infinity) - 2;
      const budget = {
        take() {
          if (bytes < MAX_DOCUMENT_BYTES || documents <= 0 || queries <= 0) return false;
          bytes -= MAX_DOCUMENT_BYTES;
          documents--;
          queries--;
          return true;
        },
        refund(size: number) {
          bytes += MAX_DOCUMENT_BYTES - size;
        },
      };
      for (const row of loaded.values())
        if (keep(row) && !row.hidden && (await rowAllowed(row, id => lookup(id, budget)))) yield row;
    },
  };
}
