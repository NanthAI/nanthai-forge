// SPDX-License-Identifier: Apache-2.0
type Impact = {
  invalidatedLandings?: number;
  invalidatedSubmissionIds?: string[];
  impactComplete?: false;
  impactUnexamined?: number;
  invalidatedByPhase?: { ready: number; checking: number; queued: number };
  heldForReview?: number;
  idsTruncated?: true;
};

export function policyImpactMessage(impact: Impact, dryRunAt?: string): string | undefined {
  const { invalidatedLandings: count, impactUnexamined: extra, invalidatedByPhase } = impact;
  if (count === undefined)
    return impact.impactComplete === false ? 'This receipt could not verify the impact.' : undefined;
  const verb = dryRunAt ? 'Would invalidate' : 'Invalidated';
  const scope = dryRunAt ? `as of this read (${dryRunAt})` : 'at commit';
  const detail = extra === undefined ? `${count}` : `at least ${count}`;
  const phases = (['ready', 'checking', 'queued'] as const)
    .map(phase => [phase, invalidatedByPhase?.[phase] ?? 0] as const)
    .filter(([, total]) => total > 0)
    .map(([phase, total]) => `${total} ${phase}`);
  const breakdown = phases.length ? ` (${phases.join(', ')})` : '';
  const ids = impact.invalidatedSubmissionIds?.length ? ' See the listed submission IDs.' : '';
  const truncated = impact.idsTruncated ? ' The list shows the first 1,000 verified IDs.' : '';
  const bounds =
    extra === undefined
      ? ''
      : ` Up to ${extra} more in-flight landings were unexamined. The total is between ${count} and ${count + extra}.`;
  const held = impact.heldForReview ? ` Excluded ${impact.heldForReview} held for review.` : '';
  const next = dryRunAt
    ? ' The queue can change before you apply. The applied receipt records the impact at commit.'
    : count > 0 || extra
      ? ' An invalidated attempt can be withdrawn or recomposed before it re-checks.'
      : '';
  return `${verb} ${detail} in-flight landings ${scope}${breakdown}.${ids}${truncated}${bounds}${held}${next}`;
}
