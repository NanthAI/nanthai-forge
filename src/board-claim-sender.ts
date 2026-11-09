// SPDX-License-Identifier: Apache-2.0
// Detached sender for automatic file claims (Issue 9c8490a4, board Lane 4). Started by the
// first-write hook while it holds the per-Lane lock; never on the hook's critical path. It waits a
// short window so first writes that arrive together go up in one mutation, sends, and exits once
// the spool stays empty. Advisory: any failure drops the claim (peers then just see less).
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { utimesSync } from 'node:fs';
import {
  acquireClaimLock,
  claimSpoolPending,
  drainClaimSpool,
  releaseClaimLock,
  spawnSender,
  type SpawnSender,
} from './board-claim-queue.js';
import { clientCacheRoot } from './root-paths.js';

/** First writes within this window share one claim mutation. */
export const CLAIM_BATCH_WINDOW_MS = 1_500;
/** At most this many windows per sender process (then it hands a pending spool to a fresh sender). */
export const CLAIM_SENDER_ROUNDS = 8;
const BATCH = 10;

export type ClaimMutate = (args: { projectId: string; laneId: string; paths: string[] }) => Promise<unknown>;

async function defaultMutate(url: string): Promise<ClaimMutate> {
  const { deadlineConvexClient } = await import('./network-convex-client.js');
  const { makeFunctionReference } = await import('convex/server');
  const { networkFetch, networkTimeout } = await import('./network-fetch.js');
  const { resolveAuthToken, deploymentUrl } = await import('./auth-store.js');
  const deployment = deploymentUrl(url);
  const token = resolveAuthToken(deployment);
  if (!token) throw new Error('Unavailable login');
  const client = deadlineConvexClient(
    deployment,
    {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
      fetch: (input, init) =>
        networkFetch(input, { ...init, redirect: 'error', signal: networkTimeout(5_000) }, { retries: 0 }),
    },
    5_000,
  );
  client.setAuth(token);
  return args => client.mutation(makeFunctionReference<'mutation'>('projectBoardClaims:claim'), args);
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** Runs while holding the lock. Returns the mutations made (one per ≤10 paths per window). */
export async function runClaimSender(
  lane: { root: string; laneId: string; project: string; url: string },
  options: { mutate?: ClaimMutate; windowMs?: number; rounds?: number; handoff?: SpawnSender } = {},
) {
  let calls = 0,
    held = true,
    mutate = options.mutate;
  const lock = join(clientCacheRoot(lane.root), 'board', `${lane.laneId}.claims.lock`);
  try {
    for (let round = 0; round < (options.rounds ?? CLAIM_SENDER_ROUNDS); round++) {
      await sleep(options.windowMs ?? CLAIM_BATCH_WINDOW_MS);
      try {
        const now = new Date();
        utimesSync(lock, now, now);
      } catch {
        /* Lock gone: finish this round, then stop. */
      }
      const paths = drainClaimSpool(lane.root, lane.laneId);
      if (!paths.length) {
        releaseClaimLock(lane.root, lane.laneId);
        held = false;
        // A first write between the drain and the release found the lock held: take it back.
        if (claimSpoolPending(lane.root, lane.laneId) && acquireClaimLock(lane.root, lane.laneId)) {
          held = true;
          continue;
        }
        return calls;
      }
      try {
        mutate ??= await defaultMutate(lane.url);
        for (let i = 0; i < paths.length; i += BATCH) {
          calls++;
          await mutate({ projectId: lane.project, laneId: lane.laneId, paths: paths.slice(i, i + BATCH) });
        }
      } catch {
        /* Advisory: drop this batch. */
      }
    }
    // Rounds spent. First writes spooled during the last window found the lock held and queued
    // behind it; releasing now would leave them unsent until some later first write. Pass the lock
    // on to a fresh sender instead (the lock file stays; the successor owns it).
    if (claimSpoolPending(lane.root, lane.laneId)) {
      (options.handoff ?? spawnSender)(lane);
      held = false;
    }
    return calls;
  } finally {
    if (held) releaseClaimLock(lane.root, lane.laneId);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, laneId, project, url] = process.argv.slice(2);
  if (root && laneId && project && url)
    await runClaimSender({ root, laneId, project, url }).catch(() => undefined);
}
