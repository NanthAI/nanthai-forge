// SPDX-License-Identifier: Apache-2.0
import type {
  SourceJobProvider,
  SourceDispatch,
  SourceLookup,
  SourceDispatchResult,
} from './hosted-source-job.js';
import { digest } from './portable-hash.js';
import { invariant } from './errors.js';
export const convexSourceWorker = 'forge-convex-source-v1';
export const convexSourceRuntime = digest(convexSourceWorker);
export function sourceWorkerPlan(env: Record<string, string | undefined>) {
  const provider = env.FORGE_SOURCE_PROVIDER ?? 'convex';
  invariant(
    provider === 'convex' || provider === 'modal',
    'SOURCE_PROVIDER_CHANGED',
    'Select the configured source provider.',
  );
  if (provider === 'convex')
    return {
      provider,
      worker: convexSourceWorker,
      runtime: convexSourceRuntime,
      keyId: 'CONVEX',
      workerLeaseMs: 60000,
    };
  const worker = env.FORGE_SOURCE_WORKER,
    runtime = env.FORGE_SOURCE_RUNTIME,
    keyId = env.FORGE_SOURCE_KEY_ID;
  invariant(
    worker && runtime && keyId,
    'SOURCE_WORKER_UNAVAILABLE',
    'The pinned Modal source worker is not configured.',
  );
  return { provider, worker, runtime, keyId, workerLeaseMs: 60000 };
}
/** Start commits the reservation, fixed execution identity and first schedule in
 * one transaction. Lost replies reconcile that identity; they never spawn again. */
export class ConvexSourceProvider implements SourceJobProvider {
  readonly id = 'convex';
  constructor(
    private readonly start: (input: SourceDispatch) => Promise<SourceDispatchResult>,
    private readonly find: (input: SourceDispatch) => Promise<SourceLookup>,
  ) {}
  dispatch(input: SourceDispatch) {
    return this.start(input);
  }
  lookup(input: SourceDispatch) {
    return this.find(input);
  }
}
