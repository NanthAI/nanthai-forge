// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Review batches share the existing Item comment record and permissions. JSON text survives older readers and
// exports without a journal/schema migration. Pins and outcomes are reviewer reports, never acceptance evidence.
import { MAX_COMMENT_CHARACTERS } from './model';

type Finding = {
  id: string;
  severity: 'blocker' | 'should' | 'nit';
  path: string;
  side: 'base' | 'head';
  blob: string;
  line: number;
  claim: string;
  origin: 'changed' | 'pre-existing';
  outcome: 'open' | 'fixed' | 'disputed' | 'declined';
  reason?: string;
};
type Review = {
  kind: 'forge-review';
  version: 1;
  laneId: string;
  base: string;
  head: string;
  candidateId?: string;
  findings: Finding[];
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const textValue = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

const oneOf = (value: unknown, values: string[]) => typeof value === 'string' && values.includes(value);

/** Unknown versions, incomplete evidence and ordinary comments retain their original text presentation. No write
 * is refused; nothing is inferred from current source, so a later save cannot silently move or clear a finding. */
export function readReview(text: string): Review | null {
  if (text.length > MAX_COMMENT_CHARACTERS || !text.trimStart().startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !object(value) ||
    value.kind !== 'forge-review' ||
    value.version !== 1 ||
    !uuid(value.laneId) ||
    (value.candidateId !== undefined && !uuid(value.candidateId)) ||
    !hash(value.base) ||
    !hash(value.head) ||
    !Array.isArray(value.findings)
  )
    return null;
  const ids = new Set<string>();
  for (const finding of value.findings) {
    if (
      !object(finding) ||
      !textValue(finding.id) ||
      ids.has(finding.id) ||
      !oneOf(finding.severity, ['blocker', 'should', 'nit']) ||
      !textValue(finding.path) ||
      !oneOf(finding.side, ['base', 'head']) ||
      !hash(finding.blob) ||
      !Number.isSafeInteger(finding.line) ||
      (finding.line as number) < 1 ||
      !textValue(finding.claim) ||
      !oneOf(finding.origin, ['changed', 'pre-existing']) ||
      !oneOf(finding.outcome, ['open', 'fixed', 'disputed', 'declined']) ||
      (finding.reason !== undefined && !textValue(finding.reason)) ||
      (finding.outcome !== 'open' && !textValue(finding.reason))
    )
      return null;
    ids.add(finding.id);
  }
  return value as Review;
}
export function ReviewFindings({ review, original }: { review: Review; original: string }) {
  return (
    <div className="md">
      <p>
        <strong>
          Review · {review.findings.length} {review.findings.length === 1 ? 'finding' : 'findings'}
        </strong>
        {' · '}reported by reviewer
      </p>
      {review.findings.map(finding => (
        <div key={finding.id}>
          <p>
            <strong>
              {finding.id} · {finding.severity} · {finding.outcome}
            </strong>
          </p>
          <p className="mono">
            {finding.path}:{finding.line} · {finding.side} · {finding.origin}
          </p>
          <p>{finding.claim}</p>
          {finding.reason ? <p>{finding.reason}</p> : null}
        </div>
      ))}
      <details>
        <summary>Exact review record</summary>
        <pre>
          <code>{original}</code>
        </pre>
      </details>
    </div>
  );
}
