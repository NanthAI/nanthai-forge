// SPDX-License-Identifier: Apache-2.0
'use node';
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { journalWorkEvents } from './projectWork';
import type { JournalIndex } from '../src/journal-segment';
import { getJournalSegment } from './projectJournalObject';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
/** Existing live pages stay one query. Only an archived page enters the private GET/reauthorize path. */
export async function readJournalEvents(ctx: ActionCtx, input: Parameters<typeof journalWorkEvents>[1]) {
  const segments: string[] = [],
    seen = new Set<string>();
  let result: Awaited<ReturnType<typeof journalWorkEvents>> = await ctx.runQuery(
    makeFunctionReference<'query'>('projectWork:events'),
    input,
  );
  while ('journalHistory' in result) {
    const index = JSON.parse(result.index) as JournalIndex;
    invariant(!seen.has(index.pointer.sha256), 'WORK_STALE', 'Journal selection changed during the read.');
    seen.add(index.pointer.sha256);
    segments.push(canonicalPayload(await getJournalSegment(input.projectId, index)));
    result = JSON.parse(
      await ctx.runQuery(makeFunctionReference<'query'>('projectJournalRead:read'), {
        projectId: input.projectId,
        query: 'projectWork:events',
        request: canonicalPayload(input),
        segments,
      }),
    );
  }
  return result;
}
