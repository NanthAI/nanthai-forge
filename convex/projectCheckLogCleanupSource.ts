// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Identity } from './projectCheckLogCleanupTypes';
/** Durable exact-hash union. A leaf holds at most 512 hashes; overflowing leaves
 * split by the next digest nibble, so neither skew nor tree size grows a document.
 * The caller's transaction checks current owner authority and the original guard. */
export async function protectSourceUnion(ctx: MutationCtx, input: Identity, digests: string[]) {
  const groups = (values: string[], length: number) => {
    const result = new Map<string, string[]>();
    for (const pin of values) {
      const prefix = pin.slice(0, length);
      const group = result.get(prefix) ?? [];
      if (!result.has(prefix)) result.set(prefix, group);
      group.push(pin);
    }
    return result;
  };
  async function merge(prefix: string, incoming: string[]) {
    const part = `sourceUnion:${prefix}`;
    const prior = await ctx.db
      .query('projectCheckLogCleanupPages')
      .withIndex('by_project_and_operation_and_part_and_position', q =>
        q
          .eq('projectId', input.projectId)
          .eq('operationId', input.operationId)
          .eq('part', part)
          .eq('position', 0),
      )
      .unique();
    const before: { pins: string[]; split?: boolean } = prior ? JSON.parse(prior.value) : { pins: [] };
    if (before.split) {
      for (const [child, pins] of groups(incoming, prefix.length + 1)) await merge(child, pins);
      return;
    }
    const pins = [...new Set([...before.pins, ...incoming])];
    if (pins.length === before.pins.length) return;
    const split = pins.length > 512;
    const value = JSON.stringify(split ? { pins: [], split: true } : { pins });
    if (prior) await ctx.db.patch(prior._id, { value });
    else
      await ctx.db.insert('projectCheckLogCleanupPages', {
        projectId: input.projectId,
        operationId: input.operationId,
        part,
        position: 0,
        value,
      });
    if (split) for (const [child, values] of groups(pins, prefix.length + 1)) await merge(child, values);
  }
  for (const [prefix, pins] of groups(digests, 2)) await merge(prefix, pins);
}
