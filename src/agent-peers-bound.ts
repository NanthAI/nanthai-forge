// SPDX-License-Identifier: Apache-2.0
import type { OverlapAlert } from './agent-overlap-alerts.js';
import type { PeersDigest } from './agent-peers.js';
export const PEERS_MAX_BYTES = 1500;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Compact advice keeps exact file identity; only the human text uses a preview. */
export function compactOverlapNotice({
  noticeId,
  kind,
  lanes,
  file,
  proposedOrder,
}: Pick<OverlapAlert, 'noticeId' | 'kind' | 'lanes' | 'file' | 'proposedOrder'>) {
  const display = file.length > 120 ? `…${file.slice(-119)}` : file;
  return {
    noticeId,
    kind,
    lanes,
    file,
    proposedOrder,
    text: `High overlap: ${display}; proposed region owner ${proposedOrder[0]?.slice(0, 8)}; land ${proposedOrder.map(id => id.slice(0, 8)).join(' → ')}; sync after ${proposedOrder[0]?.slice(0, 8)} lands.`,
  };
}

/** Byte cap applies to JSON UTF-8, including escaping. `more` counts omitted entries. */
export function boundPeers(value: PeersDigest, detail = false): PeersDigest {
  if (detail) return value;
  delete value.changes;
  if (value.stack) value.stack.summary = value.stack.summary.slice(0, 200);
  if (value.handoff) value.handoff.recordedChecks = value.handoff.recordedChecks.slice(-1);
  if (value.predictive) {
    value.predictive = value.predictive.filter(item => item.risk === 'high');
    if (!value.predictive.length) delete value.predictive;
  }
  if (value.ownership) {
    value.ownership.actor = value.ownership.actor.slice(0, 200);
    if (value.ownership.sessionId) value.ownership.sessionId = value.ownership.sessionId.slice(0, 200);
  }
  let more = 0;
  if (value.inbox) {
    more += Math.max(0, value.inbox.length - 3);
    value.inbox = value.inbox.slice(-3).map(compactOverlapNotice);
  }
  if (value.predictive) {
    more += Math.max(0, value.predictive.length - 3);
    value.predictive.splice(3);
    for (const item of value.predictive) {
      const extra =
        Math.max(0, (item.mine?.length ?? 0) - 2) +
        Math.max(0, (item.peer?.length ?? 0) - 2) +
        Math.max(0, (item.symbols?.length ?? 0) - 2);
      if (item.mine) item.mine = item.mine.slice(0, 2);
      if (item.peer) item.peer = item.peer.slice(0, 2);
      if (item.alignedPeer) item.alignedPeer = item.alignedPeer.slice(0, 2);
      if (item.symbols) item.symbols = item.symbols.slice(0, 2);
      if (extra) item.more = extra;
    }
  }
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
          : value.dependents?.length
            ? value.dependents
            : value.contracts?.length
              ? value.contracts
              : value.predictive?.length
                ? value.predictive
                : value.inbox && value.inbox.length > 1
                  ? value.inbox
                  : value.conflicts;
    if (!items?.length) {
      if (value.inbox?.length) {
        value.inbox.shift();
        value.more = (value.more ?? 0) + 1;
        continue;
      }
      if (value.notices?.length) {
        value.notices.pop();
        value.more = (value.more ?? 0) + 1;
        continue;
      }
      if (value.handoff?.recordedChecks.length) {
        value.handoff.recordedChecks = [];
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
    if (!value.predictive?.length) delete value.predictive;
  }
  return value;
}
