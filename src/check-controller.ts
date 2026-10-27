// SPDX-License-Identifier: Apache-2.0
import { checkWorkerEnv, githubEnvNames, syncEnvNames } from './worker-environment.js';
import { spawn } from 'node:child_process';
import { effectivePolicy } from './autonomy-policy.js';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { durableReplace } from './native-durability.js';
import { mkdirBelow } from './mkdir-below.js';
import { processAlive, processIdentity } from './local-process.js';
import { withQueueSlot } from './landing-queue.js';
import { retryWorkPhase } from './work-retry.js';
import { wakeLandingWorker } from './landing-worker-wake.js';
import { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

const active = (run: CheckRun) => ['queued', 'preparing', 'running'].includes(run.status);
const requestSchema = z.object({
  schema: z.literal(1),
  id: z.uuid(),
  head: z.string(),
  viewId: z.uuid(),
  definition: z.string(),
  environment: z.string(),
  runner: z.object({ pid: z.number(), startTime: z.string().optional(), host: z.string() }),
});
const requestPath = (store: WorkStore, id: string) =>
  join(store.directory, `check-${id}`, 'controller-request.json');
const starting = new Set<string>();

export function hasDetachedCheckRequest(store: WorkStore, run: CheckRun) {
  try {
    const request = requestSchema.parse(JSON.parse(readFileSync(requestPath(store, run.id), 'utf8')));
    return (
      request.id === run.id &&
      request.head === run.head &&
      request.viewId === run.viewId &&
      request.definition === run.check.definition &&
      request.environment === run.environment.fingerprint
    );
  } catch {
    return false;
  }
}

/** The caller only publishes a durable wake. The detached process owns the run
 * lease and physical execution, independently of CLI/MCP disconnection. */
export async function launchDetachedCheck(store: WorkStore, run: CheckRun): Promise<void> {
  const key = `${store.root}:${run.id}`;
  if (starting.has(key)) return;
  const path = requestPath(store, run.id);
  mkdirBelow(store.directory, join(path, '..'));
  durableReplace(
    path,
    JSON.stringify({
      schema: 1,
      id: run.id,
      head: run.head,
      viewId: run.viewId,
      definition: run.check.definition,
      environment: run.environment.fingerprint,
      runner: run.runner,
    }),
  );
  starting.add(key);
  const policy = effectivePolicy(store.readRecords()?.data() ?? store.load());
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./check-controller-worker.js', import.meta.url)), store.root, run.id],
    {
      detached: true,
      stdio: 'ignore',
      env: checkWorkerEnv([run.check], run.backend?.credentialsRef, [
        // Completed checks may wake the configured mirror and hosted metadata sync.
        'FORGE_AUTH_TOKEN',
        ...(policy.githubMirror?.autoPush
          ? syncEnvNames
          : run.backend?.actual === 'github-actions'
            ? githubEnvNames
            : []),
      ]),
    },
  );
  child.once('exit', code => {
    starting.delete(key);
    wakeLandingWorker(store);
    if (code !== 0)
      void import('./work-run.js')
        .then(({ executeOwnedRun }) =>
          executeOwnedRun(store, run, async () => {
            throw new Error('Detached check controller exited before ownership handoff.');
          }),
        )
        .catch(() => wakeLandingWorker(store));
  });
  child.unref();
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', error => {
      starting.delete(key);
      reject(error);
    });
  });
}

export async function runCheckController(
  store: WorkStore,
  id: string,
  execute?: (store: WorkStore, run: CheckRun) => Promise<unknown>,
) {
  return withQueueSlot(
    join(store.directory, 'check-controllers', id),
    async () => {
      const claimed = await retryWorkPhase(id, () =>
        store.locked(() => {
          if (!existsSync(requestPath(store, id))) return;
          const request = requestSchema.parse(JSON.parse(readFileSync(requestPath(store, id), 'utf8')));
          const tx = store.records(),
            selected = tx.find('runs', id),
            run = selected?.record;
          if (
            request.id !== id ||
            !run ||
            !active(run) ||
            run.head !== request.head ||
            run.viewId !== request.viewId ||
            run.check.definition !== request.definition ||
            run.environment.fingerprint !== request.environment ||
            run.runner.host !== hostname()
          )
            return;
          // A previous physical controller may still own execution. The request's
          // exact submitter identity authorizes only the initial ownership handoff.
          const handoff =
            run.runner.pid === request.runner.pid &&
            run.runner.host === request.runner.host &&
            run.runner.startTime === request.runner.startTime;
          if (!handoff && processAlive(run.runner)) return;
          // A delayed duplicate wake must not repeat a local command after its
          // physical controller dies. Normal run recovery ends that attempt.
          if (
            !['modal', 'github-actions'].includes(run.backend?.actual ?? '') &&
            (run.status !== 'queued' || run.childPid)
          )
            return;
          run.runner = { ...processIdentity(), host: hostname() };
          tx.replace('runs', selected!.position, run);
          store.commitRecords(tx);
          return run;
        }),
      );
      if (!claimed) return;
      const { executeOwnedRun } = await import('./work-run.js');
      const { waitForAgentRun } = await import('./agent-run-observer.js');
      await (execute ?? executeOwnedRun)(store, claimed);
      await waitForAgentRun(store, id);
    },
    { waitMs: 0, anchor: store.directory },
  );
}
