// SPDX-License-Identifier: Apache-2.0
/** Parallel-work defaults and the agent-facing text generated from them. Shared by the CLI/MCP
 * (src/agent-parallel-defaults.ts), the packaged skill and llms.txt, so the wording cannot drift. */
export const AGENT_DEFAULTS = Object.freeze({
  preflight: 'require',
  preflightMaxMinutes: 10,
  urgentRoles: ['owner'],
  checkpointNudgeMinutes: 30,
  stallAlerts: { enabled: true, notifyAfterMinutes: 15, repeatAfterMinutes: 30, email: [], webhook: 'off' },
});

/** One terse line per active rule; nothing for rules that are off. */
export function agentDefaultLines(defaults, root = 'ROOT') {
  const lines = [];
  if (defaults.preflight !== 'off')
    lines.push(
      defaults.preflight === 'require'
        ? `land --save runs required preflight within its local budget; on failure or budget exhaustion follow its command, then replay. Sets over ${defaults.preflightMaxMinutes} min are advisory.`
        : `Affected tests: nforge agent ${root} preflight '{"laneId":"…"}' (advisory).`,
    );
  if (defaults.checkpointNudgeMinutes > 0)
    lines.push(
      `Save after each meaningful step, at least every ${defaults.checkpointNudgeMinutes} minutes of edits: each save checks your saved files for exact conflicts with main and other open Lanes.`,
    );
  if (!defaults.urgentRoles.includes('agents'))
    lines.push('Never request urgent priority; it is owner-only.');
  lines.push(
    'After land is submitted, do not save, sync or edit that Lane until it lands or fails.',
    'If a landing fails, fix it in the same Lane and land again; never cancel and start a new Lane.',
    'If a queued landing reports wouldConflict, sync and land the same Lane again.',
  );
  if (defaults.stallAlerts.enabled)
    lines.push('A LANDING_STALLED receipt names its repair command; run that, do not resubmit.');
  return lines;
}
