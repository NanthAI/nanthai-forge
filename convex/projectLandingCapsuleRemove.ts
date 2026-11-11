// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { projectPurgeWriter } from './projectFinishReadWriter';
import { capsuleKind, landingCapsulePointer } from './projectLandingCapsuleStore';
import { capsuleFinishKinds } from './projectLandingCapsuleCapture';
import {
  capsuleControlKey,
  capsuleControlRow,
  retainCapsuleReceipts,
  capsulePageKind,
  capsulePageKey,
  compactCapsulePage,
  capsuleExpiryScope,
} from './projectLandingCapsuleLedger';
import { LANDING_CAPSULE_TABLES, type LandingCapsulePointer } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
export const capsuleRows = v.array(v.object({ table: v.string(), row: v.string() }));
export const capsuleProgressKind = 'projectLandingCapsuleProgress';
type Part = { table: string; row: string };
const totalRows = (pointer: LandingCapsulePointer) =>
  (JSON.parse(pointer.tables) as Array<[number, number]>).reduce((n, [, rows]) => n + rows, 0);

/** The caller owns every companion disposition, as in permanent project removal. */
export async function removeVerifiedCapsuleRows(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    submissionId: string;
    rows: Part[];
  },
) {
  invariant(
    input.rows.length > 0 && input.rows.length <= 8,
    'BAD_ARGUMENT',
    'Remove one verified capsule page.',
  );
  const raw = projectPurgeWriter(ctx);
  const receipts = new Map<string, Array<[string, string]>>();
  const ownership = new Map<string, boolean>();
  async function owns(scope: string) {
    if (!ownership.has(scope)) {
      const owner = await capsuleControlRow(ctx, capsuleControlKey(input.projectId, scope));
      ownership.set(scope, !!owner && JSON.parse(owner.value).submissionId === input.submissionId);
    }
    invariant(ownership.get(scope), 'EVIDENCE_CHANGED', 'A shared capsule row has another owner.');
  }
  const retain = (scope: string, key: string, value: string) => {
    if (!receipts.has(scope)) receipts.set(scope, []);
    receipts.get(scope)!.push([key, value]);
  };
  let removed = 0;
  for (const part of input.rows) {
    invariant(
      LANDING_CAPSULE_TABLES.includes(part.table as never),
      'EVIDENCE_CHANGED',
      'Capsule table is unavailable.',
    );
    const archived = JSON.parse(part.row);
    invariant(
      canonicalPayload(archived) === part.row,
      'EVIDENCE_CHANGED',
      'Original capsule row bytes differ.',
    );
    const table = part.table as (typeof LANDING_CAPSULE_TABLES)[number];
    const id = ctx.db.normalizeId(table, archived._id);
    invariant(id, 'EVIDENCE_CHANGED', 'Capsule row identity belongs to another table.');
    invariant(
      table === 'legacyStorageCleanupPages' || archived.projectId === input.projectId,
      'EVIDENCE_CHANGED',
      'Capsule row belongs to another project.',
    );
    const current = await raw.db.get(id);
    if (current)
      invariant(
        digest(canonicalPayload(current)) === digest(part.row),
        'WORK_STALE',
        'A captured history row changed; its current bytes were retained.',
      );
    if (table === 'projectHostedLandingAttempts' || table === 'projectHostedLandingObservations')
      invariant(
        archived.submissionId === input.submissionId,
        'EVIDENCE_CHANGED',
        'Capsule row belongs to another submission.',
      );
    if (table === 'projectFinishReadRows')
      invariant(
        archived.submissionId === input.submissionId && capsuleFinishKinds.includes(archived.kind),
        'EVIDENCE_CHANGED',
        'Shared projections must remain transactional.',
      );
    if (table === 'projectHostedAcceptancePlans')
      invariant(
        archived.submissionId === input.submissionId,
        'EVIDENCE_CHANGED',
        'Acceptance plan belongs to another submission.',
      );
    if (table === 'projectHostedAcceptancePages') {
      const plan = await ctx.db
        .query('projectHostedAcceptancePlans')
        .withIndex('by_project_and_receipt', q =>
          q.eq('projectId', input.projectId).eq('receiptId', archived.receiptId),
        )
        .unique();
      invariant(
        plan?.submissionId === input.submissionId,
        'EVIDENCE_CHANGED',
        'Acceptance page belongs to another submission.',
      );
      const sourceId = capsulePageKey(input.projectId, archived.receiptId, archived.kind, archived.index);
      const value = compactCapsulePage(archived as Doc<'projectHostedAcceptancePages'>);
      const old = await ctx.db
        .query('projectFinishReadRows')
        .withIndex('by_kind_and_source', q => q.eq('kind', capsulePageKind).eq('sourceId', sourceId))
        .unique();
      invariant(!old || old.value === value, 'EVIDENCE_CHANGED', 'Accepted transaction pins changed.');
      if (!old)
        await ctx.db.insert('projectFinishReadRows', {
          kind: capsulePageKind,
          sourceId,
          projectId: input.projectId,
          submissionId: input.submissionId,
          value,
        });
    }
    if (table === 'projectHostedAcceptanceEvents' || table === 'projectHostedAcceptanceSnapshots') {
      const receipt = await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project_and_receipt', q =>
          q.eq('projectId', input.projectId).eq('receiptId', archived.receiptId),
        )
        .unique();
      invariant(
        receipt?.submissionId === input.submissionId,
        'EVIDENCE_CHANGED',
        'Acceptance evidence belongs to another submission.',
      );
    }
    if (table === 'projectHostedCheckCallbacks') {
      invariant(
        !archived.eventId.startsWith('reuse:') && (!archived.value || archived.value === '{}'),
        'EVIDENCE_CHANGED',
        'Only expired callback digest receipts may relocate; reuse aliases stay.',
      );
      const scope = `check:${archived.runId}`;
      await owns(scope);
      retain(scope, archived.eventId, archived.digest);
    }
    if (table === 'projectHostedComposePages') {
      const scope = `compose:${archived.actor}:${archived.operationId}`;
      await owns(scope);
      retain(scope, `${archived.kind}:${archived.index}`, archived.digest);
    }
    if (table === 'legacyStorageCleanupPages') {
      const request = JSON.parse(archived.request);
      invariant(
        request.projectId === input.projectId,
        'EVIDENCE_CHANGED',
        'Expiry receipt belongs to another project.',
      );
      const scope = await capsuleExpiryScope(ctx, request);
      invariant(scope, 'EVIDENCE_CHANGED', 'Expiry receipt has no selected landing source.');
      await owns(scope);
      retain(
        scope,
        `expiry:${archived.operationId}:${archived.part}`,
        JSON.stringify([digest(archived.request), archived.result]),
      );
    }
    if (current) {
      await raw.db.delete(id);
      removed++;
    }
  }
  for (const [scope, values] of receipts) await retainCapsuleReceipts(ctx, input.projectId, scope, values);
  return removed;
}

export const page = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    sha256: v.string(),
    offset: v.number(),
    rows: capsuleRows,
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const pointer = await landingCapsulePointer(ctx, input);
    invariant(
      pointer?.sha256 === input.sha256,
      'WORK_STALE',
      'Resume the original verified capsule removal.',
    );
    const summary = JSON.parse(pointer.summary!);
    if (summary.removalDone) return canonicalPayload(pointer);
    const progress = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_submission', q =>
        q
          .eq('kind', capsuleProgressKind)
          .eq('projectId', input.projectId)
          .eq('submissionId', input.submissionId),
      )
      .unique();
    invariant(progress, 'EVIDENCE_CHANGED', 'Verified capsule removal position is unavailable.');
    const offset = JSON.parse(progress.value).offset as number;
    if (input.offset < offset) return canonicalPayload({ ...pointer, removalOffset: offset });
    invariant(input.offset === offset, 'EVIDENCE_CHANGED', 'Continue the original verified removal page.');
    await removeVerifiedCapsuleRows(ctx, input);
    const next = offset + input.rows.length;
    invariant(
      next <= totalRows(pointer),
      'EVIDENCE_CHANGED',
      'Capsule removal exceeds its verified row count.',
    );
    if (next === totalRows(pointer)) {
      await ctx.db.delete(progress._id);
      const value = { ...pointer, summary: canonicalPayload({ ...summary, removalDone: true }) };
      const row = await ctx.db
        .query('projectFinishReadRows')
        .withIndex('by_kind_and_project_and_submission', q =>
          q.eq('kind', capsuleKind).eq('projectId', input.projectId).eq('submissionId', input.submissionId),
        )
        .unique();
      invariant(row, 'EVIDENCE_CHANGED', 'Published capsule pointer is unavailable.');
      await ctx.db.patch(row._id, { value: canonicalPayload(value) });
      return canonicalPayload(value);
    }
    await ctx.db.patch(progress._id, { value: canonicalPayload({ offset: next }) });
    return canonicalPayload({ ...pointer, removalOffset: next });
  },
});
