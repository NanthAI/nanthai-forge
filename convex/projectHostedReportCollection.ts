// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { LoadedHostedCheck } from './projectHostedCheckStore';
import { objectReportTransport, reportCollectionBusy } from './projectHostedCheckReports';
import { notifyActionsProgress } from './projectHostedActionsWake';
import { finalOutputTarget } from './projectHostedActionsOutput';
import { hostedCheckTerminal } from '../src/hosted-check';
import { invariant } from '../src/errors';

/** Reserve the fold in the caller's existing transaction. Only subsequent real events can
 * reclaim a stopped scheduled holder immediately; this installs no timer or wake. */
export async function prepareReportCollection(
  ctx: MutationCtx,
  selected: LoadedHostedCheck,
  conclusion?: string | null,
  conclude?: typeof import('./projectHostedActionsVerdict').applyConclusion,
  owner?: {
    collectionToken?: string;
    scheduledFunctionId?: import('./_generated/dataModel').Id<'_scheduled_functions'>;
  },
) {
  const { row, run } = selected;
  const transport = objectReportTransport(run)!;
  const settlesVerdict =
    run.reportPointer && !hostedCheckTerminal(run) && run.actions?.verdictPending && conclusion !== undefined;
  if (conclusion !== undefined) {
    invariant(
      conclusion === null || transport.conclusion == null || transport.conclusion === conclusion,
      'EVIDENCE_CHANGED',
      'The provider conclusion is immutable.',
    );
    if (transport.conclusion == null && transport.conclusion !== conclusion) {
      transport.conclusion = conclusion;
      if (!settlesVerdict) await ctx.db.patch(row._id, { reportConclusion: conclusion });
    }
  }
  if (run.reportPointer) {
    if (settlesVerdict) {
      // The pinned reports already supply terminal evidence; do not schedule another fold.
      transport.collecting = true;
      await conclude!(
        ctx,
        selected,
        typeof transport.conclusion === 'string' ? transport.conclusion : conclusion!,
      );
      if (run.status !== 'passed') await notifyActionsProgress(ctx, run);
    }
    const timings =
      !transport.timingComplete &&
      typeof transport.conclusion === 'string' &&
      transport.conclusion !== 'cancelled' &&
      !run.cancelRequested &&
      ['passed', 'failed'].includes(run.status);
    return {
      run,
      packed: transport.packed!,
      reportStorage: 'r2' as const,
      collect: false,
      timings,
      final: await finalOutputTarget(ctx, { projectId: row.projectId, runId: run.id }, run),
    };
  }
  const own =
    owner?.collectionToken &&
    transport.collection?.token === owner.collectionToken &&
    transport.collection.fence === run.fence;
  const busy = !own && (await reportCollectionBusy(ctx, run));
  if (!busy && !own) {
    transport.collection = {
      token: crypto.randomUUID(),
      fence: run.fence,
      until: Date.now() + 30 * 60_000,
      ...(owner?.scheduledFunctionId ? { scheduledFunctionId: owner.scheduledFunctionId } : {}),
    };
    await ctx.db.patch(row._id, { reportCollection: transport.collection });
  }
  return {
    run,
    packed: transport.packed!,
    reportStorage: 'r2' as const,
    collect: !busy,
    ...(busy ? {} : { collectionToken: transport.collection!.token }),
  };
}
