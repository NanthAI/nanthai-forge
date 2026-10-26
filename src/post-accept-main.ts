import { setTimeout as delay } from 'node:timers/promises';
import { withDetachedChecks } from './check-execution-context.js';
import { withWorkLockOptions, workQueueWaitMs } from './work-lock.js';
import { readMainAuditState } from './post-accept-state.js';
import { MainAuditWatchdog } from './post-accept-watchdog.js';
import { selectPostAccept } from './post-accept-edit.js';
import { observePostAcceptRecords } from './post-accept-records.js';
// SPDX-License-Identifier: Apache-2.0
import { postAcceptMoves } from './post-accept-coverage.js';
import { WorkService } from './work.js';
import { reuseMainCheck } from './landing-check-reuse.js';
import { checkServiceEnv } from './worker-environment.js';
import { effectivePolicy as childPolicy } from './autonomy-policy.js';
import { workProgress } from './work-progress.js';
import { recoverOptimisticMain, recoveryResult, recoveryAllowed } from './optimistic-recovery.js';
import { wakeGithubPush } from './github-auto-push.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { WorkStore } from './work-store.js';
import { withQueueSlot } from './landing-queue.js';
import { selectMainAudit } from './post-accept-selection.js';
import { checkEnvironment, recoverRuns, runWork, runInterruption } from './work-run.js';
import { foregroundQueued } from './check-queue.js';
import { ForgeError } from './errors.js';
import { failedMainCheck, fixMainIntentId } from './post-accept-fix-forward.js';

/** The acceptance is the durable queue entry. Coalesced wakes invalidate an
 * in-flight snapshot so newly accepted requests receive another observation. */
const waking = new WeakMap<WorkStore, { dirty: boolean }>();
export function wakePostAccept(store: WorkStore) {
  const pending = waking.get(store);
  if (pending) {
    pending.dirty = true;
    return;
  }
  const state = { dirty: true };
  waking.set(store, state);
  void (async () => {
    try {
      do {
        state.dirty = false;
        try {
          publishAuditWake(store, await observePostAcceptRecords(store));
        } catch {
          // Durable requests survive an observation/spawn failure for a later wake.
        }
      } while (state.dirty);
    } finally {
      waking.delete(store);
    }
  })();
}
function publishAuditWake(store: WorkStore, data: import('./work-types.js').WorkData) {
  const moves = data.channelMoves;
  if (
    readMainAuditState(store)?.status !== 'stalled' &&
    !postAcceptMoves(moves).some(move => {
      if (!move.postAccept) return false;
      const run = move.postAcceptRunId && store.select('runs', move.postAcceptRunId);
      return (
        !run ||
        ['cancelled', 'interrupted'].includes(run.status) ||
        (failedMainCheck(run) &&
          !moves.some(
            item =>
              item.optimisticRecovery?.auditRunId === run.id &&
              item.optimisticRecovery.status !== 'fix-forward',
          ) &&
          !store.select('intents', fixMainIntentId(run)))
      );
    })
  )
    return;
  // FORGE_AUTH_TOKEN authenticates hosted metadata emitted by this owner driver.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), store.root], {
    detached: true,
    stdio: 'ignore',
    env: checkServiceEnv(data.checks, childPolicy(data), ['FORGE_AUTH_TOKEN'], { FORGE_CHECK_FULL: '1' }),
  });
  child.on('error', () => {
    /* Durable acceptance remains queued for the next owner observation. */
  });
  child.unref();
}

export async function drainPostAccept(
  store: WorkStore,
  push?: { channel: string; checkId: string },
  options: {
    waitMs?: number;
    timeoutMs?: number;
    progress?: boolean;
    stallMs?: number;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
) {
  const signal = options.signal ?? runInterruption.signal;
  const queueWaitMs = options.waitMs ?? workQueueWaitMs();
  const end = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
  const watchdog = new MainAuditWatchdog(store, options.stallMs ?? 15 * 60_000);
  let reportedAt = -Infinity,
    contention = 0;
  const observe = () => {
    if (signal.aborted)
      throw new ForgeError(
        'CANCELLED',
        'Main audit driver stopped; accepted source and pending checks are retained.',
      );
    if (Date.now() >= end)
      throw new ForgeError(
        'GITHUB_SYNC_AUDIT_TIMEOUT',
        'Main audit wait expired; its original run is retained. Retry github-sync --push --wait-audit.',
      );
    watchdog.updateRuns();
  };
  const sleep = async (ms: number) => {
    observe();
    if (options.sleep) await options.sleep(ms);
    else
      await delay(Math.min(ms, Math.max(1, end - Date.now())), undefined, { signal }).catch(error => {
        if (!signal.aborted) throw error;
      });
    observe();
  };
  return withDetachedChecks(() =>
    withWorkLockOptions({ nonblocking: true, waitMs: 0, cancelled: () => signal.aborted }, async () => {
      const response = await withQueueSlot(
        join(store.directory, 'post-accept-main-queue'),
        async () => {
          for (;;) {
            observe();
            try {
              const pending = await observePostAcceptRecords(store, push, signal);
              watchdog.update(pending);
              if (options.progress && Date.now() - reportedAt >= 5000) {
                const run = pending.runs.find(run => run.mainCheck && !run.endedAt);
                workProgress(
                  'waiting for main audit',
                  run ? `run=${run.id} status=${run.status}` : 'Waiting for audit admission',
                );
                reportedAt = Date.now();
              }
              const failed = pending.runs.find(
                run =>
                  failedMainCheck(run) &&
                  !recoveryResult(pending, run) &&
                  !pending.intents.some(intent => intent.id === fixMainIntentId(run)),
              );
              if (!failed && !selectMainAudit(structuredClone(pending), push)) {
                watchdog.idle();
                wakeGithubPush(store);
                return;
              }
              if (foregroundQueued()) {
                watchdog.waiting();
                await sleep(1000);
                continue;
              }
              if (failed && recoveryAllowed(pending))
                await recoverOptimisticMain(store, failed, () => {
                  observe();
                  watchdog.updateRuns();
                });
              const selected = await selectPostAccept(store, push, signal);
              contention = 0;
              if (!selected) {
                watchdog.idle();
                wakeGithubPush(store);
                return;
              }
              if ('wait' in selected) {
                // Adopters run after publication, outside its pinned observation.
                recoverRuns(store, { runs: (await observePostAcceptRecords(store, push, signal)).runs });
                await sleep(1000);
                continue;
              }
              const { view, runId, checkId, check, revision } = selected;
              if (await reuseMainCheck(new WorkService(store.root), view, runId, check)) continue;
              runWork(
                store,
                {
                  action: 'run-check',
                  operationId: runId,
                  viewId: view.id,
                  expectedHead: view.head!,
                  checkId,
                  expectedDefinition: check.definition,
                  expectedEnvironment: checkEnvironment().fingerprint,
                },
                revision,
              );
            } catch (error) {
              if (!(error instanceof ForgeError && ['WORK_BUSY', 'WORK_STALE'].includes(error.code)))
                throw error;
              const backoff = Math.min(1000 * 2 ** Math.min(contention++, 5), 30_000);
              watchdog.waiting(error.code, backoff);
              await sleep(backoff);
            }
          }
        },
        { anchor: store.directory, waitMs: queueWaitMs, observe },
      );
      if ('waiting' in response) {
        observe();
        throw new ForgeError(
          'WORK_BUSY',
          'Main audit worker is still active; retry to observe its retained run before GitHub push.',
        );
      }
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const push = process.argv[3]
    ? (JSON.parse(process.argv[3]) as { channel: string; checkId: string })
    : undefined;
  drainPostAccept(new WorkStore(process.argv[2]!), push, { signal: controller.signal }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
