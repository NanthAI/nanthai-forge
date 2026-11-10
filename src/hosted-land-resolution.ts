// SPDX-License-Identifier: Apache-2.0
// `land --save` in a folder that became a resolution Lane (friction 41fc0c29, Issue 30845e65).
// The agent edits the conflict files and lands again, as it would fix and push in Git. Saving that
// edit is the resolution's `resolve`, so land runs it and lands the resolution Lane, instead of
// landing the conflicted origin's pre-resolution head (which re-fails the same conflict after a
// full queue wait) or stopping for one more command. Local reads only until the agent's edit is
// clean; then one resolve (its retained operationId) and the finish it hands out.
import { z } from 'zod';
import {
  inPlaceResolution,
  markedPendingPaths,
  pendingConflictLane,
  pendingConflictPaths,
  rememberResolutionFinish,
  resolutionContinuation,
  resolvedFinishContinuation,
} from './hosted-conflict-precheck.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';

type Command = Record<string, unknown>;
type Dispatch = (action: string, command: Command) => Promise<{ result?: unknown } | undefined>;
/** Fields of the agent's land that ride on the resolution's landing; identity fields never do. */
const CARRIED = ['message', 'priority', 'check', 'accept'] as const;

function resolutionHere(root: string, named: string | undefined) {
  const marker = readHostedLaneCheckout(root);
  const laneId = marker?.selection.laneId;
  if (!laneId) return undefined;
  const origin = named && named !== laneId ? inPlaceResolution(root, named) : undefined;
  if (named && named !== laneId && origin?.laneId !== laneId) return undefined;
  return { laneId, pending: pendingConflictLane(root) === laneId };
}

/** Every conflict file was edited free of markers (a deleted file counts as edited). */
const edited = (root: string, laneId: string) =>
  pendingConflictPaths(root, laneId).length > 0 && markedPendingPaths(root, laneId).length === 0;

/** A continuation's parameters, without the action it names. */
const parametersOf = (next: Command) =>
  Object.fromEntries(Object.entries(next).filter(([key]) => key !== 'action'));

const carried = (command: Command) =>
  Object.fromEntries(CARRIED.filter(key => command[key] !== undefined).map(key => [key, command[key]]));

/** The finish to submit for this land, or undefined to submit the agent's command unchanged.
 * `note` receives one line saying what land did and how to undo it. */
export async function landEditedResolution(
  root: string,
  command: Command,
  dispatch: Dispatch,
  note: (line: string) => void,
): Promise<{ finish: Command } | { response: { result?: unknown } | undefined } | undefined> {
  if (command.operationId !== undefined || command.candidateId !== undefined || command.inputs !== undefined)
    return undefined;
  const named = typeof command.laneId === 'string' ? command.laneId : undefined;
  const here = resolutionHere(root, named);
  if (!here) return undefined;
  // Resolved already, and the land names the origin (which would land its old head): land the
  // resolution's retained finish instead. Naming the resolution Lane (or none) lands it as before.
  const resolved = named && named !== here.laneId ? resolvedFinishContinuation(root, here.laneId) : undefined;
  if (resolved) return { finish: parametersOf(resolved.next) };
  if (!here.pending || !edited(root, here.laneId)) return undefined;
  const parameters = parametersOf(resolutionContinuation(root, here.laneId, []).next);
  const message = typeof command.message === 'string' ? { message: command.message } : {};
  const response = await dispatch('resolve', { ...parameters, ...message });
  const next = (response?.result as { next?: Command } | undefined)?.next;
  if (next?.action !== 'finish' || !z.uuid().safeParse(next.operationId).success) return { response };
  const selection = parametersOf(next);
  const finish = { ...selection, ...carried(command), laneId: selection.laneId ?? here.laneId };
  // Replays of this land reach the same finish operation with the same request.
  rememberResolutionFinish(root, here.laneId, finish);
  note(
    `land: saved your edited conflict files as the resolution of Lane ${here.laneId} (resolve ${String(parameters.operationId)}); landing that resolution now. Undo: land --withdraw, then edit and land again.`,
  );
  return { finish };
}
