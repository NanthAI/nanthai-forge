// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Double review for core Lanes (Item 3bd3eb0f): the findings of two providers, merged. Pure; no I/O.
import { SEVERITY_ORDER as SEVERITIES } from './review-api-lib.mjs';

const words = f =>
  new Set(
    `${f.title} ${f.detail}`
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(w => w.length >= 4),
  );

/** Two findings say the same thing when they sit in one file, at lines within 3 of each other (or both
 * without a line), and share enough words of title and detail. A false "different" shows both findings;
 * a false "same" would hide one, so the word bar is the stricter part. */
function sameFinding(a, b) {
  if (a.file !== b.file) return false;
  const near = a.line > 0 && b.line > 0 ? Math.abs(a.line - b.line) <= 3 : a.line === b.line;
  if (!near) return false;
  const [wa, wb] = [words(a), words(b)];
  const shared = [...wa].filter(w => wb.has(w)).length;
  const bar = a.line === b.line && a.line > 0 ? 0.3 : 0.45;
  return shared > 0 && shared / Math.min(wa.size, wb.size) >= bar;
}

/**
 * Merge the findings of the runs that answered, `runs` being [{provider, parsed: {summary, findings}}] in
 * the order they should win a tie. A finding two providers made once carries both in `sources` and the
 * higher severity; the rest keep their one source. Ranked most severe first.
 */
export function mergeFindings(runs) {
  const merged = [];
  for (const run of runs)
    for (const finding of run.parsed.findings) {
      const twin = merged.find(m => !m.sources.includes(run.provider) && sameFinding(m, finding));
      if (!twin) {
        merged.push({ ...finding, sources: [run.provider] });
        continue;
      }
      // A merge can be wrong, so the other reviewer's account stays on the finding, never discarded.
      const own = {
        provider: run.provider,
        severity: finding.severity,
        title: finding.title,
        failure_scenario: finding.failure_scenario,
      };
      twin.sources.push(run.provider);
      twin.also = [...(twin.also ?? []), own];
      if (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(twin.severity)) {
        const { sources, also } = twin;
        Object.assign(twin, finding, { sources, also });
      }
    }
  merged.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const summary = runs.map(run => `${run.provider}: ${run.parsed.summary}`).join(' ');
  return { summary, findings: merged };
}

/** The merged report: findings with who found each, then one line per provider (answered or failed). */
export function formatMerged({ summary, findings }, runs, notes) {
  const lines = [summary, ''];
  if (!findings.length) lines.push('No findings.');
  for (const f of findings)
    lines.push(
      `[${f.severity}] ${f.file}${f.line > 0 ? `:${f.line}` : ''} - ${f.title} (${f.sources.length > 1 ? `both: ${f.sources.join(' + ')}` : `${f.sources[0]} only`})`,
      `    ${f.detail}`,
      `    Failure: ${f.failure_scenario}`,
      ...(f.also ?? []).map(o => `    ${o.provider} said (${o.severity}): ${o.title}. ${o.failure_scenario}`),
      '',
    );
  for (const run of runs) {
    if (run.error) {
      lines.push(`${run.provider}/${run.model}: did not review (${run.error}).`);
      continue;
    }
    const u = run.usage;
    lines.push(
      `${run.provider}/${run.model}: ${u.input} in + ${u.cacheRead} cached + ${u.cacheWrite} cache-write, ${u.output} out tokens; $${run.usd.toFixed(4)} this call, $${run.spentTodayUsd.toFixed(4)} today on ${run.provider}.`,
    );
  }
  lines.push(...notes);
  return lines.join('\n');
}
