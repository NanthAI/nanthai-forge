// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { landingCapsulePointer as pointerField } from './projectLandingCapsuleFields';
import { capsuleRows, removeVerifiedCapsuleRows, capsuleProgressKind } from './projectLandingCapsuleRemove';
import { capsuleIndexKind } from './projectLandingCapsuleIndex';
import { capsuleKind } from './projectLandingCapsuleStore';
import { loadLanding } from './projectHostedLandingStore';
import { landingAttemptRow } from './projectHostedLandingAttemptRead';
import { acceptancePlan } from './projectHostedAcceptanceStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';

/** The internal Node packer calls this only after a complete PUT/GET/table-hash verification. */
export const publish = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    submissionId: v.string(),
    version: v.number(),
    anchorHash: v.string(),
    pointer: pointerField,
    summary: v.string(),
    rows: capsuleRows,
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const { row, state } = await loadLanding(ctx, input);
    if (row.capsule) return canonicalPayload(row.capsule);
    invariant(
      state.version === input.version &&
        input.pointer.version === input.version &&
        digest(canonicalPayload(state)) === input.anchorHash &&
        ['landed', 'terminal-failed'].includes(state.phase),
      'WORK_STALE',
      'Landing changed before its verified capsule was published.',
    );
    const attempt = await landingAttemptRow(ctx, { projectId: input.projectId, attemptId: state.attemptId });
    invariant(attempt, 'SOURCE_UNAVAILABLE', 'Original terminal attempt pins are unavailable.');
    const plan = state.acceptance
      ? await acceptancePlan(ctx, { projectId: input.projectId, receiptId: state.acceptance.receiptId })
      : null;
    invariant(!plan?.completion, 'WORK_STALE', 'Acceptance completion still owns mutable history.');
    const count = (JSON.parse(input.pointer.tables) as Array<[number, number]>).reduce(
      (n, [, rows]) => n + rows,
      0,
    );
    invariant(
      input.rows.length > 0 && input.rows.length <= 8 && input.rows.length <= count,
      'EVIDENCE_CHANGED',
      'Select the first verified capsule page.',
    );
    const summary = {
      ...JSON.parse(input.summary),
      ...(plan ? { plan } : {}),
      removalDone: input.rows.length === count,
    };
    if (new TextEncoder().encode(attempt.value).length <= 64 * 1024)
      summary.attempt = JSON.parse(attempt.value);
    else {
      const chunks = [];
      for (let offset = 0; offset < attempt.value.length; offset += 32 * 1024)
        chunks.push(attempt.value.slice(offset, offset + 32 * 1024));
      for (const [index, text] of chunks.entries())
        await ctx.db.insert('projectFinishReadRows', {
          kind: 'projectLandingCapsuleAttemptPins',
          projectId: input.projectId,
          submissionId: state.id,
          attemptId: attempt.attemptId,
          sourceId: `${attempt._id}:${index}`,
          value: canonicalPayload([index, text]),
        });
      summary.attemptPin = { parts: chunks.length, sha256: digest(attempt.value) };
    }
    const pointer = { ...input.pointer, summary: canonicalPayload(summary) };
    await ctx.db.insert('projectFinishReadRows', {
      kind: capsuleKind,
      sourceId: row._id,
      projectId: input.projectId,
      submissionId: state.id,
      attemptId: attempt.attemptId,
      sourceCreatedAt: row._creationTime,
      value: canonicalPayload(pointer),
    });
    const index = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_source', q => q.eq('kind', capsuleIndexKind).eq('sourceId', input.projectId))
      .unique();
    invariant(index, 'SOURCE_UNAVAILABLE', 'Capsule index preparation is incomplete.');
    const metadata = JSON.parse(index.value);
    await ctx.db.patch(index._id, {
      value: canonicalPayload({ ...metadata, revision: (metadata.revision ?? 0) + 1 }),
    });
    await removeVerifiedCapsuleRows(ctx, input);
    if (!summary.removalDone)
      await ctx.db.insert('projectFinishReadRows', {
        kind: capsuleProgressKind,
        sourceId: row._id,
        projectId: input.projectId,
        submissionId: state.id,
        value: canonicalPayload({ offset: input.rows.length }),
      });
    return canonicalPayload({ ...pointer, removalOffset: input.rows.length });
  },
});
