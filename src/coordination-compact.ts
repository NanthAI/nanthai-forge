// SPDX-License-Identifier: Apache-2.0
import type { StoredCoordinationCommand } from './coordination-types.js';
import { commandScope } from './coordination-paths.js';

export type StoredEvent = {
  operationId: string;
  actor: string;
  actorDisplayName?: string;
  at: number;
  command: StoredCoordinationCommand;
  recipientActor?: string;
  recipientSession?: string;
  acked?: boolean;
};
type StoredClaim = {
  claimId: string;
  actor: string;
  sessionId?: string;
  paths: string[];
  intentId?: string;
  laneId?: string;
  note?: string;
  expiresAt: number;
};
const defined = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));

/** Short agent-facing shape: who, what, scope and the identifiers needed to ack or follow up. */
export function compactEvent(event: StoredEvent) {
  const command = event.command,
    scope = commandScope(command);
  return defined({
    id: event.operationId,
    kind: command.kind,
    from: event.actor,
    fromDisplayName: event.actorDisplayName,
    session: 'sessionId' in command ? command.sessionId : undefined,
    to: event.recipientSession ?? event.recipientActor,
    at: event.at,
    text:
      command.kind === 'message' || command.kind === 'ack'
        ? command.text
        : command.kind === 'activity' || command.kind === 'handoff'
          ? command.summary
          : command.kind === 'claim'
            ? command.note
            : undefined,
    status: command.kind === 'activity' ? command.status : undefined,
    source: command.kind === 'change' ? command.source : undefined,
    action: command.kind === 'change' ? command.action : undefined,
    messageId: command.kind === 'ack' ? command.messageId : undefined,
    claimId:
      command.kind === 'release'
        ? command.claimId
        : command.kind === 'claim'
          ? (command.claimId ?? event.operationId)
          : undefined,
    intentId: scope.intentId,
    laneId: scope.laneId,
    head: scope.head,
    paths: scope.paths?.length ? scope.paths : undefined,
    pathCount: command.kind === 'change' ? command.pathCount : undefined,
    choices: command.kind === 'message' ? command.choices : undefined,
    choice: command.kind === 'ack' ? command.choice : undefined,
    acked: event.acked,
  });
}
export function compactClaim(claim: StoredClaim) {
  return defined({
    claimId: claim.claimId,
    actor: claim.actor,
    session: claim.sessionId,
    paths: claim.paths,
    intentId: claim.intentId,
    laneId: claim.laneId,
    note: claim.note,
    expiresAt: claim.expiresAt,
  });
}
