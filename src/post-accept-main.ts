// SPDX-License-Identifier: Apache-2.0
import { recoverOptimisticMain, recoveryResult } from './optimistic-recovery.js';
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
import { failedMainCheck, fixMainIntentId, recordFixForward } from './post-accept-fix-forward.js';

/** The acceptance itself is the durable queue entry. Lost wakeups are recovered
 * by the next acceptance/status; run IDs are stable across worker restarts. */
export function wakePostAccept(store: WorkStore) {
  const moves = store.page('channelMoves', 0, Number.MAX_SAFE_INTEGER).records as ReturnType<
    WorkStore['load']
  >['channelMoves'];
  if (
    !moves.some(move => {
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
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), store.root], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FORGE_CHECK_FULL: '1' },
  });
  child.on('error', () => {
    /* Durable acceptance remains queued for the next owner observation. */
  });
  child.unref();
}

export async function drainPostAccept(store: WorkStore, push?: { channel: string; checkId: string }) {
  const response = await withQueueSlot(
    join(store.directory, 'post-accept-main-queue'),
    async () => {
      for (;;) {
        if (runInterruption.signal.aborted)
          throw new ForgeError(
            'CANCELLED',
            'Main audit interrupted by a termination signal; accepted source and pending audit are retained.',
          );
        if (foregroundQueued()) {
          await new Promise(resolve => setTimeout(resolve, 250));
          continue;
        }
        wakeGithubPush(store);
        try {
          const pending = store.load();
          const failed = pending.runs.find(
            run =>
              failedMainCheck(run) &&
              !recoveryResult(pending, run) &&
              !pending.intents.some(intent => intent.id === fixMainIntentId(run)),
          );
          if (failed) await recoverOptimisticMain(store, failed);
          const selected = store.locked(() => {
            // Recheck before loading Work: foreground arrivals never make a waiting
            // audit repeatedly deserialize owner history or contend on its lock.
            if (foregroundQueued()) return { wait: true as const };
            const data = store.load();
            const recovered = recoverRuns(store, data);
            if (recordFixForward(data) || recovered) {
              data.revision++;
              store.save(data);
            }
            const before = JSON.stringify(data);
            const selected = selectMainAudit(data, push);
            if (JSON.stringify(data) !== before) {
              data.revision++;
              store.save(data);
            }
            if (!selected) return;
            if ('wait' in selected) return { wait: true as const };
            // The owner may publish finish/lifecycle changes as soon as this lock
            // releases. Carry these pins with the selection rather than rereading
            // the mutable Work pointer before the run has been reserved.
            return {
              ...selected,
              check: data.checks.find(check => check.id === selected.checkId)!,
              revision: data.revision,
            };
          });
          if (!selected) return;
          if ('wait' in selected) {
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
          }
          const { view, runId, checkId, check, revision } = selected;
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
          if (!(error instanceof ForgeError && ['WORK_BUSY', 'WORK_STALE'].includes(error.code))) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    },
    { anchor: store.directory },
  );
  if ('waiting' in response)
    throw new ForgeError(
      'WORK_BUSY',
      'Main audit worker is still active; retry to observe its retained run before GitHub push.',
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  drainPostAccept(new WorkStore(process.argv[2]!)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
