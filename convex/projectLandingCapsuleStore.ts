// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { LandingCapsulePointer } from '../src/hosted-landing';
import { hostedLandingAttemptSchema } from '../src/hosted-landing';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
import { landingCapsuleGraceMs } from './projectLandingCapsuleWake';

export const capsuleKind = 'projectLandingCapsules';
type Ctx = QueryCtx | MutationCtx;
type Identity = { projectId: Id<'hostedProjects'>; submissionId: string };
const pointers = new WeakMap<Ctx, Map<string, Promise<LandingCapsulePointer | null>>>();
/** The pointer has its own small row: adding metadata must not overflow a formerly valid request. */
export function landingCapsulePointer(ctx: Ctx, input: Identity) {
  let cache = pointers.get(ctx);
  if (!cache) pointers.set(ctx, (cache = new Map()));
  const key = `${input.projectId}:${input.submissionId}`;
  let selected = cache.get(key);
  if (!selected) {
    selected = ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_submission', q =>
        q.eq('kind', capsuleKind).eq('projectId', input.projectId).eq('submissionId', input.submissionId),
      )
      .unique()
      .then(row => (row ? (JSON.parse(row.value) as LandingCapsulePointer) : null));
    cache.set(key, selected);
  }
  return selected;
}
export async function withLandingCapsule(ctx: Ctx, row: Doc<'projectHostedLandingRequests'> | null) {
  if (!row || row.capsule || !['landed', 'terminal-failed'].includes(row.phase)) return row;
  // A separate pointer cannot exist before the approved terminal grace. Keep the
  // live controller and recent-terminal observer dependency sets unchanged.
  const state = JSON.parse(row.value);
  const settledAt = Date.parse(state.timing?.settledAt ?? state.at);
  if (Number.isFinite(settledAt) && Date.now() < settledAt + landingCapsuleGraceMs) return row;
  const capsule = await landingCapsulePointer(ctx, row);
  return capsule ? { ...row, capsule } : row;
}
export async function capsuleAttempt(
  ctx: Ctx,
  input: { projectId: Id<'hostedProjects'>; attemptId: string },
) {
  const row = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_attempt', q =>
      q.eq('kind', capsuleKind).eq('projectId', input.projectId).eq('attemptId', input.attemptId),
    )
    .unique();
  if (!row) return null;
  const pointer = JSON.parse(row.value) as LandingCapsulePointer;
  invariant(pointer.summary, 'SOURCE_UNAVAILABLE', 'Original capsule transaction pins are unavailable.');
  const summary = JSON.parse(pointer.summary);
  let value = summary.attempt;
  if (summary.attemptPin) {
    const pin = summary.attemptPin as { parts: number; sha256: string };
    invariant(
      Number.isSafeInteger(pin.parts) && pin.parts > 0,
      'EVIDENCE_CHANGED',
      'Attempt pin page count differs.',
    );
    const rows = await ctx.db
      .query('projectFinishReadRows')
      .withIndex('by_kind_and_project_and_attempt', q =>
        q
          .eq('kind', 'projectLandingCapsuleAttemptPins')
          .eq('projectId', input.projectId)
          .eq('attemptId', input.attemptId),
      )
      .take(pin.parts);
    const parts = rows.map(row => JSON.parse(row.value) as [number, string]).sort(([a], [b]) => a - b);
    invariant(
      parts.length === pin.parts && parts.every(([index], position) => index === position),
      'EVIDENCE_CHANGED',
      'Original attempt pin pages are incomplete.',
    );
    const text = parts.map(([, text]) => text).join('');
    invariant(digest(text) === pin.sha256, 'EVIDENCE_CHANGED', 'Original attempt pin bytes differ.');
    value = JSON.parse(text);
  }
  const attempt = hostedLandingAttemptSchema.parse(value);
  invariant(
    attempt.id === input.attemptId && attempt.projectId === input.projectId,
    'EVIDENCE_CHANGED',
    'Capsule replay pins differ from the selected attempt.',
  );
  return attempt;
}
export async function capsulePlan(ctx: Ctx, input: { projectId: Id<'hostedProjects'>; receiptId: string }) {
  const receipt = await ctx.db
    .query('projectHostedAcceptances')
    .withIndex('by_project_and_receipt', q =>
      q.eq('projectId', input.projectId).eq('receiptId', input.receiptId),
    )
    .unique();
  if (!receipt) return null;
  const pointer = await landingCapsulePointer(ctx, receipt);
  if (!pointer?.summary) return null;
  const plan = JSON.parse(pointer.summary).plan as Doc<'projectHostedAcceptancePlans'> | undefined;
  invariant(!plan || plan.receiptId === input.receiptId, 'EVIDENCE_CHANGED', 'Capsule receipt pins differ.');
  return plan ?? null;
}
