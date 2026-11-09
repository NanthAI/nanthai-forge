// SPDX-License-Identifier: Apache-2.0
import { contractDelta, dependentOn, ContractResyncError } from './contract-deps.js';
import { CODE_FILE } from './contract-exports.js';
import { laneNeedsContractSync } from './contract-packages.js';
import type { NativeSource } from './native-source.js';
import type { WorkData, WorkView } from './work-types.js';

/** An agent may not land a View that predates a main move which changed an export or
 * schema its edited code uses. Satisfied by a View containing the current Channel head:
 * acceptance already needs a passing check on exactly that View. Persons review stale
 * Views themselves and are not gated. */
export function assertContractsSynced(
  source: NativeSource,
  data: WorkData,
  channel: string,
  view: WorkView,
  previous: string | null,
) {
  if (!previous || !view.head || source.contains(view.head, previous)) return;
  // Newest accepted main the View already contains; later moves are what it lacks.
  const included = [...data.channelMoves]
    .reverse()
    .find(
      move =>
        move.channel === channel && move.status === 'accepted' && source.contains(view.head!, move.head),
    );
  const since = included?.head ?? view.composedMain ?? view.base;
  if (since === previous || !source.contains(previous, since)) return;
  const pivot = source.state(since).files,
    lane = source.state(view.head).files,
    main = source.state(previous).files,
    delta = contractDelta(source, pivot, main),
    before = new Map(pivot.map(file => [file.path, file.blob])),
    mine = lane.filter(file => CODE_FILE.test(file.path) && before.get(file.path) !== file.blob),
    used = delta.length ? dependentOn(source, mine, lane, delta) : [];
  if (used.length) throw new ContractResyncError(used, previous);
  // Code without import-level facts (Go, Python, Java, Rust, C#, …): by package, through the manifest graph.
  const packaged = laneNeedsContractSync(source, pivot, main, lane);
  if (packaged) throw new ContractResyncError(packaged.changes, previous, packaged.reason);
}
