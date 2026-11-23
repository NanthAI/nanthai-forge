// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { randomUUID } from 'node:crypto';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { ForgeError, invariant } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import { hostedConversationSchemas, type CoordinationCommand } from './coordination-types.js';
import { compactEvent, type StoredEvent } from './coordination-compact.js';
import { sessionAgentIdentity } from './agent-slug-session.js';

export async function hostedConversation(
  transport: Pick<HostedAgentTransport, 'root' | 'mutation' | 'agentSession'>,
  action: keyof typeof hostedConversationSchemas,
  input: unknown,
) {
  const checkoutLaneId = readHostedLaneCheckout(transport.root)?.selection.laneId;
  let command: CoordinationCommand;
  let original: string | undefined;
  if (action === 'ask') {
    const { operationId, to, text, choices, laneId, planningItemId, holdsWork } =
      hostedConversationSchemas.ask.parse(input);
    original = operationId;
    const targetLaneId = laneId ?? (planningItemId ? undefined : checkoutLaneId);
    invariant(Boolean(targetLaneId) !== Boolean(planningItemId), 'BAD_ARGUMENT', 'Choose one Lane or Item.');
    command = {
      kind: 'message',
      recipient: to,
      text,
      choices,
      question: { ...(planningItemId ? { planningItemId } : {}), holdsWork: holdsWork ?? true },
      context: targetLaneId ? { laneId: targetLaneId } : {},
    };
  } else {
    const {
      operationId,
      to,
      tried,
      left,
      head,
      laneId = checkoutLaneId,
    } = hostedConversationSchemas['hand-back'].parse(input);
    original = operationId;
    invariant(laneId, 'BAD_ARGUMENT', 'Select the Lane to hand back.');
    command = {
      kind: 'handoff',
      to,
      summary: tried,
      head,
      laneId,
      handBack: { left },
    };
  }
  const operationId = (original ?? randomUUID()).toLowerCase();
  try {
    const event = await transport.mutation<StoredEvent>('projectCoordination:publish', {
      operationId,
      command,
      ...(action === 'hand-back'
        ? { holderSessionId: sessionAgentIdentity(transport.agentSession).sessionId }
        : {}),
    });
    return { operationId, result: { ...compactEvent(event), next: 'Tell your user in your agent app.' } };
  } catch (error) {
    const typed = hostedActionError(error, action);
    throw new ForgeError(typed.code, typed.message, typed.retryAt, { ...typed.recovery, operationId });
  }
}
