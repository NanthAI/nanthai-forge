// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { invariant } from '../src/errors';
import { landingMessage } from '../src/landing-message';

/** Old cancel and withdraw clients validate the original timing object strictly. */
export function landingWithoutClientHold(state: HostedLandingState): HostedLandingState {
  if (state.timing?.heldMs === undefined) return state;
  const { heldMs: _heldMs, ...timing } = state.timing;
  void _heldMs;
  return { ...state, timing };
}

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

/** Item 8c50ce13, default off until proved on one project; then this switch and the inline
 * writer are deleted. On, a new ticket stores its supplied message once and receipts reference it. */
export const landingMessageRefsOn = () => process.env.FORGE_LANDING_MESSAGE_REFS === '1';

/** A receipt's message field: the ticket's stored body when the accepted message is that body,
 * else the inline value (legacy omission defaults, inherited resolution text, empty notes). */
export function receiptMessageField(
  row: { messageBodyId?: string | undefined },
  state: HostedLandingState,
  message: string | undefined,
) {
  if (message === undefined) return {};
  // Turning the switch off stops new references at once; stored tickets still read back inline.
  return landingMessageRefsOn() && row.messageBodyId && !state.messageRef && state.request.message === message
    ? { messageRef: row.messageBodyId }
    : { message };
}

/** A stored receipt value that names its message instead of carrying it (recovery expands these). */
export const referencesStoredMessage = (value: string) => /"(?:messageRef|cohortSize)":/.test(value);
