// SPDX-License-Identifier: Apache-2.0
import { ForgeError, invariant } from './errors.js';
import { buildHostedSourceState } from './hosted-source-worker.js';
import {
  sourceJobCallbackSchema,
  signSourceJobCallback,
  type SourceDispatch,
  type SourceJobCallback,
} from './hosted-source-job.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';

/** Runs inside the fixed remote image. Credentials belong to this trusted
 * process, never source files. Heartbeats are separate short callback requests;
 * no Convex action waits for the computation or retains any repository bytes. */
export async function runHostedSourceWorker(
  input: SourceDispatch,
  config: {
    worker: string;
    runtime: string;
    executionId: string;
    secret: string;
    heartbeatMs: number;
    now?: () => number;
    callback: (body: SourceJobCallback, signature: string) => Promise<void>;
    transport: SourceWorkerTransport;
  },
) {
  invariant(
    input.provider === 'modal' &&
      input.worker === config.worker &&
      input.runtime === config.runtime &&
      ['save', 'register-state', 'compose', 'sync'].includes(input.jobKind),
    'SOURCE_PROVIDER_CHANGED',
    'Select this fixed State-building worker and runtime.',
  );
  invariant(
    Number.isSafeInteger(config.heartbeatMs) && config.heartbeatMs > 0,
    'SOURCE_WORKER_UNAVAILABLE',
    'Configure the source-worker heartbeat interval.',
  );
  const now = config.now ?? Date.now;
  let sequence = 0,
    last = now();
  const send = async (result: SourceJobCallback['result']) => {
    const {
      projectId,
      jobId,
      operationId,
      attempt,
      fence,
      authorityEpoch,
      inputDigest,
      provider,
      worker,
      runtime,
    } = input;
    const body = sourceJobCallbackSchema.parse({
      schema: 1,
      projectId,
      jobId,
      operationId,
      attempt,
      fence,
      authorityEpoch,
      inputDigest,
      provider,
      worker,
      runtime,
      executionId: config.executionId,
      result,
    });
    await config.callback(body, signSourceJobCallback(body, config.secret));
  };
  const progress = async () => {
    if (now() - last >= config.heartbeatMs) {
      // Sequential acknowledged heartbeats; a failed delivery aborts this worker
      // rather than continuing with unobserved current authorization.
      await send({ status: 'heartbeat', sequence: ++sequence });
      last = now();
    }
  };
  await send({ status: 'heartbeat', sequence: ++sequence });
  last = now();
  let result;
  try {
    result = await buildHostedSourceState(input.input, config.transport, progress);
  } catch (error) {
    await send({ status: 'failed', code: error instanceof ForgeError ? error.code : 'SOURCE_WORKER_FAILED' });
    throw error;
  }
  await send({ status: 'completed', output: result.output });
  return result;
}
