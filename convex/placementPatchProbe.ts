// SPDX-License-Identifier: Apache-2.0
// Temporary dev-only S0 experiment, Issue 886a4694. No scheduler or product caller.
import { v } from 'convex/values';
import { internalMutation } from './server';

const indexes = v.union(v.literal(1), v.literal(9), v.literal(24));
const size = v.union(v.literal(1024), v.literal(8192), v.literal(27648));
const tableFor = (count: 1 | 9 | 24) => `placementPatchProbe${count}` as const;
function devOnly() {
  if (process.env.CONVEX_CLOUD_URL !== 'https://benevolent-wildebeest-974.convex.cloud')
    throw new Error('Synthetic patch measurement is available only on the project dev deployment');
}
export const setup = internalMutation({
  args: { operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    devOnly();
    for (const count of [1, 9, 24] as const) {
      const table = tableFor(count);
      for (const bytes of [1024, 8192, 27648]) {
        const key = `${args.operationId}:${bytes}`;
        const old = await ctx.db
          .query(table)
          .withIndex('by_key_01', q => q.eq('key', key))
          .unique();
        if (!old) {
          const row = {
            key,
            step: 0,
            payload: '',
            k01: 0,
            k02: 0,
            k03: 0,
            k04: 0,
            k05: 0,
            k06: 0,
            k07: 0,
            k08: 0,
            k09: 0,
            k10: 0,
            k11: 0,
            k12: 0,
            k13: 0,
            k14: 0,
            k15: 0,
            k16: 0,
            k17: 0,
            k18: 0,
            k19: 0,
            k20: 0,
            k21: 0,
            k22: 0,
            k23: 0,
            k24: 0,
          };
          row.payload = 'x'.repeat(bytes - JSON.stringify(row).length);
          await ctx.db.insert(table, row);
        }
      }
    }
    return null;
  },
});
export const patch = internalMutation({
  args: { operationId: v.string(), indexes, bytes: size, step: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    devOnly();
    const row = await ctx.db
      .query(tableFor(args.indexes))
      .withIndex('by_key_01', q => q.eq('key', `${args.operationId}:${args.bytes}`))
      .unique();
    if (!row || !Number.isInteger(args.step) || args.step < 1 || args.step > 10)
      throw new Error('Missing synthetic cell or invalid patch step');
    if (row.step === args.step) return null;
    if (row.step !== args.step - 1) throw new Error('Synthetic patches must run in sequence');
    await ctx.db.patch(row._id, { step: args.step });
    return null;
  },
});
export const cleanup = internalMutation({
  args: { operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    devOnly();
    for (const count of [1, 9, 24] as const)
      for (const bytes of [1024, 8192, 27648]) {
        const row = await ctx.db
          .query(tableFor(count))
          .withIndex('by_key_01', q => q.eq('key', `${args.operationId}:${bytes}`))
          .unique();
        if (row) await ctx.db.delete(row._id);
      }
    return null;
  },
});
