// SPDX-License-Identifier: Apache-2.0
import { runFlakes } from '../src/self-metrics-flakes';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { checkPin } from '../src/hosted-check';
import { invariant } from '../src/errors';

// Only new batched runs detach reports. Old run rows and APIs retain their wire shape.
// This transaction-local marker never crosses a Convex value or a server response.
const detached = new WeakMap<HostedCheckRun, { parts: number; digest: string }>();
const firstPart = -1000,
  partBytes = 256 * 1024;
export function inheritCheckReports(source: HostedCheckRun, target: HostedCheckRun) {
  const meta = detached.get(source);
  if (meta) detached.set(target, meta);
  return target;
}
export const reportsDetached = (run: HostedCheckRun) => detached.has(run);
export function detachCheckReports(run: HostedCheckRun, parts = 0, digest = '') {
  detached.set(run, { parts, digest });
}
export async function hydrateCheckReports(ctx: QueryCtx | MutationCtx, run: HostedCheckRun) {
  const meta = detached.get(run);
  if (!meta?.parts || run.contractReports) return run;
  const rows = await ctx.db
    .query('projectHostedActionsResults')
    .withIndex('by_project_and_run_and_index', q =>
      q
        .eq('projectId', run.projectId as Id<'hostedProjects'>)
        .eq('runId', run.id)
        .gte('index', firstPart - meta.parts + 1)
        .lte('index', firstPart),
    )
    .take(meta.parts);
  invariant(
    rows.length === meta.parts && rows.every(row => row.digest === meta.digest && row.reports),
    'SOURCE_UNAVAILABLE',
    'Retained check reports are incomplete.',
  );
  run.contractReports = Object.fromEntries(
    rows.flatMap(row => Object.entries(JSON.parse(row.reports!))),
  ) as NonNullable<HostedCheckRun['contractReports']>;
  invariant(
    checkPin(run.contractReports) === meta.digest,
    'EVIDENCE_CHANGED',
    'Retained check reports differ from their digest.',
  );
  return run;
}
/** Immutable per-run report pages, written once. A provider verdict updates only the slim head.
 * R2 retains logs; these are the same contract metadata formerly embedded in the run record. */
export async function storeCheckReports(ctx: MutationCtx, run: HostedCheckRun) {
  const meta = detached.get(run);
  if (!meta) return {};
  if (run.contractReports) {
    const digest = checkPin(run.contractReports);
    if (digest !== meta.digest) {
      invariant(!meta.parts, 'EVIDENCE_CHANGED', 'Final check reports are immutable.');
      const parts: Record<string, unknown>[] = [];
      let part: Record<string, unknown> = {},
        bytes = 2;
      for (const [file, report] of Object.entries(run.contractReports)) {
        const size = new TextEncoder().encode(canonicalPayload({ [file]: report })).length;
        if (bytes + size > partBytes && Object.keys(part).length) {
          parts.push(part);
          part = {};
          bytes = 2;
        }
        part[file] = report;
        bytes += size;
      }
      if (Object.keys(part).length || !parts.length) parts.push(part);
      for (const [index, reports] of parts.entries())
        await ctx.db.insert('projectHostedActionsResults', {
          projectId: run.projectId as Id<'hostedProjects'>,
          runId: run.id,
          index: firstPart - index,
          digest,
          reports: canonicalPayload(reports),
        });
      meta.parts = parts.length;
      meta.digest = digest;
    }
  }
  return {
    reportParts: meta.parts,
    reportDigest: meta.digest,
    ...(run.contractReports ? { reportFlakes: canonicalPayload(runFlakes(run) ?? null) } : {}),
  };
}
