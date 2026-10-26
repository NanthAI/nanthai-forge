// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { dispatchSourceJob } from './projectSourceJobDispatch';
import { ModalSourceProvider } from '../src/modal-source-provider';
import { invariant } from '../src/errors';

/** Short dispatch/observe trigger, never a source computation or worker wait.
 * Provisioning/deployment is explicit; no owner credentials are discovered. */
export const dispatch = internalAction({
  args: { projectId: v.id('hostedProjects'), jobId: v.string() },
  returns: v.union(v.literal('idle'), v.literal('observed'), v.literal('unknown')),
  handler: async (ctx, input) => {
    const endpoint = process.env.FORGE_SOURCE_MODAL_URL,
      token = process.env.FORGE_SOURCE_MODAL_TOKEN,
      worker = process.env.FORGE_SOURCE_WORKER,
      runtime = process.env.FORGE_SOURCE_RUNTIME;
    invariant(
      endpoint && token && worker && runtime,
      'SOURCE_WORKER_UNAVAILABLE',
      'The pinned Modal source bridge is not configured.',
    );
    return dispatchSourceJob(
      ctx,
      { ...input, owner: crypto.randomUUID(), leaseMs: 60000 },
      new ModalSourceProvider({ endpoint, token, worker, runtime, timeoutMs: 10000 }),
    );
  },
});
