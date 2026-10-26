// SPDX-License-Identifier: Apache-2.0
import type { ChannelMove } from './work-types.js';

type AuditMove = Partial<
  Pick<ChannelMove, 'channel' | 'postAccept' | 'postAcceptRunId' | 'postAcceptAuditRunId'>
>;
/** A selected audit covers requests through its accepted main move, never later
 * acceptances. Legacy fan-out pointers remain readable without any migration. */
export function postAcceptMoves<T extends AuditMove>(moves: T[]): T[] {
  const latest = new Map<string | undefined, string>();
  return moves
    .slice()
    .reverse()
    .map(move => {
      const { postAcceptAuditRunId, ...record } = move;
      const selected = postAcceptAuditRunId;
      if (!latest.has(move.channel) && selected) latest.set(move.channel, selected);
      const runId = move.postAccept
        ? (latest.get(move.channel) ?? move.postAcceptRunId)
        : move.postAcceptRunId;
      return { ...record, ...(runId ? { postAcceptRunId: runId } : {}) } as T;
    })
    .reverse();
}
