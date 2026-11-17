// SPDX-License-Identifier: Apache-2.0
import { evidenceSources } from './receipt-detail.js';
import type { SaveRequest } from './hosted-save.js';
import type { HostedCheckRun } from './hosted-check.js';
import { digest } from './state/hash.js';
import { scrubText } from './client-error-text.js';

/** Display-only derivation. Never an input to verdicts, reuse, authority or test selection. */
export function checkEvidence(run: HostedCheckRun | null) {
  if (!run) return null;
  const reports = run.contractReports;
  const count =
    run.testFiles?.counts ??
    (reports === undefined
      ? null
      : {
          total: Object.keys(reports).length,
          failed: Object.values(reports).filter(report => report.failed).length,
          flaky: Object.values(reports).filter(report => report.flaky && !report.failed).length,
        });
  // Older runners wrote an empty summary when they collected nothing. It does not prove zero tests ran.
  const reported = count !== null && count.total > 0;
  const elapsed = run.endedAt === null ? NaN : Date.parse(run.endedAt) - Date.parse(run.at);
  return {
    runId: run.id,
    head: run.request.expectedHead,
    status: run.status,
    check: run.check.name,
    files: reported ? count : null,
    sources: evidenceSources,
    selection: run.gate ?? run.request.gate ?? null,
    skipped: run.plan?.skipped ?? null,
    ciMinutes: run.cost.status === 'observed' && run.cost.seconds !== null ? run.cost.seconds / 60 : null,
    wallSeconds: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed / 1000 : null,
    shards: { ...run.counts, total: run.plan?.shardCount ?? null },
    at: run.at,
    endedAt: run.endedAt,
    providerLink: run.ci?.link ?? null,
  };
}

/** Keep summaries, never a credential value, signed URL, private filesystem or device field. */
export function outsideSummary(value: string) {
  return scrubText(value, value.length)
    .replace(/\b(?:https?|wss?|file):\/\/[^\s<>"']+/gi, '[external link]')
    .replace(/(?:\/(?:Users|home|private|tmp)\/|[A-Za-z]:[\\/])[^\s<>"']+/g, '[private path]')
    .replace(/\b[^\s<>"']+\.(?:local|internal)\b/gi, '[private device]');
}

/** Stable across a single-line click, batch creation and a lost reply. */
export function proofFollowupId(saveId: string, line: number) {
  const hash = digest(`forge-verification-followup-v1:${saveId}:${line}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** A lost full-check reply reuses the same check on this original run’s pinned source. */
export function proofRecheckId(runId: string) {
  const hash = digest(`forge-proof-full-check-v1:${runId}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Normalise before operation identity and persistence, so progress reads never expose raw report values. */
export function sanitizeOutside(rows: NonNullable<SaveRequest['outside']>) {
  return rows.map(row => ({
    kind: row.kind,
    what: outsideSummary(row.what),
    ...(row.where === undefined ? {} : { where: outsideSummary(row.where) }),
  }));
}

/** Present declarations belong to this author and cannot coalesce into another request's claim.
 * Preserve old selection identities byte-for-byte when no declaration was supplied. */
export function declarationIdentity(input: Pick<SaveRequest, 'notVerified' | 'outside'>, actor: string) {
  if (input.notVerified === undefined && input.outside === undefined) return {};
  return {
    declarationAuthor: actor,
    ...(input.notVerified === undefined ? {} : { notVerified: input.notVerified }),
    ...(input.outside === undefined ? {} : { outside: input.outside }),
  };
}
