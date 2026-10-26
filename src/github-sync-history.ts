// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { sourceExclusion } from './files.js';
import type { NativeSource, NativeFile } from './native-source.js';
import type { WorkData, Lane, ChannelMove } from './work-types.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import { readRecordPage } from './work-records.js';
import { workGit } from './work-git.js';
import type { GithubSyncCommit } from './github-sync-types.js';
import type { GithubHistoryTarget, GithubHistoryProof } from './github-sync-reconcile.js';

/** Only the pinned acceptance interval and its accepted Lane saves are candidates.
 * Read immutable pages/selected histories, never enumerate all source objects. */
export function githubHistoryContainment(
  root: string,
  source: NativeSource,
  snapshot: { data: WorkData; records: WorkRecordTransaction | undefined },
  baseline: GithubSyncCommit | undefined,
  latest: GithubSyncCommit,
  targets: GithubHistoryTarget[],
  excludePrivate = false,
): GithubHistoryProof[] {
  if (!baseline) return [];
  const { data, records } = snapshot,
    position = (id: string) =>
      records
        ? records.positions('channelMoves', id)[0]
        : data.channelMoves.findIndex(move => move.id === id),
    start = position(baseline.acceptanceId),
    end = position(latest.acceptanceId);
  if (start === undefined || end === undefined || start < 0 || end <= start) return [];
  const baseMove = records ? records.at('channelMoves', start) : data.channelMoves[start]!,
    cutoff = Date.parse(baseMove.at),
    stateCutoff = Date.parse(source.state(baseline.state).at),
    pending = new Map(
      targets
        .filter(({ entry }) => !entry || ['100644', '100755', '120000'].includes(entry.mode))
        .map(({ path, entry }) => [
          path,
          entry
            ? {
                mode: entry.mode,
                blob: digest(workGit(root, ['cat-file', 'blob', entry.object], undefined, false, true)),
              }
            : undefined,
        ]),
    ),
    proofs: GithubHistoryProof[] = [];
  if (baseMove.head !== baseline.state || !Number.isFinite(cutoff) || !Number.isFinite(stateCutoff))
    return [];
  // Native history has no gitlinks. Keep their original per-path refusal rather
  // than trying to read a submodule commit as a file blob.
  if (!pending.size) return [];
  // Traverse only ancestors of this export, stopping at the mapped base and older
  // branches. Keep only requested entries and parents, not full source manifests.
  const states = new Map<string, { parents: string[]; files: Map<string, NativeFile> }>(),
    visited = new Set<string>(),
    queue = [latest.state];
  while (queue.length) {
    const id = queue.pop()!;
    if (id === baseline.state || visited.has(id)) continue;
    visited.add(id);
    const state = source.state(id);
    if (!(Date.parse(state.at) >= stateCutoff)) continue;
    states.set(id, {
      parents: state.parents,
      files: new Map(state.files.filter(file => pending.has(file.path)).map(file => [file.path, file])),
    });
    queue.push(...state.parents);
  }
  const ancestors = (head: string) => {
    const result = new Set<string>(),
      queue = [head];
    while (queue.length) {
      const id = queue.pop()!,
        state = states.get(id);
      if (!state || result.has(id)) continue;
      result.add(id);
      queue.push(...state.parents);
    }
    return result;
  };
  const prove = (state: string, evidence: Omit<GithubHistoryProof, 'path' | 'state'>) => {
    const files = states.get(state)?.files;
    if (!files) return;
    for (const [path, target] of pending) {
      const file = excludePrivate && sourceExclusion(path) ? undefined : files.get(path),
        mode = file?.mode === 'symlink' ? '120000' : file?.mode === 'executable' ? '100755' : '100644';
      if (target ? !file || target.blob !== file.blob || target.mode !== mode : !!file) continue;
      proofs.push({ ...evidence, path, state });
      pending.delete(path);
    }
  };
  // Newest first, in bounded pages, stopping as soon as every path is proven.
  for (let stop = end + 1; stop > start + 1 && pending.size;) {
    const offset = Math.max(start + 1, stop - 50),
      moves = records
        ? (readRecordPage(records.directory, records.manifest, 'channelMoves', offset, stop - offset)
            .records as ChannelMove[])
        : data.channelMoves.slice(offset, stop);
    for (const move of moves.reverse()) {
      if (move.channel !== 'main' || move.status !== 'accepted' || !states.has(move.head)) continue;
      const evidence = { acceptanceId: move.id, viewId: move.viewId };
      prove(move.head, { ...evidence, kind: 'accepted-main' });
      if (!pending.size) break;
      const view: WorkData['views'][number] | undefined = records
        ? records.find('views', move.viewId)?.record
        : data.views.find(view => view.id === move.viewId);
      if (view?.status !== 'clean' || view.head !== move.head) continue;
      for (const input of view.inputs) {
        const selected = records?.fields('lanes', input.laneId),
          lane = selected?.record ?? data.lanes.find(lane => lane.id === input.laneId);
        if (!lane) continue;
        const accepted = ancestors(input.head),
          count = selected?.counts.checkpoints ?? lane.checkpoints.length;
        for (let checkpoint = count - 1; checkpoint >= 0 && pending.size; checkpoint--) {
          const save = selected
            ? (records!.fieldAt(
                'lanes',
                selected.position,
                'checkpoints',
                checkpoint,
              ) as Lane['checkpoints'][number])
            : lane.checkpoints[checkpoint]!;
          if (Date.parse(save.at) < cutoff) break;
          if (save.head === baseline.state || !accepted.has(save.head)) continue;
          prove(save.head, { ...evidence, kind: 'accepted-lane-checkpoint', laneId: lane.id, checkpoint });
        }
      }
      if (!pending.size) break;
    }
    stop = offset;
  }
  return proofs;
}
