// SPDX-License-Identifier: Apache-2.0
import type { MoveRecord } from '../cockpit/now-model';
/** Retained Channel order is authoritative; clocks are display metadata. */
export function latestAcceptedMain<T extends MoveRecord>(
  moves: readonly T[],
  selected?: { head: string },
): T | undefined {
  return moves
    .filter(
      move =>
        move.channel === 'main' &&
        (move.status === undefined || move.status === 'accepted') &&
        (!selected || ('head' in move && move.head === selected.head)),
    )
    .at(-1);
}

/** Native Channels track the canonical owner's main; hosted selections remain authoritative for Git. */
export function selectedMain(
  channels: readonly { name: string; head: string; moveId?: string }[],
  hosted: readonly (MoveRecord & { head: string })[],
  sourceKind?: string,
) {
  const native = channels.find(channel => channel.name === 'main');
  const selection = hosted.find(move => move.channel === 'main');
  return sourceKind === 'native' ? (native ?? selection) : (selection ?? native);
}
