// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { Pending, JournalRow } from './projectJournalMaintenance';
import { receiptRow, sourceText } from './projectJournalMaintenance';
import { canonicalPayload, HOSTED_OPERATION_RETENTION_MS } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
import { canonical } from './coordinationWrite';
export async function applyJournal(ctx: MutationCtx, pending: Pending, rows: JournalRow[], keys: string[]) {
  const pointerFor = (n: number) => keys[pending.groups.findIndex(group => group.refs.includes(n))]!;
  for (const [n, ref] of pending.refs.entries()) {
    const row = rows[n]!;
    if (ref.table === 'projectHostedRecords') {
      const record = row as Doc<'projectHostedRecords'>;
      // Re-check shared ownership in the publishing transaction. A newly shared body
      // invalidates the captured deletion plan; the verified object remains append-only.
      if (pending.refs.some(item => item.id === record.bodyId)) {
        const owners = await ctx.db
          .query('projectHostedRecords')
          .withIndex('by_project_and_body', q =>
            q.eq('projectId', record.projectId).eq('bodyId', record.bodyId),
          )
          .take(2);
        invariant(
          owners.length === 1 && owners[0]!._id === record._id,
          'WORK_STALE',
          'Body ownership changed before archive publication.',
        );
      }
      const body = rows.find(item => item._id === record.bodyId) as
        | Doc<'projectHostedRecordBodies'>
        | undefined;
      // Provenance bodies remain separately readable; full Work bytes are inline.
      const value =
        record.inline ??
        body?.value ??
        (record.kind === 'lane' ? (await ctx.db.get(record.bodyId))?.value : undefined);
      invariant(record.kind !== 'lane' || value, 'SOURCE_UNAVAILABLE', 'Original Lane pins are unavailable.');
      const lane = record.kind === 'lane' ? JSON.parse(value!) : null;
      await ctx.db.patch(record._id, {
        inline: undefined,
        journalReadyAt: undefined,
        journalReady: undefined,
        journalSegment: pointerFor(n),
        ...(lane
          ? {
              journalLane: {
                head: lane.head,
                sourceVersion: lane.sourceVersion ?? lane.version,
                lifecycleVersion: lane.lifecycleVersion ?? 0,
                revert: !!lane.revert,
              },
            }
          : {}),
      });
    } else if (ref.table === 'projectHostedRecordBodies') {
      const body = row as Doc<'projectHostedRecordBodies'>;
      if (body.operationId) {
        const command = JSON.parse(body.command!),
          facts = {
            action: command.action,
            ...(command.base ? { base: command.base } : {}),
            ...(command.intentIds ? { intentIds: command.intentIds } : {}),
          };
        await ctx.db.patch(body._id, {
          command: undefined,
          journalSegment: '1',
          journalCommand: canonicalPayload(facts),
        });
      } else await ctx.db.delete(body._id);
    } else if (ref.table === 'projectHostedOperations') {
      const operation = row as Doc<'projectHostedOperations'>;
      const original = await sourceText(operation, 'projectHostedOperations'),
        hash = digest(original);
      if (operation._creationTime < Date.now() - HOSTED_OPERATION_RETENTION_MS) {
        const operationId = `journal-operation:${operation._id}`,
          old = await receiptRow(ctx, operation.projectId, operationId);
        const fields = { projectId: operation.projectId, operationId, hash, envelope: '' };
        if (old) await ctx.db.replace(old._id, fields);
        else await ctx.db.insert('projectJournalReceipts', fields);
        await ctx.db.delete(operation._id);
      } else {
        const { compactOperationReceipt } = await import('../src/compact-operation-receipt');
        await ctx.db.patch(operation._id, {
          value: compactOperationReceipt(JSON.parse(JSON.parse(original).value)),
          journalSegment: '1',
          journalDigest: hash,
          journalReadyAt: undefined,
          journalReady: undefined,
        });
      }
    } else if (ref.table === 'projectCoordinationEvents') {
      const event = row as Doc<'projectCoordinationEvents'>;
      const { command, ...envelope } = event;
      const old = await receiptRow(ctx, event.projectId, event.operationId);
      const fields = {
        projectId: event.projectId,
        operationId: event.operationId,
        hash: digest(canonical(command)),
        envelope: canonicalPayload(envelope),
      };
      invariant(!old || old.hash === fields.hash, 'WORK_OPERATION_CHANGED', 'Coordination receipt differs.');
      if (!old) await ctx.db.insert('projectJournalReceipts', fields);
      await ctx.db.delete(event._id);
    } else await ctx.db.delete(row._id);
  }
}
