// SPDX-License-Identifier: Apache-2.0
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
import { performance } from 'node:perf_hooks';
import { PeersCache } from './agent-peers-cache.js';
import { pageHashes, pageSize } from './work-records.js';
import { NativeAncestry } from './native-ancestry.js';
import { PeersSource } from './agent-peers-source.js';
import {
  moveDelta,
  scopedCode,
  usedByLane,
  type ContractDependent,
  type LandedContracts,
} from './agent-peers-contracts.js';
import { contractDelta, dependentOn, type ContractChange } from './contract-deps.js';
import { changedPaths } from './agent-sync.js';
import { pathsOverlap } from './coordination-paths.js';
import { overlappingPaths } from './native-source.js';
import { safeRelative } from './files.js';
import { ForgeError, invariant } from './errors.js';
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
};
type Landed = {
  head: string;
  by?: string;
  paths: string[];
  more?: number;
  sync: 'clean' | 'conflict' | 'unknown';
};
export type PeersDigest = {
  clear?: true;
  v?: 1;
  coverage?: 'local' | 'local-incomplete';
  notices?: { text: string }[];
  conflicts?: ConflictNotice[];
  overlaps?: Overlap[];
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
const clip = (value: string) => value.slice(0, 200);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Advisory observation only: no locks, network, Work writes or source publication.
 * Two seconds of cooperative read budget; incomplete observations never claim clear. */
export function agentPeers(store: WorkStore, input: z.input<typeof peersInputSchema>): PeersDigest {
  const command = peersInputSchema.parse(input);
  return store.observing(() => readPeers(store, command));
}
function readPeers(store: WorkStore, input: z.input<typeof peersInputSchema>): PeersDigest {
  const command = peersInputSchema.parse(input),
    started = performance.now();
  const result: PeersDigest = { v: 1, coverage: 'local', overlaps: [], landed: [], conflicts: [] };
  const tick = () =>
    invariant(performance.now() - started < 2000, 'PEERS_BUDGET', 'Local peers read budget elapsed.');
  try {
    const tx = store.readRecords(),
      legacy = tx ? undefined : store.load();
    const lane =
      tx?.fields('lanes', command.laneId)?.record ?? legacy?.lanes.find(item => item.id === command.laneId);
    invariant(lane, 'NOT_FOUND', 'Peers Lane not found.');
    const notices =
      store
        .select('intents', lane.intentId)
        ?.notes.filter(note => note.text.startsWith('Automatic compensating revert '))
        .map(note => ({ text: note.text })) ?? [];
    if (notices.length) result.notices = notices;
    const source = new PeersSource(store, tick, lane.base),
      base = source.state(lane.base).files;
    const journal = new CoordinationJournal(store),
      cache = new PeersCache(store.root);
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
          ...(result.notices ? { notices: result.notices } : {}),
        },
        command.detail,
      );
    if (!scope.length) return result.notices?.length ? boundPeers(result, command.detail) : { clear: true };
    const moves: ChannelMove[] = [];
    if (tx) {
      for (const position of tx.positions('channelMoves', 'main', 'channel').reverse()) {
        tick();
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
    if (main && !ancestry.contains(lane.head, main)) {
      const since = moves.filter(move => move.status === 'accepted' && move.channel === 'main').reverse();
      for (const move of since) {
        tick();
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
        const sync = merged.conflicts.length || overlappingPaths(merged.files).length ? 'conflict' : 'clean';
        for (const item of result.landed!) item.sync = sync;
        const move = [...moves].reverse().find(item => item.head === main && item.status === 'accepted');
        const view =
          move && (tx?.find('views', move.viewId)?.record ?? legacy?.views.find(v => v.id === move.viewId));
        const acceptedLaneId = view?.inputs[0]?.laneId;
        const acceptedLane =
          acceptedLaneId &&
          (tx?.fields('lanes', acceptedLaneId)?.record ?? legacy?.lanes.find(l => l.id === acceptedLaneId));
        const accepted = acceptedLane ? noticeParticipant(store, source, acceptedLane) : undefined;
        addNotice(
          conflictNotice(
            source,
            [
              self(),
              {
                ...accepted,
                lane: 'main',
                head: main,
                intentId: accepted?.intentId ?? view?.intentId ?? '',
                intent: accepted?.intent ?? 'Accepted main',
                owner: move?.acceptedBy ?? accepted?.owner ?? null,
                sessions: accepted?.sessions ?? [],
                message: source.state(main).message,
                state: 'ready',
                startedAt: move?.at ?? '',
              },
            ],
            liveHead,
            main,
            merged.conflicts,
            overlappingPaths(merged.files),
          ),
        );
        result.next = `sync: ${result.landed!.length} landed changes touch your paths (${sync})`;
      }
    }
    if (result.contracts?.length)
      result.next = `sync and recheck: main changed ${result.contracts.reduce((n, item) => n + item.changes.length, 0)} contract(s) you use`;
    const count = tx?.manifest.collections.lanes?.count ?? legacy!.lanes.length;
    let page: Lane[] = [];
    const peers: Lane[] = [];
    for (let index = 0; index < count; index++) {
      tick();
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
            tick();
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
    peers.sort((a, b) => compare(a.id, b.id));
    // Contracts I changed that other open Lanes use: told again when I land.
    const own = contractDelta(source, base, live);
    if (command.detail && own.length) result.changes = own;
    if (own.length)
      for (const peer of peers.slice(0, 20)) {
        tick();
        if (lane.head !== lane.base && ancestry.contains(peer.head, lane.head)) continue;
        try {
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
        } catch (error) {
          if (error instanceof ForgeError && error.code === 'PEERS_BUDGET') throw error;
          result.coverage = 'local-incomplete';
        }
      }
    if (peers.length > 20 && own.length) result.coverage = 'local-incomplete';
    for (const peer of peers) {
      tick();
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
          const ancestry =
            peer.base === lane.base ? source.ancestry() : new NativeAncestry(id => source.state(id).parents);
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
          via: paths.some(path => edited.some(item => pathsOverlap(path, item))) ? 'edit' : 'scope',
        });
      } catch (error) {
        if (error instanceof ForgeError && error.code === 'PEERS_BUDGET') throw error;
        result.coverage = 'local-incomplete';
      }
    }
  } catch (error) {
    result.coverage = 'local-incomplete';
    result.next =
      error instanceof ForgeError && error.code === 'PEERS_BUDGET'
        ? 'Local peers read budget elapsed; retry peers for a fresh observation.'
        : 'Some local peer source is unavailable; retry peers for a fresh observation.';
  }
  if (!result.conflicts?.length) delete result.conflicts;
  if (
    result.coverage === 'local' &&
    !result.overlaps!.length &&
    !result.landed!.length &&
    !result.contracts?.length &&
    !result.dependents?.length &&
    !result.ownership &&
    !result.stalled?.length &&
    !result.conflicts?.length &&
    !result.notices?.length
  )
    return { clear: true };
  return boundPeers(result, command.detail);
}
