// SPDX-License-Identifier: Apache-2.0
// Check-status guard (Issue 68361cd5, checks machine 1): eleven readers once decided "terminal",
// "failed" or "infrastructure" with their own hand-written status lists, and they disagreed.
// src/check-run-state.ts owns those predicates; a new list or comparison that reads a runner-*
// status elsewhere fails the build. Writers (`status: 'runner-unavailable'`) and schemas pass.
export const STATUS_LIST_ALLOWLIST = new Set([
  'src/check-run-state.ts',
  'scripts/check-status-lists.mjs',
  // Landing-path readers: adopting the module there waits for the scored exit bench (P7).
  'src/landing-observation.ts',
  'src/landing-submission-state.ts',
  'convex/projectHostedLandingCheckRetry.ts',
]);
const SCOPE = /^(?:src|convex|web\/src|netlify|scripts)\//;
const STATUS = String.raw`'runner-(?:unavailable|budget-exhausted)'`;
const RULES = [
  ['status list .includes', new RegExp(String.raw`\[[^\]]*${STATUS}[^\]]*\]\s*\)?\s*\.includes\(`)],
  ['status Set', new RegExp(String.raw`new Set\(\s*\[[^\]]*${STATUS}`)],
  ['status comparison', new RegExp(String.raw`[!=]==\s*${STATUS}`)],
];

/** Findings name file, line and rule; the module's predicates replace each match. */
export function statusListFindings(path, source) {
  if (!SCOPE.test(path) || STATUS_LIST_ALLOWLIST.has(path) || !/runner-(?:unavailable|budget)/.test(source))
    return [];
  const findings = [];
  for (const [name, rule] of RULES) {
    const global = new RegExp(rule.source, 'g');
    for (const match of source.matchAll(global)) {
      const line = source.slice(0, match.index).split('\n').length;
      findings.push(
        `${path}:${line}: ${name} reads a check status by hand; use src/check-run-state.ts predicates`,
      );
    }
  }
  return findings;
}
