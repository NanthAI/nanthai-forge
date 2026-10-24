// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { HostedRecord } from './hosted-records.js';
import type { SourceDispatch, SourceJobProvider } from './hosted-source-job.js';

type Job = Extract<HostedRecord, { kind: 'job' }>;
export type SourceJobCommand =
  | { kind: 'reserve'; recovery: boolean }
  | { kind: 'empty'; lookupId: string }
  | { kind: 'observe'; status: 'accepted' | 'found'; executionId: string }
  | { kind: 'observe'; status: 'rejected' | 'unknown' };
export interface SourceJobStore {
  claim(): Promise<Job | null>;
  advance(token: number, command: SourceJobCommand): Promise<Job | null>;
}
export function sourceDispatch(projectId: string, job: Job): SourceDispatch {
  const control = job.control;
  invariant(control, 'SOURCE_JOB_INVALID', 'Source job has no trusted provider contract.');
  return {
    schema: 1,
    projectId,
    jobId: job.id,
    operationId: job.operationId,
    jobKind: job.jobKind,
    attempt: job.attempt,
    fence: job.fence,
    authorityEpoch: job.authorityEpoch,
    input: job.input,
    inputDigest: job.inputDigest,
    provider: control.provider,
    worker: control.worker,
    runtime: control.runtime,
    dispatchKey: control.dispatchKey,
  };
}

/** One bounded control tick: at most two fresh lookups and one idempotent dispatch.
 * No worker wait, source bytes, global scan, sleep loop or idle paid process.
 * H06 adapters supply their own bounded HTTP timeouts. Thrown transport errors
 * mean unknown, and are never inferred to be definitive rejection or absence. */
export async function driveSourceJob(
  projectId: string,
  store: SourceJobStore,
  provider: SourceJobProvider,
  lookupId: () => string,
): Promise<'idle' | 'observed' | 'unknown'> {
  let job = await store.claim();
  if (!job) return 'idle';
  invariant(
    job.control?.provider === provider.id,
    'SOURCE_PROVIDER_CHANGED',
    'The pinned source provider changed.',
  );
  const token = job.control.lease!.token;
  const advance = (command: SourceJobCommand) => store.advance(token, command);
  if (job.executionId || job.control.dispatch !== 'unstarted') {
    const lookup = async () => {
      try {
        return await provider.lookup(sourceDispatch(projectId, job!));
      } catch {
        return { status: 'unknown' } as const;
      }
    };
    for (let fresh = 0; fresh < 2; fresh++) {
      const result = await lookup();
      if (result.status === 'found') {
        await advance({ kind: 'observe', status: 'found', executionId: result.executionId });
        return 'observed';
      }
      if (result.status !== 'empty' || result.authoritative !== true) return 'unknown';
      job = await advance({ kind: 'empty', lookupId: lookupId() });
      if (!job) return 'idle';
    }
    if (job.executionId || job.control!.dispatch !== 'ambiguous' || job.control!.recoveryUsed)
      return 'unknown';
    job = await advance({ kind: 'reserve', recovery: true });
  } else job = await advance({ kind: 'reserve', recovery: false });
  if (!job) return 'idle';
  // A second mutation checks lease + authority immediately before the external
  // call. A revocation during the call is checked again on observation/callback.
  job = await advance({ kind: 'observe', status: 'unknown' });
  if (!job) return 'idle';
  let result;
  try {
    result = await provider.dispatch(sourceDispatch(projectId, job));
  } catch {
    result = { status: 'unknown' } as const;
  }
  await advance({ kind: 'observe', ...result });
  return result.status === 'unknown' ? 'unknown' : 'observed';
}
