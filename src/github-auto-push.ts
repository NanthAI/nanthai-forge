// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkStore } from './work-store.js';
import { withQueueSlot } from './landing-queue.js';
import { effectivePolicy } from './autonomy-policy.js';
import { latestMain, pendingGithubPush } from './github-auto-push-state.js';
import { githubSync } from './github-sync.js';
import { publishGithubStatus } from './github-sync-status.js';
import { processAlive, processIdentity } from './local-process.js';
import { ForgeError } from './errors.js';
import type { GithubAutoPush } from './github-sync-types.js';

const undo =
  'Disable future pushes with set-policy githubMirror.autoPush:false. Published history is retained; undo source through a compensating Lane.';
/** Accepted main and retained sync mappings are the durable queue. Status and
 * later acceptances recover lost wakeups, using the original pending push UUID. */
export function wakeGithubPush(store: WorkStore) {
  try {
    if (!store.native) return;
    const summary = store.readRecords()?.data() ?? store.load();
    if (!effectivePolicy(summary).githubMirror?.autoPush) return;
    const data = store.load();
    if (!pendingGithubPush(data) || (data.githubAutoPush?.worker && processAlive(data.githubAutoPush.worker)))
      return;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), store.root], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.on('error', () => {
      /* Retry on the next owner observation. */
    });
    child.unref();
  } catch {
    // Observing a concurrently replaced Work manifest can fail transiently.
    // A wakeup must never change the outcome of the already durable acceptance.
  }
}
export async function drainGithubPush(
  store: WorkStore,
  options: {
    debounceMs?: number;
    retryMs?: number;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
) {
  const sleep = options.sleep ?? delay;
  await sleep(options.debounceMs ?? 200);
  try {
    return await withQueueSlot(
      join(store.directory, 'github-auto-push-queue'),
      async () => {
        for (;;) {
          const selected = store.locked(() => {
            const data = store.load();
            if (!pendingGithubPush(data)) return;
            const move = latestMain(data)!,
              policy = effectivePolicy(data).githubMirror!;
            const old = data.githubAutoPush,
              binding = data.githubSync;
            const pending = binding && binding.commits.slice(binding.pushed).at(-1);
            const status: GithubAutoPush = {
              worker: processIdentity(process.pid),
              id: 'github-auto-push',
              repository: policy.repo,
              acceptanceId: move.id,
              state: move.head,
              operationId:
                pending?.operationId ??
                (old?.acceptanceId === move.id && old.status !== 'pushed' ? old.operationId : randomUUID()),
              status: 'queued',
              attempts: old?.acceptanceId === move.id ? old.attempts : 0,
              at: new Date().toISOString(),
              undo,
            };
            data.githubAutoPush = status;
            data.revision++;
            store.save(data);
            return status;
          });
          if (!selected) return;
          const update = async (patch: Partial<GithubAutoPush>) => {
            store.locked(() => {
              const data = store.load();
              data.githubAutoPush = { ...selected, ...patch, at: new Date().toISOString() };
              Object.assign(selected, data.githubAutoPush);
              data.revision++;
              store.save(data);
            });
            await publishGithubStatus(store);
          };
          await publishGithubStatus(store);
          for (;;) {
            const data = store.load();
            if (!pendingGithubPush(data)) return;
            const policy = effectivePolicy(data).githubMirror;
            if (!policy?.autoPush || policy.repo !== selected.repository) return;
            if (selected.nextAttemptAt)
              await sleep(Math.max(0, Date.parse(selected.nextAttemptAt) - Date.now()));
            // Re-read policy/main after backoff; a disabled policy never starts another push.
            const current = store.load();
            if (
              !pendingGithubPush(current) ||
              effectivePolicy(current).githubMirror?.repo !== selected.repository
            )
              return;
            await update({ status: 'pushing', attempts: selected.attempts + 1, nextAttemptAt: '' });
            try {
              const result = await githubSync(store.root, {
                repository: selected.repository,
                branch: 'main',
                push: true,
                operationId: selected.operationId,
                autoPush: true,
              });
              const last = result.commits.at(-1);
              await update({
                status: 'pushed',
                code: '',
                detail: '',
                worker: undefined,
                ...(last ? { state: last.state, acceptanceId: last.acceptanceId } : {}),
              });
              break;
            } catch (error) {
              const code = error instanceof ForgeError ? error.code : 'GITHUB_SYNC_FAILED';
              if (code === 'GITHUB_SYNC_CHECK_PENDING') return;
              if (code === 'GITHUB_SYNC_CHANGED') {
                const heads = error as ForgeError & {
                  expectedHead?: string;
                  remoteHead?: string;
                  localHead?: string;
                };
                await update({
                  status: 'needs-you',
                  worker: undefined,
                  code,
                  detail: (error as Error).message,
                  expectedHead: heads.expectedHead,
                  remoteHead: heads.remoteHead,
                  localHead: heads.localHead,
                });
                return;
              }
              const transient = ['GITHUB_SYNC_GIT_FAILED', 'WORK_STALE', 'WORK_BUSY'].includes(code);
              if (!transient) {
                await update({ status: 'failed', worker: undefined, code });
                return;
              }
              const backoff = Math.min(
                60_000,
                (options.retryMs ?? 1000) * 2 ** Math.min(selected.attempts - 1, 6),
              );
              await update({
                status: 'retrying',
                code,
                nextAttemptAt: new Date(Date.now() + backoff).toISOString(),
              });
            }
          }
        }
      },
      { anchor: store.directory },
    );
  } finally {
    try {
      store.locked(() => {
        const data = store.load();
        if (data.githubAutoPush?.worker?.pid !== process.pid) return;
        delete data.githubAutoPush.worker;
        data.revision++;
        store.save(data);
      });
    } catch {
      /* An exited worker is recoverable by its kernel process identity. */
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  drainGithubPush(new WorkStore(process.argv[2]!)).catch(() => {
    process.exitCode = 1;
  });
}
