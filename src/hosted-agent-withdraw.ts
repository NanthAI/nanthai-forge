// SPDX-License-Identifier: Apache-2.0
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { hostedLandingStateSchema, hostedLandingWithdrawSchema } from './hosted-landing.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { operationWait } from './agent-operation-wait.js';
import { shellQuote } from './shell-quote.js';
import { ForgeError, invariant } from './errors.js';
import { parseHostedResponse } from './hosted-response.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';

export const WITHDRAW_COST =
  'Withdraw ends only this submission: its queue place and its unfinished check (stopped once no other landing needs it). The Lane, its saves, Candidates and the recorded check results stay. Undo by landing again: land --save resubmits the same Lane under a new operation.';

/**
 * `land --withdraw` (Issue 78a97771): end this Lane's live landing so a known failing check stops
 * repeating and the Lane can take a fix. One mutation; the server finds the live landing by Lane
 * and runs the existing cancellation (Lane author or project owner). The operation id is retained,
 * so a lost reply replays the same withdraw instead of cancelling a later landing.
 */
export async function executeHostedWithdraw(session: HostedAgentSession, input: unknown) {
  const command = hostedAgentCommandSchemas.withdraw.parse(input);
  const laneId = command.laneId ?? session.marker()?.selection.laneId;
  invariant(laneId, 'BAD_ARGUMENT', 'Select laneId, or run land --withdraw from the Lane checkout.');
  if (!session.capabilities.features?.includes('landing-withdraw'))
    throw new ForgeError(
      'HOSTED_FEATURE_UNAVAILABLE',
      `This server cannot withdraw by Lane yet. Read the Lane's submissionId with lanes {} or the land receipt, then run nforge x ${shellQuote(session.root)} cancel '{"submissionId":"SUBMISSION_ID"}'.`,
    );
  const request = await session.journal.retain('withdraw-request', () =>
    hostedLandingWithdrawSchema.parse({
      operationId: session.journal.operationId,
      authorityEpoch: session.capabilities.authority.epoch,
      laneId,
      ...(command.reason ? { reason: command.reason } : {}),
    }),
  );
  const landing = parseHostedResponse(
    hostedLandingStateSchema,
    await session.mutation('projectHostedLandingWithdraw:withdraw', { request: canonicalPayload(request) }),
  );
  // Received: an identical withdraw after this one is new work (a later landing), not a replay.
  await session.journal.retain('withdraw-received', () => landing.id);
  return withdrawReceipt(session.root, laneId, landing);
}

/** True when the identical auto-addressed withdraw already returned its receipt (local read only). */
export function withdrawDone(root: string, address: HostedAgentAddress, actor: string, command: unknown) {
  return (
    HostedAgentJournal.previous(root, address, actor, 'withdraw', command)?.values['withdraw-received'] !==
    undefined
  );
}

/** The receipt names the original landing operation: its canonical wait now returns the terminal
 * outcome at once, which also settles this turn's open landing before the builder edits. */
export function withdrawReceipt(
  root: string,
  laneId: string,
  landing: ReturnType<typeof hostedLandingStateSchema.parse>,
) {
  const landed = landing.phase === 'landed';
  const { next, command } = operationWait(root, { operationIds: [landing.operationId], until: 'acceptance' });
  return {
    withdrawn: !landed,
    laneId,
    submissionId: landing.id,
    landingOperationId: landing.operationId,
    landing,
    confirm: { next, waitCommand: command },
    recovery: landed
      ? 'The landing was already accepted before the withdraw; main keeps it. Nothing was cancelled.'
      : `Run confirm.waitCommand: it returns the terminal ${landing.error?.code ?? 'LANDING_CANCELLED'} at once. Then fix the Lane, save, and land --save again (a new operation on the same Lane).`,
    cost: WITHDRAW_COST,
  };
}
