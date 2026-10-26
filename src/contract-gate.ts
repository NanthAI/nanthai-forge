// SPDX-License-Identifier: Apache-2.0
import { contractDelta, dependentOn, ContractResyncError } from './contract-deps.js';
import { CODE_FILE } from './contract-exports.js';
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
    delta = contractDelta(source, pivot, source.state(previous).files);
  if (!delta.length) return;
  const before = new Map(pivot.map(file => [file.path, file.blob])),
    mine = lane.filter(file => CODE_FILE.test(file.path) && before.get(file.path) !== file.blob),
    used = dependentOn(source, mine, lane, delta);
  if (used.length) throw new ContractResyncError(used, previous);
}
