// SPDX-License-Identifier: Apache-2.0
import { recoveryAllowed, recoveryResult } from './optimistic-recovery.js';
import { finishChild } from './agent-finish-journal.js';
import type { CheckRun, WorkData } from './work-types.js';

export const fixMainIntentId = (run: CheckRun) => finishChild(run.head, `fix-main:${run.mainCheck!.channel}`);

export const failedMainCheck = (run: CheckRun) =>
  !!run.mainCheck && !run.recovery && !!run.endedAt && run.status === 'failed';

/** Called under the owner lock. Deterministic identity survives worker restarts,
 * repeated observations and manual reruns of the same accepted head. */
export function recordFixForward(data: WorkData): boolean {
  let changed = false;
  for (const run of data.runs.filter(failedMainCheck)) {
    const recovery = recoveryResult(data, run);
    if (recovery?.status === 'flaky' || recovery?.status === 'reverted') continue;
    if (recoveryAllowed(data) && !recovery) continue;
    const channel = run.mainCheck!.channel,
      landing = data.channelMoves.find(
        move => move.channel === channel && move.head === run.head && move.status === 'accepted',
      );
    if (!landing) continue;
    const id = fixMainIntentId(run);
    if (data.intents.some(intent => intent.id === id)) continue;
    const prompt = `Work on Intent ${id}. The full ${channel} check ${JSON.stringify(run.check.name)} failed after landing ${landing.id} (accepted head ${run.head}, View ${run.viewId}, failing run ${run.id}). Inspect its retained output with nforge agent ROOT log '{"operationId":"${run.id}","stream":"stderr"}' and stdout as needed. Start a new Lane on current ${channel} with nforge agent ROOT start '{"intentId":"${id}","outcome":"Fix main"}'. Diagnose and fix forward, preserving all later accepted work. Check and accept the new View normally under the current autonomy policy. Never rewind or automatically revert ${channel}. Creating this Intent has not changed accepted source. To close this handoff without a fix, abandon the Intent; reopen it to resume.`;
    data.intents.push({
      id,
      outcome: `Fix main: ${run.check.name.slice(0, 430)} failed after ${landing.id}`,
      constraints: prompt,
      base: run.head,
      status: 'active',
      createdAt: run.endedAt!,
      dependencies: [],
      mainCheckFailure: { channel, head: run.head, landingId: landing.id, runId: run.id },
      notes: [
        {
          kind: 'decision',
          at: run.endedAt!,
          text: `Automatic fix-forward handoff. Copy prompt for an agent:\n\n${prompt}`,
        },
      ],
    });
    changed = true;
  }
  return changed;
}
