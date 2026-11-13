// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { publishSaveJob, saveForJob } from './projectHostedSavePublish';
import { publishSyncJob } from './projectHostedSyncPublish';
import { publishComposeJob } from './projectHostedComposePublish';

import { syncForJob } from './projectHostedSyncStore';
import { composeForJob } from './projectHostedComposeStore';
import { canonicalPayload } from '../src/hosted-source-operation';

/** What a terminal commit that published its own small result returns to the step's action: the
 * receipt, the state's timing fields (the receipt's server split) and, for a save that names the
 * resolve after it, the chain that action runs itself (`chainRun`, never sent to clients). */
export type InlinePublication = {
  terminal: unknown;
  state: { submittedAt?: number; serverTiming?: unknown };
  chainRun?: { projectId: Id<'hostedProjects'>; actor: string; operationId: string };
  /** A sync's result as changes from the client's Lane head (src/hosted-sync-delta.ts), added by
   * the step for its submitter's reply only. */
  delta?: unknown;
  /** A Node save already ran its resolve within this action. Never sent to clients. */
  chainResult?: string | null;
};
/** Publish a save, sync or compose result inside the step's terminal commit (1eef1b43): the same
 * publish transaction the scheduled `publish` runs, with no scheduler hop between them. */
export async function publishSourceResult(
  ctx: MutationCtx,
  kind: 'save' | 'sync' | 'compose',
  input: { projectId: Id<'hostedProjects'>; jobId: string; result: string },
  /** The committing action runs a save's resolve chain itself; the publication keeps only a fallback. */
  chainInline: boolean,
  /** R2 requests the job's steps signed, from the step row the commit just wrote (compose only). */
  r2?: [number, number, number],
): Promise<string | null> {
  const terminal =
    kind === 'save'
      ? await publishSaveJob(ctx, input, chainInline)
      : kind === 'sync'
        ? await publishSyncJob(ctx, input)
        : await publishComposeJob(ctx, { ...input, ...(r2 ? { r2 } : {}) });
  if (terminal === null) return null;
  const row =
    kind === 'save'
      ? await saveForJob(ctx, input.projectId, input.jobId)
      : kind === 'sync'
        ? await syncForJob(ctx, input.projectId, input.jobId)
        : await composeForJob(ctx, input.projectId, input.jobId);
  const state = row
    ? (JSON.parse(row.value) as { submittedAt?: number; serverTiming?: unknown; chainFallbackId?: string })
    : {};
  const published: InlinePublication = {
    terminal: JSON.parse(terminal),
    state: {
      ...(state.submittedAt === undefined ? {} : { submittedAt: state.submittedAt }),
      ...(state.serverTiming === undefined ? {} : { serverTiming: state.serverTiming }),
    },
    ...(row && state.chainFallbackId
      ? { chainRun: { projectId: input.projectId, actor: row.actor, operationId: row.operationId } }
      : {}),
  };
  return canonicalPayload(published);
}
