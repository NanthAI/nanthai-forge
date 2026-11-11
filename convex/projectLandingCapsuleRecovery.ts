// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { capsuleKind, landingCapsulePointer } from './projectLandingCapsuleStore';
import { capsuleIndexKind } from './projectLandingCapsuleIndex';
import {
  capsulePageKind,
  capsulePageKey,
  capsuleControlKey,
  capsuleControlRow,
} from './projectLandingCapsuleLedger';
import { capsuleHistoryContext } from './projectLandingCapsuleContext';
import type { RecoveryTable } from '../src/recovery-hosted-protocol';
import type { LandingCapsule } from '../src/landing-capsule';
import { RECOVERY_PAGE_ROWS, RECOVERY_PAGE_BYTES } from '../src/recovery-hosted-protocol';
import { LANDING_CAPSULE_TABLES } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
const prefix = 'recovery-capsules-v1:';
type Cursor = { table: string; phase: 'live' | 'capsules'; cursor: string | null; offset?: number };
export const recoveryCapsuleCursor = (value: Cursor) => prefix + canonicalPayload(value);
export function readRecoveryCapsuleCursor(table: string, cursor: string | null): Cursor {
  if (!cursor?.startsWith(prefix)) return { table, phase: 'live', cursor };
  const value = JSON.parse(cursor.slice(prefix.length)) as Cursor;
  invariant(
    value.table === table &&
      ['live', 'capsules'].includes(value.phase) &&
      (value.cursor === null || typeof value.cursor === 'string') &&
      (value.offset === undefined || (Number.isSafeInteger(value.offset) && value.offset >= 0)),
    'EVIDENCE_CHANGED',
    'Continue the original recovery table page.',
  );
  return value;
}
/** Fixed project metadata changes only at publication, fencing physical relocation during export. */
export async function capsuleRecoveryRevision(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const row = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q => q.eq('kind', capsuleIndexKind).eq('sourceId', projectId))
    .unique();
  return row ? ((JSON.parse(row.value).revision ?? 0) as number) : 0;
}
/** A published pointer owns its entire logical corpus even while verified physical removal resumes. */
export async function capsuleOwnsRecoveryRow(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  table: RecoveryTable,
  row: Record<string, unknown>,
) {
  if (!LANDING_CAPSULE_TABLES.includes(table as never)) return false;
  let submissionId = typeof row.submissionId === 'string' ? row.submissionId : null;
  if (!submissionId && table === 'projectHostedAcceptancePages') {
    const pins = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_source', q =>
        q
          .eq('kind', capsulePageKind)
          .eq(
            'sourceId',
            capsulePageKey(projectId, String(row.receiptId), String(row.kind), Number(row.index)),
          ),
      )
      .unique();
    submissionId = pins?.submissionId ?? null;
  }
  if (!submissionId && table === 'projectHostedAcceptancePages') {
    const plan = await ctx.db
      .query('projectHostedAcceptancePlans')
      .withIndex('by_project_and_receipt', q =>
        q.eq('projectId', projectId).eq('receiptId', row.receiptId as string),
      )
      .unique();
    submissionId = plan?.submissionId ?? null;
  }
  if (!submissionId && typeof row.receiptId === 'string') {
    const receipt = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_receipt', q =>
        q.eq('projectId', projectId).eq('receiptId', row.receiptId as string),
      )
      .unique();
    submissionId = receipt?.submissionId ?? null;
  }
  if (!submissionId && (table === 'projectHostedCheckCallbacks' || table === 'projectHostedComposePages')) {
    if (table === 'projectHostedCheckCallbacks' && String(row.eventId).startsWith('reuse:')) return false;
    const scope =
      table === 'projectHostedCheckCallbacks'
        ? `check:${row.runId}`
        : `compose:${row.actor}:${row.operationId}`;
    const control = await capsuleControlRow(ctx, capsuleControlKey(projectId, scope));
    submissionId = control ? (JSON.parse(control.value).submissionId ?? null) : null;
  }
  return !!submissionId && !!(await landingCapsulePointer(ctx, { projectId, submissionId }));
}
export async function recoveryCapsulePage(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  table: RecoveryTable,
  cursor: Cursor,
  protocol: 1 | undefined,
) {
  invariant(cursor.phase === 'capsules', 'EVIDENCE_CHANGED', 'Select the capsule recovery phase.');
  if (!LANDING_CAPSULE_TABLES.includes(table as never))
    return canonicalPayload({ table, rows: [], cursor: null, done: true });
  const query = ctx.db.query('projectFinishReadRows').withIndex('by_kind_and_project_and_submission', q => {
    const selected = q.eq('kind', capsuleKind).eq('projectId', project._id);
    return cursor.cursor === null
      ? selected
      : cursor.offset === undefined
        ? selected.gt('submissionId', cursor.cursor)
        : selected.gte('submissionId', cursor.cursor);
  });
  const row = await query.first();
  if (!row) return canonicalPayload({ table, rows: [], cursor: null, done: true });
  const pointer = JSON.parse(row.value),
    submissionId = row.submissionId!;
  const offset = cursor.offset ?? 0;
  invariant(
    cursor.offset === undefined || cursor.cursor === submissionId,
    'WORK_STALE',
    'Selected recovery capsule changed.',
  );
  return capsuleHistoryContext(ctx, project, pointer, protocol, submissionId, {
    table,
    rows: [],
    cursor: null,
    done: false,
    recoveryCapsule: { table, offset },
  });
}
/** Raw digests are verified by getLandingCapsule before these rows cross the public identity wrapper. */
export function projectCapsuleRecovery(capsule: LandingCapsule, context: Record<string, unknown>) {
  const selected = context.recoveryCapsule as { table: RecoveryTable; offset: number };
  invariant(selected && typeof selected.table === 'string', 'EVIDENCE_CHANGED', 'Select a recovery table.');
  const all = capsule.tables[selected.table as keyof LandingCapsule['tables']] ?? [];
  invariant(selected.offset <= all.length, 'EVIDENCE_CHANGED', 'Recovery capsule offset differs.');
  const rows: string[] = [];
  let bytes = 0;
  for (const text of all.slice(selected.offset, selected.offset + RECOVERY_PAGE_ROWS)) {
    const size = new TextEncoder().encode(text).length;
    if (rows.length && bytes + size > RECOVERY_PAGE_BYTES) break;
    rows.push(text);
    bytes += size;
  }
  const offset = selected.offset + rows.length;
  return {
    table: selected.table,
    rows,
    done: false,
    cursor: recoveryCapsuleCursor({
      table: selected.table,
      phase: 'capsules',
      cursor: capsule.submissionId,
      ...(offset < all.length ? { offset } : {}),
    }),
  };
}
