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
      const parts: { key: string; value: string }[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await ctx.db
          .query('projectWorkRecords')
          .withIndex('by_generation_and_collection_and_parent_and_position', q =>
            q.eq('generationId', partition).eq('collection', row.collection).eq('parent', row.parent),
          )
          .paginate({ cursor, numItems: 100 });
        parts.push(...page.page);
        if (page.isDone) break;
        cursor = page.continueCursor;
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
