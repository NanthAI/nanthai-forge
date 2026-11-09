// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { shellQuote } from './agent-brief-render.js';
import { ForgeError } from './errors.js';
import {
  inPlaceOrigin,
  markedPendingPaths,
  pendingConflictPaths,
  rememberConflictPaths,
} from './hosted-conflict-precheck.js';
const resolveCommand = (root: string, parameters: object) =>
  `nforge agent ${shellQuote(root)} resolve ${shellQuote(JSON.stringify(parameters))}`;
export const UNCHANGED_SIDE = 'CONFLICT_SIDE_REQUIRED';
export const failedCode = (value: unknown) => {
  const parsed = z
    .object({ outcome: z.object({ status: z.literal('failed'), error: z.object({ code: z.string() }) }) })
    .safeParse(value);
  return parsed.success ? parsed.data.outcome.error.code : null;
};
/** Issue 113bc7b3: the server refused conflict files that still hold one side unchanged (no
 * markers). Name them and the two explicit choices, each with a fresh operation (the refused
 * one replays its refusal); neither choice is preselected, so nothing drops a side silently. */
export function unchangedSideRefusal(
  root: string,
  laneId: string,
  command: { message: string; keep?: string[] | undefined },
  recovery?: Record<string, unknown>,
) {
  const reported = z.array(z.string()).safeParse(recovery?.paths);
  const marked = new Set(markedPendingPaths(root, laneId));
  const paths = reported.success
    ? reported.data
    : pendingConflictPaths(root, laneId).filter(path => !marked.has(path));
  const base = { laneId, message: command.message };
  const edit = { ...base, operationId: randomUUID() },
    keep = {
      ...base,
      keep: [...new Set([...(command.keep ?? []), ...paths])].sort(),
      operationId: randomUUID(),
    };
  // A later replay of the original recovery (land --save) runs the edit choice, not the refusal.
  rememberConflictPaths(root, laneId, pendingConflictPaths(root, laneId), edit, true);
  const editCommand = resolveCommand(root, edit),
    keepCommand = resolveCommand(root, keep),
    origin = inPlaceOrigin(root);
  const other = origin
    ? `show {"laneId":"${origin}","path":"PATH"} (the original Lane) or show {"channel":"main","path":"PATH"}`
    : 'show {"channel":"main","path":"PATH"} or the original Lane\'s show {"laneId":"LANE_ID","path":"PATH"}';
  const instruction =
    `${paths.join(', ') || 'A conflict file'} still holds one side unchanged, without conflict markers; ` +
    `resolving it as is would drop the other side's change. Edit the file (or write the other side's exact bytes: ${other}), ` +
    `then run: ${editCommand}. Or keep the version it holds now, explicitly: ${keepCommand}`;
  return new ForgeError(UNCHANGED_SIDE, instruction, undefined, {
    root,
    laneId,
    paths,
    instruction,
    choices: {
      edit: { next: { action: 'resolve', ...edit }, command: editCommand },
      keep: { next: { action: 'resolve', ...keep }, command: keepCommand },
    },
  });
}
