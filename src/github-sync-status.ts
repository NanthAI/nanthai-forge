// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { coordinationCredentials } from './coordination-client.js';
import { readHostState } from './host-binding.js';
import { ForgeError } from './errors.js';
import type { WorkStore } from './work-store.js';

/** The binding is already durable Work. Retry publication from that same pushed
 * commit after a lost reply; never repeat a Git push to refresh hosted status. */
export async function publishGithubStatus(store: WorkStore, supplied?: Pick<ConvexHttpClient, 'mutation'>) {
  const host = readHostState(store).binding;
  if (!host) return { status: 'unbound' };
  const data = store.load(),
    binding = data.githubSync;
  const last = binding?.commits[binding.pushed - 1];
  if ((!binding || !last) && !data.githubAutoPush) return { status: 'unpublished' };
  try {
    let client = supplied;
    if (!client) {
      const credentials = coordinationCredentials(host.deployment, process.env.FORGE_AUTH_TOKEN);
      const http = new ConvexHttpClient(credentials.url, {
        skipConvexDeploymentUrlCheck: true,
        logger: false,
        fetch: (input, init) =>
          fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }),
      });
      http.setAuth(credentials.token);
      client = http;
    }
    const metadata = JSON.stringify({
      ownerId: host.operationId,
      revision: data.revision,
      entries: [
        ...(data.githubAutoPush
          ? [
              {
                collection: 'githubAutoPush',
                key: data.githubAutoPush.id,
                parent: '',
                value: data.githubAutoPush,
              },
            ]
          : []),
        ...(binding && last
          ? [
              {
                collection: 'githubSync',
                key: 'github',
                parent: '',
                value: {
                  id: 'github',
                  repository: binding.repository,
                  branch: binding.branch,
                  adoptedCommit: binding.adoptedCommit,
                  commits: [last],
                  pushed: 1,
                  ...(binding.pushedAt ? { pushedAt: binding.pushedAt } : {}),
                },
              },
            ]
          : []),
      ],
    });
    const hash = createHash('sha256').update(metadata).digest('hex');
    const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    await client.mutation(makeFunctionReference<'mutation'>('projectGithubStatus:publish'), {
      projectId: host.projectId,
      operationId,
      metadata,
    });
    return { status: 'published' };
  } catch (error) {
    return {
      status: 'deferred',
      code: error instanceof ForgeError ? error.code : 'HOSTED_SYNC_PENDING',
      retry: 'nforge github-sync ROOT --push',
    };
  }
}
