// SPDX-License-Identifier: Apache-2.0
import type { PeersDigest } from './agent-peers.js';
export const PEERS_MAX_BYTES = 1500;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Byte cap applies to JSON UTF-8, including escaping. `more` counts omitted entries. */
export function boundPeers(value: PeersDigest, detail = false): PeersDigest {
  if (detail) return value;
  if (value.ownership) {
    value.ownership.actor = value.ownership.actor.slice(0, 200);
    if (value.ownership.sessionId) value.ownership.sessionId = value.ownership.sessionId.slice(0, 200);
  }
  let more = 0;
  if (value.notices) value.notices = value.notices.slice(-3).map(item => ({ text: item.text.slice(0, 200) }));
  if (value.conflicts?.length) {
    more += Math.max(0, value.conflicts.length - 3);
    value.conflicts.splice(3);
    // Full, exact source is available through peers detail:true. Drop hunks first,
    // then rich context; retain a direct retrieval instruction in compact receipts.
    for (const notice of value.conflicts) {
      notice.detail = 'peers {laneId,detail:true} returns exact hunks, intents, messages and owner sessions';
      for (const conflict of notice.conflicts) {
        if (conflict.hunk && conflict.hunk.split('\n').length > 30) delete conflict.hunk;
      }
    }
    if (size(value) > PEERS_MAX_BYTES)
      for (const notice of value.conflicts) for (const c of notice.conflicts) delete c.hunk;
    if (size(value) > PEERS_MAX_BYTES)
      for (const notice of value.conflicts) {
        notice.participants = [];
        if (notice.decisions)
          notice.decisions = notice.decisions
            .slice(-2)
            .map(({ operationId, laneId, choice }) => ({ operationId, laneId, choice }));
        notice.conflicts = notice.conflicts.slice(0, 3);
        notice.reason = '';
        notice.conflicts = notice.conflicts.map(({ path, kind }) => ({ path, kind }));
      }
  }
  for (const key of ['overlaps', 'landed'] as const) {
    const items = value[key];
    if (!items?.length) {
      delete value[key];
      continue;
    }
    more += Math.max(0, items.length - 5);
    items.splice(5);
    for (const item of items) {
      const extra = Math.max(0, item.paths.length - 3);
      item.paths = item.paths.slice(0, 3);
      if (extra) item.more = extra;
    }
  }
  if (value.contracts?.length) {
    more += Math.max(0, value.contracts.length - 3);
    value.contracts.splice(3);
    for (const item of value.contracts) {
      const extra = Math.max(0, item.changes.length - 5);
      item.changes = item.changes.slice(0, 5);
      if (extra) item.more = extra;
    }
  }
  if (value.dependents?.length) {
    more += Math.max(0, value.dependents.length - 3);
    value.dependents.splice(3);
    for (const item of value.dependents) {
      const extra = item.uses.length - 2;
      if (extra > 0) item.more = (item.more ?? 0) + extra;
      item.uses = item.uses.slice(0, 2);
    }
  }
  if (value.stalled && value.stalled.length > 3) {
    more += value.stalled.length - 3;
    value.stalled.splice(3);
  }
  if (more) value.more = more;
  while (size(value) > PEERS_MAX_BYTES) {
    const items = value.landed?.length
      ? value.landed
      : value.overlaps?.length
        ? value.overlaps
        : value.stalled?.length
          ? value.stalled
          : value.conflicts?.length
            ? value.conflicts
            : value.dependents?.length
              ? value.dependents
              : value.contracts;
    if (!items?.length) {
      if (value.notices?.length) {
        value.notices.pop();
        value.more = (value.more ?? 0) + 1;
        continue;
      }
      delete value.next;
      if (size(value) > PEERS_MAX_BYTES && value.ownership?.sessionId) {
        delete value.ownership.sessionId;
        continue;
      }
      break;
    }
    items.pop();
    value.more = (value.more ?? 0) + 1;
    if (!value.landed?.length) delete value.landed;
    if (!value.overlaps?.length) delete value.overlaps;
    if (!value.conflicts?.length) delete value.conflicts;
    if (!value.stalled?.length) delete value.stalled;
    if (!value.dependents?.length) delete value.dependents;
    if (!value.contracts?.length) delete value.contracts;
  }
  return value;
}
