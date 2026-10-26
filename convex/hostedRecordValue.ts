// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { hostedText } from '../src/hosted-paths';

type Payloads = Map<string, Promise<Map<string, string>>>;
/** Sanitize assembled legacy payloads, then retain their original part identities. */
export async function hostedRecordValue(
  ctx: QueryCtx,
  partition: Id<'projectWorkGenerations'>,
  row: { collection: string; parent: string; key: string; value: string },
  memo: Payloads = new Map(),
) {
  if (!row.collection.endsWith(':payload')) return row.value;
  const identity = JSON.stringify([row.collection, row.parent]);
  let pending = memo.get(identity);
  if (!pending) {
    pending = (async () => {
      // Bounded position-ordered batches, not paginate(): callers are paginated queries,
      // and Convex allows only one paginated query per query function.
      const parts: { key: string; value: string; position: number }[] = [];
      for (;;) {
        const last = parts.at(-1)?.position;
        const batch = await ctx.db
          .query('projectWorkRecords')
          .withIndex('by_generation_and_collection_and_parent_and_position', q => {
            const parent = q
              .eq('generationId', partition)
              .eq('collection', row.collection)
              .eq('parent', row.parent);
            return last === undefined ? parent : parent.gt('position', last);
          })
          .take(100);
        parts.push(...batch);
        if (batch.length < 100) break;
      }
      const portable = hostedText(parts.map(part => part.value).join(''));
      let offset = 0;
      return new Map(
        parts.map((part, index) => {
          const value =
            index === parts.length - 1
              ? portable.slice(offset)
              : portable.slice(offset, offset + part.value.length);
          offset += part.value.length;
          return [part.key, value];
        }),
      );
    })();
    memo.set(identity, pending);
  }
  return (await pending).get(row.key) ?? '';
}
