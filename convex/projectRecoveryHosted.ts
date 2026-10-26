// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { recoveryOwned, recoverySelection } from './projectRecovery';
import { recoverySelectionSchema, sameRecoveryPins } from '../src/recovery-protocol';
import {
  recoveryTableSchema,
  RECOVERY_PAGE_ROWS,
  RECOVERY_PAGE_BYTES,
  type RecoveryTable,
} from '../src/recovery-hosted-protocol';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

// Explicit indexed branches keep table/index pairings checked by the generated model.
async function readPage(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  table: RecoveryTable,
  cursor: string | null,
) {
  const options = {
    cursor,
    numItems: RECOVERY_PAGE_ROWS,
    maximumRowsRead: RECOVERY_PAGE_ROWS,
    maximumBytesRead: RECOVERY_PAGE_BYTES,
  };
  switch (table) {
    case 'projectSourceCutovers':
      return ctx.db
        .query('projectSourceCutovers')
        .withIndex('by_project_and_operation', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedRecordBodies':
      return ctx.db
        .query('projectHostedRecordBodies')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedRecords':
      return ctx.db
        .query('projectHostedRecords')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedRecordHeads':
      return ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedOperations':
      return ctx.db
        .query('projectHostedOperations')
        .withIndex('by_project_and_actor_and_operation', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedStates':
      return ctx.db
        .query('projectHostedStates')
        .withIndex('by_project_and_head', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedSaves':
      return ctx.db
        .query('projectHostedSaves')
        .withIndex('by_project_and_actor_and_operation', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedSavePages':
      return ctx.db
        .query('projectHostedSavePages')
        .withIndex('by_project_and_actor_and_operation_and_index', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedComposes':
      return ctx.db
        .query('projectHostedComposes')
        .withIndex('by_project_and_actor_and_operation', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedComposePages':
      return ctx.db
        .query('projectHostedComposePages')
        .withIndex('by_project_and_actor_and_operation_and_kind_and_index', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedComposeSelections':
      return ctx.db
        .query('projectHostedComposeSelections')
        .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedSyncs':
      return ctx.db
        .query('projectHostedSyncs')
        .withIndex('by_project_and_actor_and_operation', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedFinishes':
      return ctx.db
        .query('projectHostedFinishes')
        .withIndex('by_project_and_submission', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedLandingQueues':
      return ctx.db
        .query('projectHostedLandingQueues')
        .withIndex('by_project_and_channel', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedLandingRequests':
      return ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_channel_and_sequence', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedLandingAttempts':
      return ctx.db
        .query('projectHostedLandingAttempts')
        .withIndex('by_project_and_submission_and_number', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedLandingObservations':
      return ctx.db
        .query('projectHostedLandingObservations')
        .withIndex('by_project_and_submission_and_version', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedAcceptances':
      return ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedAcceptanceSnapshots':
      return ctx.db
        .query('projectHostedAcceptanceSnapshots')
        .withIndex('by_project_and_snapshot', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedAcceptanceEvents':
      return ctx.db
        .query('projectHostedAcceptanceEvents')
        .withIndex('by_project_and_sequence', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedAcceptancePlans':
      return ctx.db
        .query('projectHostedAcceptancePlans')
        .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedAcceptancePages':
      return ctx.db
        .query('projectHostedAcceptancePages')
        .withIndex('by_project_and_receipt_and_kind_and_index', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedLifecyclePlans':
      return ctx.db
        .query('projectHostedLifecyclePlans')
        .withIndex('by_project_and_actor_and_operation', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedLifecycleGuards':
      return ctx.db
        .query('projectHostedLifecycleGuards')
        .withIndex('by_project_and_intent', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedLifecyclePointers':
      return ctx.db
        .query('projectHostedLifecyclePointers')
        .withIndex('by_project_and_lane', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedLifecycleEvents':
      return ctx.db
        .query('projectHostedLifecycleEvents')
        .withIndex('by_project_and_kind_and_key', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedCheckRuns':
      return ctx.db
        .query('projectHostedCheckRuns')
        .withIndex('by_project_and_run', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedCheckCallbacks':
      return ctx.db
        .query('projectHostedCheckCallbacks')
        .withIndex('by_project_and_run_and_event', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedCheckShards':
      return ctx.db
        .query('projectHostedCheckShards')
        .withIndex('by_project_and_run_and_index', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectReturnSupersessions':
      return ctx.db
        .query('projectReturnSupersessions')
        .withIndex('by_project_and_operation', q => q.eq('projectId', projectId))
        .paginate(options);
  }
}
/** Read-only recovery export. Rechecks current owner authority and exact source/
 * journal/Channel pins on every page, including resumed and verification reads. */
export const page = query({
  args: {
    projectId: v.id('hostedProjects'),
    selection: v.string(),
    table: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const project = await recoveryOwned(ctx, input.projectId);
      const expected = recoverySelectionSchema.parse(JSON.parse(input.selection));
      invariant(
        expected.projectId === input.projectId &&
          sameRecoveryPins(await recoverySelection(ctx, project), expected),
        'WORK_STALE',
        'Hosted recovery pins changed; retain the original staging and request.',
      );
      const table = recoveryTableSchema.parse(input.table);
      const result = await readPage(ctx, input.projectId, table, input.cursor);
      return canonicalPayload({
        table,
        rows: result.page.map(row => canonicalPayload(row)),
        cursor: result.isDone ? null : result.continueCursor,
        done: result.isDone,
      });
    } catch (error) {
      return report(error);
    }
  },
});
