// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { invariant } from '../src/errors';
import { landingMessage } from '../src/landing-message';

/** Callers resolve the containing landing or receipt under current project access first. */
export async function landingMessageText(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  stored: { message?: string | null | undefined; messageRef?: string | undefined },
) {
  if (stored.messageRef === undefined) return stored.message ?? undefined;
  const id = ctx.db.normalizeId('projectHostedLandingBodies', stored.messageRef);
  invariant(id, 'EVIDENCE_CHANGED', 'The landing message reference is invalid.');
  const row = await ctx.db.get(id);
  invariant(row, 'SOURCE_UNAVAILABLE', 'The landing message is unavailable.');
  invariant(
    row.messageProjectId === projectId,
    'EVIDENCE_CHANGED',
    'The landing message belongs to another project.',
  );
  invariant(
    row.value === landingMessage(row.value),
    'EVIDENCE_CHANGED',
    'The stored landing message is not canonical.',
  );
  return row.value;
}

/** Preserve the released request and top-level message fields without returning the storage reference. */
export async function landingMessageForReader(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  state: HostedLandingState,
) {
  const { messageRef, ...result } = state;
  if (!messageRef) return state;
  const message = await landingMessageText(ctx, projectId, { messageRef: messageRef.id });
  return messageRef.source === 'request'
    ? { ...result, request: { ...result.request, message } }
    : { ...result, message };
}
