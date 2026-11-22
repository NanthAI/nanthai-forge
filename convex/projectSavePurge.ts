// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { accountAction } from './cliServer';
import { projectSource } from './projectGithubMirror';
import { purgeReceipt } from './projectSavePurgeStore';
import { purgeR2Bytes } from './r2Operations';
import { r2Config } from './r2';
import { report } from './errors';
import { invariant } from '../src/errors';
import { canonicalPayload } from '../src/hosted-source-operation';
import { SAVE_PURGE_CONFIRMATION, savePurgeInputSchema, savePurgeSelection } from '../src/save-purge';

/** Owner-only, browser-only purge of the stored bytes of files one save changed, after a real
 * credential leak (Item 9d3c407d). One retry-safe action: the same operation id returns the same
 * receipt and finishes any R2 work left. Reads of the purged objects refuse PURGED from the mark on. */
export const purge = accountAction('person')({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    laneId: v.string(),
    head: v.string(),
    parent: v.string(),
    paths: v.array(v.string()),
    confirmation: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, { projectId, confirmation, ...fields }): Promise<string> => {
    try {
      invariant(
        confirmation === SAVE_PURGE_CONFIRMATION,
        'BAD_ARGUMENT',
        `Type ${SAVE_PURGE_CONFIRMATION} to confirm deleting these saved bytes for good.`,
      );
      const parsed = savePurgeInputSchema.safeParse(fields);
      invariant(
        parsed.success,
        'BAD_ARGUMENT',
        'Select one save (head and parent State), its Lane, 1 to 100 changed paths and a new operation id.',
      );
      const input = parsed.data;
      const begun: { row: Doc<'projectSavePurges'> | null; main: string; base: string } =
        await ctx.runMutation(internal.projectSavePurgeStore.begin, { projectId, ...input });
      let row = begun.row;
      if (!row) {
        const source = projectSource(ctx, digests =>
          ctx.runQuery(internal.gitServeLaneStore.resolve, { projectId, digests }),
        );
        const [head, parent, main] = await source.states([input.head, input.parent, begun.main]);
        const files = savePurgeSelection(input, { head: head!, parent: parent!, main: main! }, begun.base);
        const { operationId, laneId, head: headId, parent: parentId } = input;
        row = (await ctx.runMutation(internal.projectSavePurgeStore.mark, {
          projectId,
          operationId,
          laneId,
          head: headId,
          parent: parentId,
          main: begun.main,
          files,
        })) as Doc<'projectSavePurges'>;
      }
      if (row.state !== 'done') {
        await purgeR2Bytes(r2Config(), row);
        row = (await ctx.runMutation(internal.projectSavePurgeStore.finish, {
          projectId,
          operationId: row.operationId,
        })) as Doc<'projectSavePurges'>;
      }
      return canonicalPayload(purgeReceipt(row));
    } catch (error) {
      return report(error);
    }
  },
});
