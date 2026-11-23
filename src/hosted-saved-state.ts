// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { invariant } from './errors.js';
import { readHostedAgentRecords } from './hosted-agent-record-read.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

/** Pages of 100 saves read before a short State id gives up (Lanes rarely pass a few hundred saves). */
const SAVE_PAGES = 10;
const FULL_STATE = /^[0-9a-f]{64}$/;

/** A diff `from` State (Issue 17ea21ac): a full State id, or a unique prefix of this Lane's base or one
 * of its saved States, read from its save history (`records saves`), one call per 100 saves. */
export async function resolveLaneState(
  transport: HostedAgentTransport,
  lane: { laneId: string; base: { head: string }; head: string },
  from: string,
) {
  const wanted = from.toLowerCase();
  if (FULL_STATE.test(wanted)) return wanted;
  const states = new Set([lane.base.head, lane.head]);
  let cursor: string | null = null,
    complete = false;
  for (let page = 0; page < SAVE_PAGES && !complete; page++) {
    const reply = (await readHostedAgentRecords(transport, {
      collection: 'saves',
      parentId: lane.laneId,
      cursor,
    })) as { items?: Array<{ head?: unknown }>; nextCursor?: unknown };
    for (const item of reply.items ?? []) if (typeof item.head === 'string') states.add(item.head);
    cursor = typeof reply.nextCursor === 'string' ? reply.nextCursor : null;
    complete = cursor === null;
  }
  const matches = [...states].filter(state => state.startsWith(wanted));
  const list = `nforge agent ROOT records '{"collection":"saves","parentId":"${lane.laneId}"}'`;
  invariant(
    matches.length < 2,
    'AMBIGUOUS_ID',
    `State prefix ${from} matches ${matches.length} States of Lane ${lane.laneId}: ${matches.join(', ')}. Use more characters or the full id.`,
  );
  invariant(
    matches.length === 1,
    'NOT_FOUND',
    `No saved State of Lane ${lane.laneId} starts with ${from}${complete ? '' : ` in its first ${SAVE_PAGES * 100} saves`}. List its saves with ${list}, or pass a full State id.`,
  );
  return matches[0]!;
}
