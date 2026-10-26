// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { readIndexedWorkDetail } from '../src/hosted-work-client';
import { action } from './cliServer';
import { exchangeObjectReader } from './projectExchangeReader';
import { hydrateRun, actionResult, workDetailPinSchema } from '../src/work-record-details';
import { checkRunSchema, type WorkData } from '../src/work-types';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Read one hash-bound detail only after selecting its current authorized record.
 * Lists and reactive summaries never fetch the object. The final selection check
 * prevents a source-generation race from returning silently substituted evidence. */
export const detail = action({
  args: {
    projectId: v.id('hostedProjects'),
    generationId: v.id('projectWorkGenerations'),
    collection: v.union(v.literal('runs'), v.literal('automaticActions')),
    id: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read your Forge project.');
      const select = () => readIndexedWorkDetail({ query: (ref, args) => ctx.runQuery(ref, args) }, input);
      const selected = await select();
      invariant(selected.value, 'WORK_STALE', 'The selected Work record changed. Read its current detail.');
      const record = selected.value;
      const reference = input.collection === 'runs' ? record.detailRef : record.resultRef;
      const pin = reference === undefined ? undefined : workDetailPinSchema.parse(reference);
      if (!pin) return JSON.stringify(record);
      const [bytes] = await exchangeObjectReader(ctx).read(input.projectId, user.subject, [pin]);
      const value =
        input.collection === 'runs'
          ? hydrateRun(checkRunSchema.parse(record), () => bytes!)
          : {
              ...record,
              result: actionResult(record as NonNullable<WorkData['automaticActions']>[number], () => bytes!),
            };
      const current = await select();
      invariant(
        current.generationId === selected.generationId &&
          current.revision === selected.revision &&
          JSON.stringify(current.value) === JSON.stringify(selected.value),
        'WORK_STALE',
        'The selected Work record changed while reading detail.',
      );
      return JSON.stringify(value);
    } catch (error) {
      return report(error);
    }
  },
});
