// SPDX-License-Identifier: Apache-2.0
import { findObjects } from './projectObjectFind';
import { journalSourceRow } from './projectJournalCanonical';
import { journalRecoveryPage } from './projectJournalRecovery';
import { JournalNeeded, journalReadReply } from './projectJournalStore';
import { v } from 'convex/values';
import { query, type QueryCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
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
import {
  capsuleOwnsRecoveryRow,
  recoveryCapsuleCursor,
  readRecoveryCapsuleCursor,
  recoveryCapsulePage,
} from './projectLandingCapsuleRecovery';

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
    case 'projectCoordinationEvents':
      return ctx.db
        .query('projectCoordinationEvents')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedSnapshots':
      return ctx.db
        .query('projectHostedSnapshots')
        .withIndex('by_project_and_snapshot', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedSnapshotHeads':
      return ctx.db
        .query('projectHostedSnapshotHeads')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedSnapshotPages':
      return ctx.db
        .query('projectHostedSnapshotPages')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedDisplayRecords':
      return ctx.db
        .query('projectHostedDisplayRecords')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectSourceCutovers':
      return ctx.db
        .query('projectSourceCutovers')
        .withIndex('by_project_and_operation', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedRecordBodies':
      return ctx.db
        .query('projectHostedRecordBodies')
        .withIndex('by_project_and_revision', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedRecords':
      return ctx.db
        .query('projectHostedRecords')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .paginate(options);
    case 'projectHostedRecordHeads':
      return ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind', q => q.eq('projectId', projectId))
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
    capsuleProtocol: v.optional(v.literal(1)),
    physicalProtocol: v.optional(v.literal(1)),
    table: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: journalRecoveryRead,
});

export async function journalRecoveryRead(
  ctx: QueryCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    selection: string;
    capsuleProtocol?: 1;
    physicalProtocol?: 1;
    table: string;
    cursor: string | null;
  },
) {
  try {
    const project = await recoveryOwned(ctx, input.projectId);
    const expected = recoverySelectionSchema.parse(JSON.parse(input.selection));
    invariant(
      expected.projectId === input.projectId &&
        sameRecoveryPins(await recoverySelection(ctx, project), expected),
      'WORK_STALE',
      'Hosted recovery pins changed; retain the original staging and request.',
    );
    invariant(
      (!expected.capsuleRevision && !expected.journalRevision) || input.capsuleProtocol === 1,
      'CLI_UPGRADE_REQUIRED',
      'This recovery includes landing capsules. Run nforge update and retry.',
    );
    const table = recoveryTableSchema.parse(input.table);
    const selected = readRecoveryCapsuleCursor(table, input.cursor);
    if (selected.phase === 'journal') return journalRecoveryPage(ctx, project, table, selected);
    if (selected.phase === 'capsules')
      return recoveryCapsulePage(ctx, project, table, selected, input.capsuleProtocol);
    const result = await readPage(ctx, input.projectId, table, selected.cursor);
    const rows = [];
    for (const row of result.page)
      if (
        !(
          (table === 'projectHostedOperations' ||
            table === 'projectHostedRecordBodies' ||
            table === 'projectHostedRecords') &&
          'journalSegment' in row
        ) &&
        ((!expected.capsuleRevision && !expected.journalRevision) ||
          !(await capsuleOwnsRecoveryRow(ctx, input.projectId, table, row)))
      )
        rows.push(canonicalPayload(journalSourceRow(row)));
    const physicalRoots = [];
    if (input.physicalProtocol === 1 && table === 'projectHostedStates') {
      const states = result.page.filter((row): row is Doc<'projectHostedStates'> => 'head' in row);
      const objects = await findObjects(
        ctx,
        input.projectId,
        states.map(row => row.head),
      );
      for (const [index, object] of objects.entries())
        if (object?.statePhysical)
          physicalRoots.push({
            state: { sha256: states[index]!.head, size: states[index]!.size },
            root: object.statePhysical,
          });
    }
    return canonicalPayload({
      ...(input.physicalProtocol === 1 ? { physicalRoots } : {}),
      table,
      rows,
      cursor: !result.isDone
        ? result.continueCursor
        : expected.capsuleRevision || expected.journalRevision
          ? recoveryCapsuleCursor({ table, phase: 'capsules', cursor: null })
          : null,
      done: result.isDone && !expected.capsuleRevision && !expected.journalRevision,
    });
  } catch (error) {
    if (error instanceof JournalNeeded) return journalReadReply(ctx, error, input.projectId);
    return report(error);
  }
}
