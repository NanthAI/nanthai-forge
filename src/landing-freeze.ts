// SPDX-License-Identifier: Apache-2.0
import { readTurnLedger, turnSessionKey } from './agent-turn-work.js';

/** True when a reply names an unfinished landing (its canonical wait on operationIds): the
 * landing pinned the saved source, so save advice must wait for its outcome. Formatting only. */
export function liveLanding(result: unknown) {
  if (!result || typeof result !== 'object') return false;
  const reply = result as { inProgress?: unknown; next?: { action?: unknown; operationIds?: unknown } };
  return (
    reply.inProgress === true &&
    reply.next?.action === 'wait' &&
    Array.isArray(reply.next.operationIds) &&
    reply.next.operationIds.length > 0
  );
}

/** True when this agent session recorded an unfinished landing from this checkout (the turn
 * ledger its land and wait commands keep). One local read; no call; fails closed to false. */
export function ownsLiveLanding(root: string, session = turnSessionKey()) {
  if (!session) return false;
  try {
    return readTurnLedger(session).work.some(work => work.kind === 'landing' && work.root === root);
  } catch {
    return false;
  }
}
