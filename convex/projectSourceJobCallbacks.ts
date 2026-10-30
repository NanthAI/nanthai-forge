// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { loadSourceJob, saveSourceJob, sourceJobTerminal } from './projectSourceJobs';
import { hostedWriteProject } from './projectHostedRecords';
import { sourceJobCallbackSchema } from '../src/hosted-source-job';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';

/** Only the output manifest reference becomes job evidence. H06/H07 separately
 * verify object membership/closure before publishing source or moving a Lane. */
/** Internal Convex execution has no credential or network callback boundary. */
export async function receiveConvexSourceJobCallback(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  value: unknown,
  now = Date.now(),
) {
  const input = { projectId, callback: value };
  const callback = sourceJobCallbackSchema.parse(input.callback);
  invariant(
    callback.projectId === input.projectId,
    'SOURCE_CALLBACK_INVALID',
    'Callback project differs from its job.',
  );
  const job = await loadSourceJob(ctx, input.projectId, callback.jobId),
    control = job.control;
  await hostedWriteProject(ctx, input.projectId, control.actor, job.authorityEpoch);
  invariant(
    control.provider === 'convex',
    'SOURCE_PROVIDER_CHANGED',
    'Select the internal Convex source provider.',
  );
  invariant(
    callback.operationId === job.operationId &&
      callback.attempt === job.attempt &&
      callback.fence === job.fence &&
      callback.authorityEpoch === job.authorityEpoch &&
      callback.inputDigest === job.inputDigest &&
      callback.provider === control.provider &&
      callback.worker === control.worker &&
      callback.runtime === control.runtime &&
      (!job.executionId || callback.executionId === job.executionId),
    'SOURCE_CALLBACK_INVALID',
    'Callback does not bind the retained trusted execution pins.',
  );
  const callbackDigest = digest(canonicalPayload(callback));
  if (sourceJobTerminal(job)) {
    invariant(
      control.callbackDigest === callbackDigest,
      'SOURCE_JOB_TERMINAL',
      'A terminal job result is immutable.',
    );
    return job;
  }
  invariant(
    control.dispatch !== 'unstarted' && control.workerUntil > now,
    'SOURCE_JOB_FENCED',
    'The source-worker lease is absent or expired.',
  );
  if (callback.result.status === 'heartbeat') {
    // Duplicate/old internal heartbeats never extend the lease a second time.
    if (callback.result.sequence <= control.heartbeat) return job;
    return saveSourceJob(
      ctx,
      input.projectId,
      job,
      {
        ...job,
        status: 'running',
        executionId: callback.executionId,
        control: {
          ...control,
          dispatch: 'accepted',
          heartbeat: callback.result.sequence,
          workerUntil: now + control.workerLeaseMs,
        },
      },
      now,
    );
  }
  return saveSourceJob(
    ctx,
    input.projectId,
    job,
    {
      ...job,
      status: callback.result.status,
      executionId: callback.executionId,
      output: callback.result.status === 'completed' ? callback.result.output : null,
      control: {
        ...control,
        dispatch: 'accepted',
        callbackDigest,
        failureCode: callback.result.status === 'failed' ? callback.result.code : null,
      },
    },
    now,
  );
}
