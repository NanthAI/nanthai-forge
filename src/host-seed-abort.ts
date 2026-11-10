// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { deploymentUrl, resolveAuthToken } from './auth-store.js';
import { coordinationClient } from './coordination-client.js';
import { readHostState } from './host-binding.js';
import { WorkStore } from './work-store.js';
import { invariant } from './errors.js';

type SeedAbort = { status: 'aborted' | 'partial' | 'none'; deleted: number };
export interface SeedAbortClient {
  mutation(
    ref: ReturnType<typeof makeFunctionReference<'mutation'>>,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}
/** `nforge host ROOT --abort-seed`: the owner discards the server-side progress of this ROOT's
 * pending hosting seed (Issue 68361cd5, SM-E). The pending operation stays: `nforge host ROOT
 * --resume` then seeds the project again from page 0, and `--abandon-pending` retires it. */
export async function abortPendingSeed(root: string, client?: SeedAbortClient) {
  const pending = readHostState(WorkStore.open<'directory'>(root, { readOnly: true })).hosting;
  invariant(
    pending?.projectId,
    'HOST_NOT_PENDING',
    'This ROOT has no hosting operation with a created project. See nforge host ROOT --status.',
  );
  const deployment = deploymentUrl(pending.deployment);
  invariant(
    client || resolveAuthToken(deployment),
    'AUTH_REQUIRED',
    'Run nforge login with cli scope before aborting a seed.',
  );
  const api = client ?? coordinationClient(deployment, process.env.FORGE_AUTH_TOKEN);
  let deleted = 0;
  // Bounded batches: a seed holds a page per few hundred objects, so this ends in a few calls.
  for (let batch = 0; batch < 1000; batch++) {
    const result = (await api.mutation(makeFunctionReference<'mutation'>('projectHostedSeed:abort'), {
      projectId: pending.projectId,
      operationId: pending.pushId,
    })) as SeedAbort;
    deleted += result.deleted;
    if (result.status !== 'partial')
      return {
        projectId: pending.projectId,
        seed: result.status,
        deletedPages: deleted,
        message:
          result.status === 'aborted'
            ? 'Seed progress discarded. Run nforge host ROOT --resume to seed again, or --abandon-pending to retire this operation.'
            : 'No seed was started for this operation.',
      };
  }
  throw new Error('Seed abort did not finish; run it again.');
}
