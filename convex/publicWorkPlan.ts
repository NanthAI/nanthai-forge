// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { publicPlanVisible, type PlanRow } from './publicVisibility';
export type PublicPlanRoot = PlanRow & Record<string, unknown>;
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
  const lookup = async (id: unknown): Promise<PublicPlanRoot | null> => {
    if (typeof id !== 'string' || !id) return null;
    if (known.has(id)) return known.get(id)!;
    let read = pending.get(id);
    if (!read) {
      read = (async () => {
        const selected = await (generation ??= selectedGeneration(ctx, project));
        const row = selected ? await record(ctx, recordPartition(selected), 'planningSearch', id) : null;
        const root = row ? (JSON.parse(row.value) as PublicPlanRoot) : null;
        known.set(id, root);
        return root;
      })();
      pending.set(id, read);
    }
    return read;
  };
  const allowed = async (id: unknown) => {
    if (project.visibility !== 'public' || project.planVisibility === 'members') return false;
    const item = await lookup(id);
    if (!item) return false;
    const [initiative, parent] = await Promise.all([lookup(item.initiativeId), lookup(item.parentId)]);
    const parentInitiative = await lookup(parent?.initiativeId);
    return publicPlanVisible({
      projectVisibility: 'public',
      item,
      ...(project.planVisibility ? { planVisibility: project.planVisibility } : {}),
      initiative: initiative ?? undefined,
      parent: parent ?? undefined,
      parentInitiative: parentInitiative ?? undefined,
    });
  };
  return {
    allowed,
    async visibleLoaded() {
      const out = new Map<string, PublicPlanRoot>();
      for (const [id, row] of loaded) if (await allowed(id)) out.set(id, row);
      return out;
    },
  };
}
