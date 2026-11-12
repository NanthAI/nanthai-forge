// SPDX-License-Identifier: Apache-2.0
import { packShardReports, unpackShardReports } from '../src/check-report-cap';
import { runFlakes } from '../src/self-metrics-flakes';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import { canonicalPayload } from '../src/hosted-source-operation';
import { checkPin } from '../src/hosted-check';
import { invariant } from '../src/errors';
import { presignResultSlot, r2Config } from './r2';
import { hostedCheckTerminal } from '../src/hosted-check';
import { checkReportPointer } from '../src/check-file-summary';

// Only new batched runs detach reports. Old run rows and APIs retain their wire shape.
// This transaction-local marker never crosses a Convex value or a server response.
const detached = new WeakMap<HostedCheckRun, { parts: number; digest: string }>();
type Transport = {
  packed?: boolean;
  flakes?: string;
  timingStamp?: { generation: string; sequence: number };
  timingComplete?: boolean;
  collecting?: boolean;
  timingParts?: string[];
  conclusion?: string | null;
  collection?: {
    token: string;
    fence: number;
    until: number;
    scheduledFunctionId?: Id<'_scheduled_functions'>;
  };
};
const objectReports = new WeakMap<HostedCheckRun, Transport>();
export function objectReportTransport(run: HostedCheckRun) {
  return objectReports.get(run);
}
/** Scheduled holders are reclaimable on their next real event as soon as they stop.
 * A timestamp is only the backstop for an HTTP action, whose V8 runtime has no shorter budget. */
export async function reportCollectionBusy(ctx: MutationCtx, run: HostedCheckRun) {
  const holder = objectReportTransport(run)?.collection;
  if (!holder || holder.fence !== run.fence) return false;
  if (holder.scheduledFunctionId) {
    const scheduled = await ctx.db.system.get(holder.scheduledFunctionId);
    return scheduled?.state.kind === 'pending' || scheduled?.state.kind === 'inProgress';
  }
  return holder.until > Date.now();
}
export function useObjectReports(run: HostedCheckRun, metadata: Transport = {}) {
  objectReports.set(run, metadata);
  return metadata;
}
const firstPart = -1000,
  partBytes = 256 * 1024;
export function inheritCheckReports(source: HostedCheckRun, target: HostedCheckRun) {
  const meta = detached.get(source);
  if (meta) detached.set(target, meta);
  const transport = objectReports.get(source);
  if (transport) objectReports.set(target, transport);
  return target;
}
export const reportsDetached = (run: HostedCheckRun) => detached.has(run) || objectReports.has(run);
export function detachCheckReports(run: HostedCheckRun, parts = 0, digest = '') {
  detached.set(run, { parts, digest });
}
export async function hydrateCheckReports(ctx: QueryCtx | MutationCtx, run: HostedCheckRun) {
  if (objectReports.has(run)) return run;
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
    rows.flatMap(row => {
      const saved = JSON.parse(row.reports!);
      return Object.entries(saved.schema === 1 ? unpackShardReports(saved) : saved);
    }),
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
  const transport = objectReports.get(run);
  if (transport) {
    if (run.contractReports) {
      const pointer = checkReportPointer(run.contractReports);
      invariant(
        run.reportPointer?.digest === pointer.digest,
        'EVIDENCE_CHANGED',
        'Upload the original reports before storing their header.',
      );
      transport.flakes = canonicalPayload(runFlakes(run) ?? null);
    }
    return {
      reportStorage: 'r2' as const,
      ...(transport.packed === undefined ? {} : { resultBatch: { packed: transport.packed } }),
      ...(transport.flakes === undefined ? {} : { reportFlakes: transport.flakes }),
      ...(transport.timingStamp === undefined ? {} : { reportTimingStamp: transport.timingStamp }),
      ...(transport.timingComplete === undefined ? {} : { reportTimingComplete: transport.timingComplete }),
      ...(transport.timingParts === undefined ? {} : { reportTimingParts: transport.timingParts }),
      ...(transport.conclusion === undefined ? {} : { reportConclusion: transport.conclusion }),
      reportCollection: transport.collection,
    };
  }
  const meta = detached.get(run);
  if (!meta) return {};
  if (run.contractReports) {
    const digest = checkPin(run.contractReports);
    if (digest !== meta.digest) {
      invariant(!meta.parts, 'EVIDENCE_CHANGED', 'Final check reports are immutable.');
      const parts: NonNullable<HostedCheckRun['contractReports']>[] = [];
      let part: NonNullable<HostedCheckRun['contractReports']> = {},
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
          reports: canonicalPayload({ schema: 1, ...packShardReports(reports) }),
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

export function checkReportsKey(run: HostedCheckRun) {
  const direct = run.configuration.provider === 'github-actions' && !run.configuration.credential;
  return reportObjectKey(run.projectId, run.id, run.reportPointer!.digest, direct ? undefined : run.fence);
}

export function reportObjectKey(projectId: string, runId: string, digest: string, fence?: number) {
  return `v1/p/${projectId}/checks/${runId}/reports/${fence === undefined ? digest : `fence-${fence}`}.json`;
}

/** CPU-only signing in an existing reply, never a stored run field or a detail capability. */
export async function checkReportUploadTarget(run: HostedCheckRun, features?: string[]) {
  if (!objectReports.has(run) || hostedCheckTerminal(run)) return undefined;
  invariant(
    features?.includes('check-report-detail'),
    'CLI_UPGRADE_REQUIRED',
    'Use a runner with check-report-detail.',
  );
  return presignResultSlot(r2Config(), reportObjectKey(run.projectId, run.id, '', run.fence));
}
