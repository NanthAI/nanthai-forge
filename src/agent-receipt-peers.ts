import { withPeerLanding } from './peer-landing.js';
// SPDX-License-Identifier: Apache-2.0
import { recordMetricOverlapSave } from './self-metrics-overlap.js';
import { changedPaths } from './agent-sync.js';
import { PeersCache } from './agent-peers-cache.js';
import { pathsOverlap } from './coordination-paths.js';
import { laneOwnership } from './agent-ownership.js';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { predictiveOverlaps } from './agent-predictive-overlap.js';
import { PeersSource, RECEIPT_ANCESTRY_READS } from './agent-peers-source.js';
import { regionSummary } from './agent-region-summary.js';
import { dependentOn } from './contract-deps.js';
import { moveDelta, scopedCode, usedByLane } from './agent-peers-contracts.js';
import { boundPeers, type PeersDigest } from './agent-peers.js';
import type { SavedPeerPaths } from './agent-peer-ranking.js';
import type { RegionSummary } from './agent-region-summary.js';
import type { Lane } from './work-types.js';
import type { WorkStore } from './work-store.js';

type Indexed = { base: string; head: string; peers: PeersDigest };

/** Detached analysis publishes an observation, never a delivery. */
export function retainIndexedPeers(store: WorkStore, laneId: string, peers: PeersDigest) {
  const lane = store.select('lanes', laneId, 'id', true);
  if (lane) {
    const cache = new PeersCache(store.root);
    const paths = cache.read<SavedPeerPaths>(`peer-paths-v1:${lane.base}:${lane.head}`);
    if (paths) cache.write(`peer-paths-latest-v1:${laneId}`, paths);
    cache.write(`receipt-peers-v1:${laneId}`, {
      base: lane.base,
      head: lane.head,
      peers,
    } satisfies Indexed);
  }
}

/** Prepare the saved region inventory before publication, outside the owner lock.
 * No workspace scan or peer recomposition belongs on the durable return path. */
export function prepareReceiptSource(store: WorkStore, base: string, head: string) {
  try {
    const source = new PeersSource(store, base);
    regionSummary(source, new PeersCache(store.root), base, head, () => [
      source.state(base).files,
      source.state(head).files,
    ]);
  } catch {
    // Missing analysis remains explicitly incomplete in the receipt.
  }
}

/** Header claims, saved region indexes and committed contract data only. Never
 * scan a workspace, merge source or re-index live peers on the return path. */
export function indexedReceiptPeers(
  store: WorkStore,
  command: { laneId: string; scope?: { paths: string[] } | undefined; detail?: boolean },
  _options?: { receipt?: boolean },
): PeersDigest {
  try {
    return store.observing(() => {
      const cache = new PeersCache(store.root);
      const indexed = cache.read<Indexed>(`receipt-peers-v1:${command.laneId}`);
      const result: PeersDigest = { ...indexed?.peers, v: 1, coverage: 'local-incomplete' };
      delete result.clear;
      delete result.inbox;
      // No cached advice can establish completeness of current live source.
      // Advice with older self pins stays available through explicit historical reads.
      const tx = store.readRecords();
      const lane =
        tx?.fields('lanes', command.laneId)?.record ??
        (!tx ? store.select('lanes', command.laneId, 'id', true) : undefined);
      if (!lane) return { v: 1, coverage: 'local-incomplete' };
      if (indexed && (indexed.head !== lane.head || indexed.base !== lane.base)) {
        for (const key of ['predictive', 'contracts', 'changes', 'dependents', 'landed'] as const)
          delete result[key];
      }
      const paths = (item: Lane) => {
        const saved = cache.read<SavedPeerPaths>(`peer-paths-v1:${item.base}:${item.head}`);
        const regions = saved ? undefined : cache.read<RegionSummary>(`regions-v1:${item.base}:${item.head}`);
        return [
          ...new Set([
            ...(saved?.paths ??
              regions?.files.map(file => file.path) ??
              cache.read<SavedPeerPaths>(`peer-paths-latest-v1:${item.id}`)?.paths ??
              []),
            ...(item.scope?.paths ?? []),
          ]),
        ];
      };
      const journal = new CoordinationJournal(store);
      const notices = [...(result.conflicts ?? []), ...journal.context(lane.id).notices];
      result.conflicts = [
        ...new Map(notices.map(notice => [notice.noticeId, journal.decorate(notice, lane.id)])).values(),
      ];
      if (!result.conflicts.length) delete result.conflicts;
      const own = paths(lane);
      const scope = [...new Set([...own, ...(command.scope?.paths ?? [])])];
      const peers = tx
        ? Array.from(
            { length: tx.manifest.collections.lanes?.count ?? 0 },
            (_, index) => tx.fieldsAt('lanes', index).record,
          )
        : store.load().lanes;
      result.overlaps = [];
      for (const peer of peers) {
        if (peer.id === lane.id || !['active', 'paused', 'ready'].includes(peer.state)) continue;
        const shared = paths(peer).filter(path => scope.some(item => pathsOverlap(item, path)));
        if (!shared.length) continue;
        const intent =
          tx?.fields('intents', peer.intentId)?.record ??
          (!tx ? store.select('intents', peer.intentId) : undefined);
        const actor = peer.owner?.actor ?? peer.startedBy?.name;
        result.overlaps.push({
          lane: peer.id,
          ...(actor ? { actor } : {}),
          ...(intent ? { intent: intent.outcome } : {}),
          state: peer.state === 'active' ? 'working' : peer.state,
          paths: shared,
          claim: peer.head === peer.base ? 'planned' : 'editing',
          risk: peer.head === peer.base ? 'low' : 'medium',
          via: own.some(path => shared.some(item => pathsOverlap(item, path))) ? 'edit' : 'scope',
        });
      }
      // Predictions use only exact saved region inventories. A dirty peer cannot
      // replace its checkpoint identity in another agent's receipt.
      const source = new PeersSource(store, lane.base, RECEIPT_ANCESTRY_READS);
      const summary = cache.read<RegionSummary>(`regions-v1:${lane.base}:${lane.head}`);
      if (summary) {
        delete result.predictive;
        for (const peer of peers) {
          if (peer.id === lane.id || !['active', 'paused', 'ready'].includes(peer.state)) continue;
          const theirs = cache.read<RegionSummary>(`regions-v1:${peer.base}:${peer.head}`);
          if (!theirs) continue;
          try {
            const predictions = predictiveOverlaps(source, cache, lane, summary, peer, theirs);
            const intent = tx?.fields('intents', peer.intentId)?.record;
            for (const prediction of predictions)
              if (intent) prediction.intent = intent.outcome.slice(0, 200);
            if (predictions.length) (result.predictive ??= []).push(...predictions);
          } catch {
            /* A missing alignment leaves local-incomplete coverage. */
          }
        }
      }
      // Contract advice reads committed source only, never live peer directories.
      // Keep retained advice when committed analysis is temporarily unavailable.
      // A pristine Lane without scope cannot use any relevant changed contract.
      if (scope.length) {
        try {
          const moves = tx ? tx.all('channelMoves', 'main', 'channel') : store.load().channelMoves;
          const main = moves
            .filter(move => move.channel === 'main' && move.status === 'accepted')
            .at(-1)?.head;
          const ancestry = source.ancestry();
          const files = source.state(lane.head).files;
          const contracts: NonNullable<PeersDigest['contracts']> = [];
          if (main && !ancestry.contains(lane.head, main)) {
            for (const move of [...moves].reverse()) {
              if (move.status !== 'accepted' || move.channel !== 'main') continue;
              if (ancestry.contains(lane.base, move.head)) break;
              if (ancestry.contains(lane.head, move.head)) continue;
              const before = move.previous ?? lane.base;
              const changes = usedByLane(
                source,
                moveDelta(source, cache, before, move.head, () => [
                  source.state(before).files,
                  source.state(move.head).files,
                ]),
                scopedCode(files, scope),
                files,
              );
              if (changes.length)
                contracts.push({
                  head: move.head,
                  ...(move.acceptedBy?.name ? { by: move.acceptedBy.name } : {}),
                  changes,
                });
            }
          }
          if (contracts.length) result.contracts = contracts;
          else delete result.contracts;
          if (summary?.contracts.length) {
            delete result.dependents;
            for (const peer of peers) {
              if (peer.id === lane.id || !['active', 'paused', 'ready'].includes(peer.state)) continue;
              if (lane.head !== lane.base && ancestry.contains(peer.head, lane.head)) continue;
              const saved = source.state(peer.head).files;
              const uses = dependentOn(source, scopedCode(saved, paths(peer)), saved, summary.contracts);
              if (!uses.length) continue;
              const intent = tx?.fields('intents', peer.intentId)?.record;
              (result.dependents ??= []).push({
                lane: peer.id,
                ...(peer.owner?.actor ? { actor: peer.owner.actor } : {}),
                ...(intent ? { intent: intent.outcome } : {}),
                state: peer.state === 'active' ? 'working' : peer.state,
                uses,
              });
            }
          }
          if (result.contracts?.length) result.next = 'sync and recheck: main changed contracts you use';
        } catch {
          /* Retained notices and other indexed advice remain available. */
        }
      }
      const ownership = laneOwnership(store, lane);
      if (ownership) result.ownership = ownership;
      return boundPeers(withPeerLanding(store, result), command.detail);
    });
  } catch {
    return { v: 1, coverage: 'local-incomplete' };
  }
}

/** Save metrics compare immutable manifests only; full alert analysis stays detached. */
export async function recordIndexedOverlapSave(store: WorkStore, laneId: string) {
  try {
    // Workflow defaults load the action schemas; keep them out of peer-schema initialization.
    const { currentChannelHead } = await import('./agent-defaults.js');
    store.observing(() => {
      const tx = store.readRecords();
      const open = (
        tx
          ? Array.from(
              { length: tx.manifest.collections.lanes?.count ?? 0 },
              (_, index) => tx.fieldsAt('lanes', index).record,
            )
          : store.load().lanes
      ).filter(lane => ['active', 'paused', 'ready'].includes(lane.state));
      const focus = open.find(lane => lane.id === laneId);
      if (!focus) return;
      const main = currentChannelHead(store, 'main');
      const source = new PeersSource(store, focus.base, RECEIPT_ANCESTRY_READS);
      const recent = source.ancestry(),
        ancestry = source.ancestry('');
      let complete = true;
      const lanes = open.filter(lane => {
        try {
          if (main && lane.head !== main && recent.contains(lane.head, main)) return true;
          return !(main && ancestry.contains(main, lane.head));
        } catch {
          complete = false;
          return false;
        }
      });
      const paths = new Map<string, string[]>();
      for (const lane of [focus, ...lanes]) {
        try {
          const head = source.state(lane.head);
          const base = lane.id === focus.id ? (head.parents[0] ?? lane.base) : lane.base;
          paths.set(lane.id, changedPaths(source.state(base).files, head.files));
        } catch {
          complete = false;
        }
      }
      recordMetricOverlapSave(store.directory, focus, lanes, lane => paths.get(lane.id) ?? [], complete);
    });
  } catch {
    // Optional metrics cannot invalidate the durable checkpoint.
  }
}
