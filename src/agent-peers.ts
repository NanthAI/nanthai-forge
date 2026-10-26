import { retainIndexedPeers } from './agent-receipt-peers.js';
import { integrationPreviewStatus } from './integration-preview-auto.js';
// SPDX-License-Identifier: Apache-2.0
import { stackStatus } from './agent-stack.js';
import { readHandoff } from './agent-handoff.js';
import { handoffSummary } from './agent-handoff-types.js';
import type { OverlapAlert } from './agent-overlap-alerts.js';
import { z } from 'zod';
import { laneOwnership, stalledLane } from './agent-ownership.js';
import { readHostState } from './host-binding.js';
import { PRESENCE } from './presence.js';
import {
  conflictNotice,
  noticeParticipant,
  type ConflictNotice,
  type NoticeParticipant,
} from './agent-conflict-notice.js';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { PeersCache } from './agent-peers-cache.js';
import { pageHashes, pageSize } from './work-records.js';
import { PeersSource, RECEIPT_ANCESTRY_READS } from './agent-peers-source.js';
import { regionSummary } from './agent-region-summary.js';
import { rankPeerLanes } from './agent-peer-ranking.js';
import { landingConflictPeers } from './landing-conflict-peers.js';
import { predictiveOverlaps, type PredictiveOverlap } from './agent-predictive-overlap.js';
import {
  moveDelta,
  scopedCode,
  usedByLane,
  type ContractDependent,
  type LandedContracts,
} from './agent-peers-contracts.js';
import { dependentOn, type ContractChange } from './contract-deps.js';
import { changedPaths } from './agent-sync.js';
import { pathsOverlap } from './coordination-paths.js';
import { overlappingPaths } from './native-source.js';
import { safeRelative } from './files.js';
import { invariant } from './errors.js';
import { nativeChannels } from './native-work.js';
import { channelStatus } from './work-channel.js';
import type { WorkStore } from './work-store.js';
import type { Lane, ChannelMove, WorkData } from './work-types.js';

export const peersScopeSchema = z.object({ paths: z.array(z.string().refine(safeRelative)).default([]) });
export const peersInputSchema = z.object({
  laneId: z.string().uuid(),
  scope: peersScopeSchema.optional(),
  detail: z.boolean().default(false),
});
type Overlap = {
  lane: string;
  actor?: string;
  intent?: string;
  state: string;
  paths: string[];
  more?: number;
  via: 'edit' | 'scope';
  claim?: 'planned' | 'editing' | 'stale';
  risk?: 'low' | 'medium';
};
type Landed = {
  head: string;
  by?: string;
  paths: string[];
  more?: number;
  sync: 'clean' | 'conflict' | 'unknown';
};
export type PeersDigest = {
  stack?: ReturnType<typeof stackStatus>;
  integration?: string | undefined;
  handoff?: ReturnType<typeof handoffSummary>;
  clear?: true;
  v?: 1;
  coverage?: 'local' | 'local-incomplete';
  notices?: { text: string }[];
  conflicts?: ConflictNotice[];
  inbox?: Pick<
    OverlapAlert,
    'noticeId' | 'kind' | 'lanes' | 'file' | 'proposedOrder' | 'text' | 'participants'
  >[];
  overlaps?: Overlap[];
  /** My live regions versus selected in-flight peer checkpoints; coverage names gaps. */
  predictive?: PredictiveOverlap[];
  ownership?: ReturnType<typeof laneOwnership>;
  stalled?: { lane: string; actor: string; quietMs: number; offer: 'take' }[];
  landed?: Landed[];
  /** Main changed exports/schemas this Lane uses: sync and recheck before landing. */
  contracts?: LandedContracts[];
  /** Open Lanes that use contracts this Lane changes; told when it lands. */
  dependents?: ContractDependent[];
  /** Detail only: this Lane's own contract delta against its base. */
  changes?: ContractChange[];
  more?: number;
  next?: string;
};
export { PEERS_MAX_BYTES, boundPeers } from './agent-peers-bound.js';
import { boundPeers } from './agent-peers-bound.js';
// Lifecycle receipts bound full live dependency reads and unrelated advice.
// Saved path candidates are all analyzed; this is not an overlap/source limit.
export const RECEIPT_PEER_LIMIT = 3;
const clip = (value: string) => value.slice(0, 200);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Advisory observation only: no locks, network, Work writes or source publication.
 * Lifecycle calls bound expensive advice; explicit reads finish their selected work.
 * Unavailable or deferred analysis never claims clear. */
export function agentPeers(
  store: WorkStore,
  input: z.input<typeof peersInputSchema>,
  options: { receipt?: boolean } = {},
): PeersDigest {
  const command = peersInputSchema.parse(input);
  return store.observing(() => {
    const peers = readPeers(store, command, options.receipt);
    try {
      retainIndexedPeers(store, command.laneId, peers);
    } catch {
      // An optional cache cannot invalidate an otherwise usable observation.
    }
    return peers;
  });
}
function readPeers(store: WorkStore, input: z.input<typeof peersInputSchema>, receipt = false): PeersDigest {
  const command = peersInputSchema.parse(input);
  const result: PeersDigest = { v: 1, coverage: 'local', overlaps: [], landed: [], conflicts: [] };
  try {
    const tx = store.readRecords(),
      legacy = tx ? undefined : store.load();
    const lane =
      tx?.fields('lanes', command.laneId)?.record ?? legacy?.lanes.find(item => item.id === command.laneId);
    invariant(lane, 'NOT_FOUND', 'Peers Lane not found.');
    // Read the bilateral inbox before source analysis: an unavailable/deferred
    // tree must not hide alerts raised by another agent's last save.
    const journal = new CoordinationJournal(store);
    const inbox = journal.overlaps(lane.id);
    if (inbox.length) result.inbox = inbox;
    if (lane.stack) result.stack = stackStatus(store, lane);
    const integration = integrationPreviewStatus(store);
    if (integration) result.integration = integration;
    const handoff = readHandoff(store, lane.id).result.handoff;
    if (handoff) result.handoff = handoffSummary(handoff);
    const notices =
      store
        .select('intents', lane.intentId)
        ?.notes.filter(note => note.text.startsWith('Automatic compensating revert '))
        .map(note => ({ text: note.text })) ?? [];
    // Retained integration results name saved pins; later saves/main clear current advice.
    const retainedNotices = new CoordinationJournal(store).context(lane.id).notices;
    const integrationNotices = retainedNotices.filter(n => n.integration);
    result.conflicts!.push(
      ...retainedNotices.filter(
        n =>
          (n.integration || n.evidence?.some(e => e.kind === 'check') || n.resolutions?.length) &&
          (command.detail || n.applicability !== 'historical'),
      ),
    );
    notices.push(
      ...retainedNotices
        .filter(
          n =>
            !n.integration && n.evidence?.some(e => e.kind === 'check') && n.applicability !== 'historical',
        )
        .map(n => ({ text: n.reason })),
    );
    const previewMain = integrationNotices.length
      ? store.native
        ? (tx ? tx.all('channelMoves', 'main', 'channel') : legacy!.channelMoves)
            .filter(move => move.channel === 'main' && move.status === 'accepted')
            .at(-1)?.head
        : channelStatus(store, legacy ?? store.load()).find(channel => channel.name === 'main')?.head
      : undefined;
    notices.push(
      ...integrationNotices
        .filter(
          n =>
            n.integration!.main === previewMain &&
            n.integration!.applicability === 'current' &&
            n.participants.every(
              p =>
                (tx?.fields('lanes', p.lane)?.record.head ??
                  legacy?.lanes.find(l => l.id === p.lane)?.head) === p.head,
            ),
        )
        .map(n => ({ text: n.reason })),
    );
    if (notices.length) result.notices = notices;
    const source = new PeersSource(store, lane.base, receipt ? RECEIPT_ANCESTRY_READS : Infinity),
      base = source.state(lane.base).files;
    const cache = new PeersCache(store.root);
    let participant: NoticeParticipant | undefined;
    const self = () => (participant ??= noticeParticipant(store, source, lane));
    const addNotice = (notice: ConflictNotice | undefined) => {
      if (notice) result.conflicts!.push(journal.decorate(notice, lane.id));
    };
    const live = source.live(lane),
      edited = changedPaths(base, live);
    const liveHead = source.writeState(live, [lane.head], 'Peers preview', '');
    const scope = [
      ...new Set([...edited, ...(lane.scope?.paths ?? []), ...(command.scope?.paths ?? [])]),
    ].sort();
    const presence = readHostState(store).presence;
    if (lane.owner) result.ownership = laneOwnership(store, lane, Date.now(), presence);
    // No path relevance is knowable on a pristine Lane without declared paths.
    if (result.ownership && !scope.length)
      return boundPeers(
        {
          v: 1,
          coverage: 'local',
          ownership: result.ownership,
          ...(result.stack ? { stack: result.stack } : {}),
          ...(result.integration ? { integration: result.integration } : {}),
          ...(result.handoff ? { handoff: result.handoff } : {}),
          ...(result.notices ? { notices: result.notices } : {}),
          ...(result.inbox ? { inbox: result.inbox } : {}),
          ...(result.conflicts?.length ? { conflicts: result.conflicts } : {}),
        },
        command.detail,
      );
    if (!scope.length)
      return result.conflicts?.length ||
        result.notices?.length ||
        result.inbox?.length ||
        result.handoff ||
        result.integration ||
        result.stack
        ? boundPeers(result, command.detail)
        : { clear: true };
    const moves: ChannelMove[] = [];
    if (tx) {
      for (const position of tx.positions('channelMoves', 'main', 'channel').reverse()) {
        const move = tx.fieldsAt('channelMoves', position).record;
        moves.push(move);
        if (move.status === 'accepted' && move.head === lane.base) break;
      }
      moves.reverse();
    } else moves.push(...legacy!.channelMoves);
    const channels = store.native
      ? nativeChannels({ ...tx?.data(), ...legacy, channelMoves: moves } as WorkData)
      : channelStatus(store, legacy ?? store.load());
    const main = channels.find(item => item.name === 'main')?.head;
    const ancestry = source.ancestry();
    const mainFiles = main ? new Map(source.files(main, scope).map(file => [file.path, file])) : undefined;
    try {
      if (main && !ancestry.contains(lane.head, main)) {
        const since = moves.filter(move => move.status === 'accepted' && move.channel === 'main').reverse();
        for (const move of since) {
          if (ancestry.contains(lane.base, move.head)) break;
          const before = move.previous ?? lane.base;
          const paths = changedPaths(source.state(before).files, source.state(move.head).files).filter(path =>
            scope.some(item => pathsOverlap(path, item)),
          );
          if (ancestry.contains(lane.head, move.head)) continue;
          const used = usedByLane(
            source,
            moveDelta(source, cache, before, move.head, () => [
              source.state(before).files,
              source.state(move.head).files,
            ]),
            scopedCode(live, scope),
            live,
          );
          if (used.length)
            (result.contracts ??= []).push({
              head: move.head,
              ...(move.acceptedBy?.name ? { by: clip(move.acceptedBy.name) } : {}),
              changes: used,
            });
          if (!paths.length) continue;
          result.landed!.push({
            head: move.head,
            ...(move.acceptedBy?.name ? { by: clip(move.acceptedBy.name) } : {}),
            paths,
            sync: 'unknown',
          });
        }
        if (result.landed!.length) {
          // A synthetic State preserves dirty bytes and the real Lane's ancestry.
          const merged = source.mergeFiles(liveHead, main);
          const sync =
            merged.conflicts.length || overlappingPaths(merged.files).length ? 'conflict' : 'clean';
          for (const item of result.landed!) item.sync = sync;
          const conflictPaths = [
            ...merged.conflicts.map(item => item.path),
            ...overlappingPaths(merged.files),
          ];
          const acceptedIds = landingConflictPeers(
            store,
            main,
            [{ laneId: lane.id, head: lane.head }],
            conflictPaths,
          );
          const acceptedLanes = acceptedIds.flatMap(id => {
            const accepted = tx?.fields('lanes', id)?.record ?? legacy?.lanes.find(l => l.id === id);
            return accepted ? [accepted] : [];
          });
          for (const acceptedLane of acceptedLanes.length ? acceptedLanes : [undefined]) {
            const accepted = acceptedLane ? noticeParticipant(store, source, acceptedLane) : undefined;
            addNotice(
              conflictNotice(
                source,
                [
                  self(),
                  {
                    ...accepted,
                    lane: accepted?.lane ?? 'main',
                    head: main,
                    intentId: accepted?.intentId ?? '',
                    intent: accepted?.intent ?? 'Accepted main',
                    owner: accepted?.owner ?? null,
                    sessions: accepted?.sessions ?? [],
                    message: source.state(main).message,
                    state: 'ready',
                    startedAt: accepted?.startedAt ?? '',
                  },
                ],
                liveHead,
                main,
                merged.conflicts,
                overlappingPaths(merged.files),
              ),
            );
          }
          result.next = `sync: ${result.landed!.length} landed changes touch your paths (${sync})`;
        }
      }
    } catch {
      result.coverage = 'local-incomplete';
      result.next =
        'Main source analysis unavailable or deferred; peers {laneId,detail:true} returns full advice.';
    }
    if (result.contracts?.length)
      result.next = `sync and recheck: main changed ${result.contracts.reduce((n, item) => n + item.changes.length, 0)} contract(s) you use`;
    const count = tx?.manifest.collections.lanes?.count ?? legacy!.lanes.length;
    let page: Lane[] = [];
    const peers: Lane[] = [];
    for (let index = 0; index < count; index++) {
      if (tx && index % pageSize === 0) {
        const key = `lane-fields-v1:${tx.manifest.collections.lanes!.pages[Math.floor(index / pageSize)]}`;
        page = cache.read<Lane[]>(key) ?? [];
        if (page.length !== Math.min(pageSize, count - index)) {
          const slotKey = `lane-page-slot-v1:${Math.floor(index / pageSize)}`;
          const hashes = pageHashes(
            store.directory,
            tx.manifest.collections.lanes!.pages[Math.floor(index / pageSize)]!,
          );
          invariant(
            hashes.length === Math.min(pageSize, count - index),
            'INVALID_WORK_STORE',
            'Peers Lane page is incomplete.',
          );
          const prior = cache.read<{ hashes: string[]; records: Lane[] }>(slotKey);
          page = hashes.map((hash, offset) => {
            return prior?.hashes[offset] === hash && prior.records[offset]
              ? prior.records[offset]!
              : tx.fieldsAt('lanes', index + offset).record;
          });
          cache.write(slotKey, { hashes, records: page });
          cache.write(key, page);
        }
      }
      const peer = tx ? page[index % pageSize]! : legacy!.lanes[index]!;
      if (peer.id !== lane.id && ['active', 'paused', 'ready'].includes(peer.state)) peers.push(peer);
    }
    let composed = 0;
    const ranking = rankPeerLanes(source, cache, scope, peers);
    peers.splice(0, peers.length, ...ranking.ranked);
    if (ranking.incomplete) result.coverage = 'local-incomplete';
    const advicePeers = receipt
      ? peers.filter((peer, index) => ranking.shared.has(peer.id) || index < RECEIPT_PEER_LIMIT)
      : peers;
    const deferred = peers.length - advicePeers.length;
    if (deferred) {
      result.coverage = 'local-incomplete';
      result.next = 'Additional peer analysis deferred; peers {laneId,detail:true} returns full advice.';
    }
    // Contracts I changed that other open Lanes use: told again when I land.
    const ownSummary = regionSummary(source, cache, lane.base, liveHead, () => [base, live]);
    const own = ownSummary.contracts;
    const fullAncestry = source.ancestry('');
    for (const peer of advicePeers) {
      try {
        if (
          main &&
          !(peer.head !== main && ancestry.contains(peer.head, main)) &&
          fullAncestry.contains(main, peer.head)
        )
          continue;
        const theirs = regionSummary(source, cache, peer.base, peer.head, () => [
          source.state(peer.base).files,
          source.state(peer.head).files,
        ]);
        const predictions = predictiveOverlaps(source, cache, lane, ownSummary, peer, theirs);
        if (!predictions.length) continue;
        const intent = store.select('intents', peer.intentId)?.outcome;
        for (const item of predictions) {
          if (intent) item.intent = clip(intent);
          if (item.risk === 'unknown') result.coverage = 'local-incomplete';
        }
        (result.predictive ??= []).push(...predictions);
      } catch {
        result.coverage = 'local-incomplete';
      }
    }
    if (command.detail && own.length) result.changes = own;
    if (own.length)
      for (const peer of advicePeers.slice(0, receipt ? RECEIPT_PEER_LIMIT : 20)) {
        try {
          if (lane.head !== lane.base && ancestry.contains(peer.head, lane.head)) continue;
          // Dirty bytes count: an unsaved edit that imports a changed export already depends on it.
          const theirs = source.live(peer),
            edits = changedPaths(source.state(peer.base).files, theirs),
            claims = [...edits, ...(peer.scope?.paths ?? [])],
            uses = dependentOn(source, scopedCode(theirs, claims), theirs, own);
          if (!uses.length) continue;
          const actor = laneOwnership(store, peer, Date.now(), presence)?.actor,
            intent = store.select('intents', peer.intentId)?.outcome;
          (result.dependents ??= []).push({
            lane: peer.id,
            ...(actor ? { actor: clip(actor) } : {}),
            ...(intent ? { intent: clip(intent) } : {}),
            state: peer.state === 'active' ? 'working' : peer.state,
            uses: uses.slice(0, 3),
            ...(uses.length > 3 ? { more: uses.length - 3 } : {}),
          });
        } catch {
          result.coverage = 'local-incomplete';
        }
      }
    if (peers.length > 20 && own.length) result.coverage = 'local-incomplete';
    for (const peer of peers) {
      try {
        const livePeer = source.live(peer, scope),
          liveFiles = new Map(livePeer.map(file => [file.path, file]));
        const paths = changedPaths(source.files(peer.base, scope), livePeer).filter(path => {
          if (!scope.some(item => pathsOverlap(path, item))) return false;
          const current = liveFiles.get(path),
            accepted = mainFiles?.get(path);
          return !mainFiles || current?.blob !== accepted?.blob || current?.mode !== accepted?.mode;
        });
        const unlandedEdits = paths.length > 0;
        const planned = (peer.scope?.paths ?? []).filter(path =>
          scope.some(item => pathsOverlap(path, item)),
        );
        paths.push(...planned.filter(path => !paths.includes(path)));
        if (!paths.length) continue;
        const ownership = laneOwnership(store, peer, Date.now(), presence);
        const stalled = stalledLane(
          store,
          peer,
          ownership,
          unlandedEdits || (peer.head !== peer.base && (!main || !ancestry.contains(main, peer.head))),
        );
        if (stalled) (result.stalled ??= []).push(stalled);
        if (composed < 3 && paths.some(path => edited.some(item => pathsOverlap(path, item)))) {
          composed++;
          // Overlay relevant dirty bytes onto the peer's full saved tree; ancestry
          // remains exact and unrelated paths cannot create false deletions.
          const saved = source.state(peer.head).files;
          const selected = new Set([
            ...source.files(peer.head, scope).map(f => f.path),
            ...livePeer.map(f => f.path),
          ]);
          const files = [...saved.filter(f => !selected.has(f.path)), ...livePeer].sort((a, b) =>
            compare(a.path, b.path),
          );
          const peerHead = source.writeState(files, [peer.head], 'Peers preview', '');
          // Canonical orientation gives both participants the same notice and hunk labels.
          const first = lane.id < peer.id;
          const left = first ? liveHead : peerHead,
            right = first ? peerHead : liveHead;
          const ancestry = peer.base === lane.base ? source.ancestry() : source.ancestry('');
          const merged = source.mergeFiles(left, right, undefined, undefined, ancestry);
          addNotice(
            conflictNotice(
              source,
              first
                ? [self(), noticeParticipant(store, source, peer)]
                : [noticeParticipant(store, source, peer), self()],
              left,
              right,
              merged.conflicts,
              overlappingPaths(merged.files),
            ),
          );
        } else if (composed >= 3 && paths.some(path => edited.some(item => pathsOverlap(path, item))))
          result.coverage = 'local-incomplete';
        const intentKey = tx
          ? `intent-v2:${peer.intentId}:${JSON.stringify(tx.manifest.collections.intents)}`
          : undefined;
        const cachedIntent = intentKey ? cache.read<{ outcome: string }>(intentKey) : undefined;
        const intent =
          cachedIntent ??
          tx?.fields('intents', peer.intentId)?.record ??
          legacy?.intents.find(item => item.id === peer.intentId);
        if (intentKey && intent && !cachedIntent) cache.write(intentKey, { outcome: intent.outcome });
        result.overlaps!.push({
          lane: peer.id,
          ...(ownership?.actor ? { actor: clip(ownership.actor) } : {}),
          ...(intent ? { intent: clip(intent.outcome) } : {}),
          state: peer.state === 'active' ? 'working' : peer.state,
          paths,
          claim:
            ownership?.quietMs !== undefined && ownership.quietMs > PRESENCE.foldMs
              ? 'stale'
              : unlandedEdits
                ? 'editing'
                : 'planned',
          risk: unlandedEdits ? 'medium' : 'low',
          via: paths.some(path => edited.some(item => pathsOverlap(path, item))) ? 'edit' : 'scope',
        });
      } catch {
        result.coverage = 'local-incomplete';
      }
    }
  } catch {
    result.coverage = 'local-incomplete';
    result.next = 'Some local peer source is unavailable; retry peers for a fresh observation.';
  }
  if (result.conflicts?.length)
    result.conflicts = [...new Map(result.conflicts.map(notice => [notice.noticeId, notice])).values()];
  else delete result.conflicts;
  if (
    result.coverage === 'local' &&
    !result.overlaps!.length &&
    !result.predictive?.length &&
    !result.landed!.length &&
    !result.contracts?.length &&
    !result.dependents?.length &&
    !result.ownership &&
    !result.stalled?.length &&
    !result.conflicts?.length &&
    !result.notices?.length &&
    !result.inbox?.length &&
    !result.handoff &&
    !result.integration &&
    !result.stack
  )
    return { clear: true };
  return boundPeers(result, command.detail);
}
