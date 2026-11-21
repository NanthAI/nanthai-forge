// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import { authFile, resolveAuthToken } from './auth-store.js';
import { digest } from './hash.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { deadlineConvexClient } from './network-convex-client.js';
import { exchangeConvexFetch } from './exchange-convex-fetch.js';
import { writeRecoveryText } from './recovery-state.js';
import { refuseRealUserState } from './test-isolation.js';

const record = makeFunctionReference<'mutation', { projectId: string; app: string }, boolean>(
  'agentConnections:record',
);

/** Only servers installed by connect use this, after the client completes the handshake. */
export async function recordAgentConnection({ url, projectId }: HostedAgentAddress, app: string) {
  const token = resolveAuthToken(url);
  if (!token) return;
  const dir = join(dirname(authFile()), 'agent-connections');
  const cache = join(dir, digest(`${url}\0${app}`));
  refuseRealUserState(cache, 'agent connection receipt');
  const key = digest(token);
  try {
    if (readFileSync(cache, 'utf8') === key) return;
  } catch {
    // A missing or unreadable cache just means the server should confirm the connection.
  }
  const client = deadlineConvexClient(
    url,
    { logger: false, skipConvexDeploymentUrlCheck: true, fetch: exchangeConvexFetch() },
    5_000,
  );
  client.setAuth(token);
  if (await client.mutation(record, { app, projectId })) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeRecoveryText(cache, key);
  }
}
