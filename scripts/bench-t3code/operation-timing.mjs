// SPDX-License-Identifier: Apache-2.0
// Read-side evidence only. Never infer server phases from an outer CLI call's duration.
import { cliReplies } from './receipts.mjs';
export function submissionTimings(output) {
  const out = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.operationId && value.timing && (value.phase || value.observation))
      out.push({
        operationId: value.operationId,
        attemptId: value.attemptId ?? null,
        phase: value.phase ?? null,
        timing: value.timing,
      });
    for (const key of ['result', 'submission', 'submissions']) {
      const child = value[key];
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  cliReplies(output).forEach(visit);
  return out;
}
export function operationTiming(operationId, observed, rows, attemptId = null) {
  const timing = {};
  const commands = [];
  for (const row of rows) {
    for (const entry of row.submissionTimings ?? [])
      if (
        entry.operationId === operationId &&
        (!attemptId || !entry.attemptId || entry.attemptId === attemptId)
      )
        Object.assign(timing, entry.timing);
    if (
      (row.operations ?? []).some(o => o.operationId === operationId && ['finish', 'land'].includes(o.action))
    ) {
      const wallMs = Date.parse(row.endedAt) - Date.parse(row.startedAt);
      commands.push({
        startedAt: row.startedAt,
        replyReceivedAt: row.endedAt,
        wallMs: Number.isFinite(wallMs) ? wallMs : null,
      });
    }
  }
  Object.assign(timing, observed ?? {});
  return { timing, commandTiming: commands };
}

/** Codes in executed replies; speculative/printed continuations are not failures. */
export function executedErrorCodes(output) {
  const advice = new Set(['wouldConflict', 'next', 'command', 'retryCommand', 'learn', 'defaults']);
  const text = cliReplies(output)
    .map(reply => JSON.stringify(reply, (key, value) => (advice.has(key) ? undefined : value)))
    .join('\n');
  return [...new Set([...text.matchAll(/"code":"([A-Z_]+)"/g)].map(m => m[1]))];
}
