// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { randomUUID } from 'node:crypto';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { ForgeError, invariant, withLocalFailure } from './errors.js';
import {
  hostedActionError,
  hostedFailureCauseOf,
  hostedFailureDetail,
  transientFailureCause,
} from './hosted-action-error.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';
import { hostedConversationSchemas, type CoordinationCommand } from './coordination-types.js';
import { compactEvent, type StoredEvent } from './coordination-compact.js';
import { sessionAgentIdentity } from './agent-slug-session.js';
import { describeIssues } from './argument-errors.js';
import { shellQuote } from './shell-quote.js';

const agentCommand = (root: string, action: string, parameters: Record<string, unknown>) =>
  `nforge agent ${shellQuote(root)} ${action} ${shellQuote(JSON.stringify(parameters))}`;

export async function hostedConversation(
  transport: Pick<HostedAgentTransport, 'root' | 'mutation' | 'agentSession'>,
  action: keyof typeof hostedConversationSchemas,
  input: unknown,
) {
  const checkoutLaneId = readHostedLaneCheckout(transport.root)?.selection.laneId;
  let command: CoordinationCommand;
  let original: string | undefined;
  let replayInput: Record<string, unknown>;
  if (action === 'ask') {
    const parsed = hostedConversationSchemas.ask.safeParse(input);
    invariant(
      parsed.success,
      'BAD_ARGUMENT',
      `Invalid ask parameters: ${parsed.success ? '' : describeIssues(parsed.error.issues, input)}. Run nforge agent ${shellQuote(transport.root)} ask --help, correct the named fields and retry.`,
    );
    const { operationId, to, text, choices, laneId, planningItemId, holdsWork } = parsed.data;
    original = operationId;
    replayInput = parsed.data;
    invariant(
      !(laneId && planningItemId),
      'BAD_ARGUMENT',
      `Pass either laneId (${laneId}) or planningItemId (${planningItemId}), not both. Omit laneId inside a Lane to use it, or drop laneId to ask on the Item.`,
    );
    const targetLaneId = laneId ?? (planningItemId ? undefined : checkoutLaneId);
    invariant(
      Boolean(targetLaneId) !== Boolean(planningItemId),
      'BAD_ARGUMENT',
      'Choose a Lane (laneId) or an Item (planningItemId), or run from inside a Lane checkout.',
    );
    command = {
      kind: 'message',
      ...(checkoutLaneId ? { sessionId: checkoutLaneId } : {}),
      recipient: to,
      text,
      choices,
      question: { ...(planningItemId ? { planningItemId } : {}), holdsWork: holdsWork ?? true },
      context: targetLaneId ? { laneId: targetLaneId } : {},
    };
  } else {
    const parsed = hostedConversationSchemas['hand-back'].safeParse(input);
    invariant(
      parsed.success,
      'BAD_ARGUMENT',
      `Invalid hand-back parameters: ${parsed.success ? '' : describeIssues(parsed.error.issues, input)}. Run nforge agent ${shellQuote(transport.root)} hand-back --help, correct the named fields and retry.`,
    );
    const { operationId, to, tried, left, head, laneId = checkoutLaneId } = parsed.data;
    original = operationId;
    replayInput = parsed.data;
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
    const next =
      action === 'ask' && event.recipientSession
        ? `Delivered to session ${event.recipientSession}. The peer answers with nforge coordination ${shellQuote(transport.root)} '${JSON.stringify({ action: 'ack', sessionId: event.recipientSession, messageId: event.operationId, choice: 'EXACT_CHOICE' })}'; read answers with coordination inbox.`
        : 'Tell your user in your agent app.';
    return { operationId, result: { ...compactEvent(event), next } };
  } catch (error) {
    const typed = hostedActionError(error, action);
    if (typed.code === 'HOSTED_ACTION_FAILED') {
      const cause = hostedFailureCauseOf(typed.message) ?? 'server-exception';
      const retryable = transientFailureCause(cause);
      const replay = agentCommand(transport.root, action, { ...replayInput, operationId });
      const where =
        cause.startsWith('local-') || cause === 'cancelled' ? 'Local step of agent' : 'Hosted agent';
      const hint = !retryable
        ? 'Fix the named cause first; then run next to replay the same operation.'
        : 'Run next: it replays the same operation with its original operationId.';
      const failure = new ForgeError(
        typed.code,
        `${where} ${action} failed${hostedFailureDetail(typed.message)}. ${hint}`,
        typed.retryAt,
        {
          ...typed.recovery,
          cause,
          retryable,
          command: replay,
          operationId,
        },
      );
      throw cause.startsWith('local-') || cause === 'cancelled' ? withLocalFailure(failure, error) : failure;
    }
    const nextCommand =
      typed.code === 'NOT_FOUND' && /Item not found/i.test(typed.message)
        ? agentCommand(transport.root, 'planning', { status: 'open', limit: 20 })
        : typed.code === 'NOT_FOUND' ||
            (typed.code === 'BAD_ARGUMENT' && /write member|agent handle|open Lane/i.test(typed.message))
          ? agentCommand(transport.root, 'lanes', {})
          : undefined;
    throw new ForgeError(typed.code, typed.message, typed.retryAt, {
      ...typed.recovery,
      ...(nextCommand ? { command: nextCommand } : {}),
      operationId,
    });
  }
}
