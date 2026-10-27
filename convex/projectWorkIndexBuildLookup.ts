// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { IndexEntry } from '../src/work-hosted-index';
import { lookupsRef, type Selected } from './projectWorkIndexBuildTypes';
import { invariant } from '../src/errors';
/** A query may return a byte-bounded prefix, including null for an absent key. */
export async function buildLookups(
  ctx: ActionCtx,
  selected: Selected,
  keys: { collection: string; key: string }[],
) {
  const result: (IndexEntry | null)[] = [];
  while (result.length < keys.length) {
    const page = await ctx.runQuery(lookupsRef, {
      ...selected,
      keys: keys.slice(result.length, result.length + 100),
    });
    invariant(page.length > 0, 'WORK_STALE', 'The build lookup window made no progress.');
    result.push(...page);
  }
  return result;
}
