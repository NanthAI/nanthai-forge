// SPDX-License-Identifier: Apache-2.0
import type { OverlapAlert } from './agent-overlap-alerts.js';
import type { PeersDigest } from './agent-peers.js';
export const PEERS_MAX_BYTES = 12_000;
export const PEERS_DISPLAY_LIMIT = 10;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Compact advice keeps exact file identity; only the human text uses a preview. */
export function compactOverlapNotice({
  noticeId,
  kind,
  lanes,
  file,
  proposedOrder,
  participants,
}: Pick<OverlapAlert, 'noticeId' | 'kind' | 'lanes' | 'file' | 'proposedOrder' | 'participants'>) {
  const display = file.length > 120 ? `…${file.slice(-119)}` : file;
  const people = participants?.map(p => ({
    ...p,
    ...(p.actor ? { actor: p.actor.slice(0, 80) } : {}),
    intent: p.intent.slice(0, 160),
  }));
  return {
    noticeId,
    kind,
    lanes,
    file,
    proposedOrder,
    ...(people ? { participants: people } : {}),
    text: `High overlap: ${display}; ${people?.map(p => `${p.lane.slice(0, 8)} (${p.actor ?? 'unknown actor'}; ${p.intent})`).join(' / ') ?? lanes.map(id => id.slice(0, 8)).join(' / ')}; proposed region owner ${proposedOrder[0]?.slice(0, 8)}; land ${proposedOrder.map(id => id.slice(0, 8)).join(' → ')}; sync after ${proposedOrder[0]?.slice(0, 8)} lands.`,
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
  let more = value.more ?? 0;
  if (value.inbox) {
    // One recent example per Lane pair: several regions/files for one peer
    // must not hide another peer or masquerade as additional omitted Lanes.
    const latest = [...value.inbox].reverse();
    const pairs = new Set<string>();
    const first = latest.filter(item => {
      const key = [...item.lanes].sort().join(':');
      if (pairs.has(key)) return false;
      pairs.add(key);
      return true;
    });
    const ranks = new Map(value.overlaps?.map((item, index) => [item.lane, index]));
    const rank = (item: (typeof first)[number]) =>
      Math.min(...item.lanes.map(id => ranks.get(id) ?? Infinity));
    first.sort((a, b) => rank(a) - rank(b));
    const selected = first.slice(0, PEERS_DISPLAY_LIMIT);
    more += first.length - selected.length;
    value.inbox = selected.map(compactOverlapNotice);
  }
  if (value.predictive) {
    value.predictive = [...new Map(value.predictive.map(item => [item.lane, item])).values()];
    more += Math.max(0, value.predictive.length - PEERS_DISPLAY_LIMIT);
    value.predictive.splice(PEERS_DISPLAY_LIMIT);
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
      notice.detail = 'peers {laneId,detail:true} returns exact hunks, evidence, repair and sync lineage';
      if (size(value) > PEERS_MAX_BYTES) {
        delete notice.evidence;
        delete notice.resolutions;
        delete notice.syncs;
      }
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
    const limit = key === 'overlaps' ? PEERS_DISPLAY_LIMIT : 5;
    more += Math.max(0, items.length - limit);
    items.splice(limit);
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
                : value.conflicts?.length
                  ? value.conflicts
                  : value.overlaps;
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
