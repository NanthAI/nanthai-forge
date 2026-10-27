// SPDX-License-Identifier: Apache-2.0
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { invariant } from './errors.js';
import {
  releaseJson,
  releaseSave,
  releaseSelection,
  releaseWrite,
  releaseQuote,
} from './maintainer-release-files.js';
import { selectOwnerInstall } from './release-owner-selection.js';
import type { ReleaseJournal } from './maintainer-release-schema.js';
import { launchdOwnerSupervisor, type OwnerSupervisor } from './release-owner-supervisor.js';
import {
  belowRuntime,
  oldReleaseWorker,
  releaseProcesses,
  sameReleaseProcess,
  signalReleaseProcess,
  type ReleaseProcess,
} from './release-owner-processes.js';
import { readOwnerRuntime, publicOwnerRuntime, type OwnerRuntime } from './release-owner-runtime.js';
import { processStartTime } from './local-process.js';

const identity = z.object({ pid: z.number().int(), startTime: z.string(), executablePath: z.string() });
const stateSchema = z.object({
  service: z.object({ id: z.string(), cli: z.string() }),
  installed: z.string(),
  previous: z.object({ kind: z.enum(['file', 'symlink']), mode: z.number(), sha256: z.string() }),
  baseline: z.object({ pid: z.number(), startTime: z.string() }).optional(),
  restartRequested: z.boolean().default(false),
  verified: identity.optional(),
  retired: z.array(identity.extend({ signals: z.array(z.enum(['SIGTERM', 'SIGKILL'])), gone: z.boolean() })),
});
type State = z.infer<typeof stateSchema>;
export type OwnerReleaseDependencies = {
  supervisor: OwnerSupervisor;
  processes(): ReleaseProcess[];
  signal(target: ReleaseProcess, signal: 'SIGTERM' | 'SIGKILL'): boolean;
  runtime(): OwnerRuntime | undefined;
  answers(runtime: OwnerRuntime): Promise<boolean>;
  startTime(pid: number): string | undefined;
  sleep(ms: number): Promise<unknown>;
  waitMs: number;
  now(): number;
};
async function answers(runtime: OwnerRuntime) {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/owner`, {
      headers: { authorization: `Bearer ${runtime.token}` },
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    return (
      response.ok && JSON.stringify(await response.json()) === JSON.stringify(publicOwnerRuntime(runtime))
    );
  } catch {
    return false;
  }
}
/** All side effects reconcile from a release-owned plan, shared across failed attempts. */
export async function selectReleaseOwner(
  journal: ReleaseJournal,
  installDirectory: string,
  installedCli: string,
  overrides: Partial<OwnerReleaseDependencies> = {},
): Promise<Record<string, string>> {
  const deps: OwnerReleaseDependencies = {
    supervisor: launchdOwnerSupervisor(),
    processes: releaseProcesses,
    signal: signalReleaseProcess,
    runtime: () => readOwnerRuntime(join(journal.owner, '.forge', 'work')),
    answers,
    startTime: processStartTime,
    sleep: delay,
    waitMs: 10_000,
    now: () => performance.now(),
    ...overrides,
  };
  const path = join(journal.directory, 'owner-selection.json');
  const backup = join(journal.directory, 'previous-owner-cli');
  let state: State;
  if (existsSync(path)) state = stateSchema.parse(releaseJson(path));
  else {
    const service = await deps.supervisor.discover(journal.owner, journal.request.runtimeDirectory);
    if (!service)
      return {
        note: 'Owner selection skipped: no supervised owner exists for this owner.',
        owner: 'skipped',
      };
    invariant(
      (belowRuntime(journal.request.runtimeDirectory, service.cli) ||
        belowRuntime(realpathSync(journal.request.runtimeDirectory), service.cli)) &&
        belowRuntime(realpathSync(journal.request.runtimeDirectory), realpathSync(service.cli)),
      'RELEASE_OWNER_PATH',
      'Owner entry point must remain within the runtime directory.',
    );
    const previous = releaseSelection(service.cli);
    invariant(previous.kind !== 'absent', 'RELEASE_OWNER_PATH', 'Owner entry point is absent.');
    const pid = await deps.supervisor.pid(service);
    const startTime = pid ? deps.startTime(pid) : undefined;
    invariant(!pid || startTime, 'PROCESS_IDENTITY_UNAVAILABLE', 'Could not identify the supervised owner.');
    releaseWrite(backup, previous.bytes);
    state = {
      service,
      installed: realpathSync(installedCli),
      previous: { kind: previous.kind, mode: previous.mode, sha256: previous.sha256 },
      ...(pid && startTime ? { baseline: { pid, startTime } } : {}),
      restartRequested: false,
      // Resolve old aliases before switching them: ps retains the original argv
      // path even after installed-owner points at the new package.
      retired: deps
        .processes()
        .filter(worker =>
          oldReleaseWorker(journal.request.runtimeDirectory, realpathSync(installDirectory), worker),
        )
        .map(worker => ({ ...worker, signals: [], gone: false })),
    };
    releaseSave(path, state);
  }
  const save = () => releaseSave(path, state);
  invariant(
    state.installed === realpathSync(installedCli),
    'WORK_OPERATION_CHANGED',
    'Retain the selected owner install.',
  );
  const installed = realpathSync(installDirectory);
  invariant(
    belowRuntime(realpathSync(journal.request.runtimeDirectory), installed) &&
      state.installed === realpathSync(join(installed, 'node_modules/@nanthai/forge/dist/cli.js')),
    'RELEASE_OWNER_PATH',
    'New owner install is outside the runtime directory.',
  );
  const selection = selectOwnerInstall(journal.directory, state.service.cli, installDirectory);
  const rollbackCommand = `${selection.rollbackCommand} && launchctl kickstart -k ${releaseQuote(state.service.id)}`;
  const unverified = `The owner did not verify the selected install. Rollback: ${rollbackCommand}`;
  const probe = async () => {
    const runtime = deps.runtime();
    if (
      !runtime ||
      runtime.owner !== journal.owner ||
      runtime.executablePath !== state.installed ||
      runtime.pid !== (await deps.supervisor.pid(state.service)) ||
      deps.startTime(runtime.pid) !== runtime.startTime ||
      !(await deps.answers(runtime))
    )
      return;
    return { pid: runtime.pid, startTime: runtime.startTime, executablePath: runtime.executablePath };
  };
  const wait = async () => {
    const deadline = deps.now() + deps.waitMs;
    for (;;) {
      const observed = await probe();
      if (observed) return observed;
      if (deps.now() >= deadline) return;
      await deps.sleep(Math.min(100, deadline - deps.now()));
    }
  };
  let verified = await probe();
  if (!verified && state.restartRequested) verified = await wait(); // Lost restart reply: observe first.
  if (!verified) {
    const pid = await deps.supervisor.pid(state.service);
    invariant(
      !pid || (state.baseline?.pid === pid && state.baseline.startTime === deps.startTime(pid)),
      'RELEASE_OWNER_UNVERIFIED',
      unverified,
    );
    state.restartRequested = true;
    save();
    await deps.supervisor.restart(state.service);
    verified = await wait();
  }
  invariant(verified, 'RELEASE_OWNER_UNVERIFIED', unverified);
  state.verified = verified;
  save();
  // Pinned membership stays authoritative, except that check controllers finish on their own runtime.
  const checkController = (worker: { executablePath: string }) =>
    worker.executablePath.split('/').at(-1) === 'check-controller-worker.js';
  // Re-scan after draining: old workers may have spawned children during shutdown.
  for (;;) {
    const remaining = deps
      .processes()
      .filter(
        worker =>
          !checkController(worker) &&
          (oldReleaseWorker(journal.request.runtimeDirectory, installed, worker) ||
            state.retired.some(previous => sameReleaseProcess(previous, worker))),
      );
    if (!remaining.length) break;
    for (const worker of remaining) {
      if (!state.retired.some(previous => sameReleaseProcess(previous, worker))) {
        state.retired.push({ ...worker, signals: [], gone: false });
        save();
      }
    }
    for (const worker of state.retired) {
      // Older plans may include an in-flight check controller; preserve it on resume too.
      if (checkController(worker)) continue;
      const live = () => deps.processes().some(current => sameReleaseProcess(current, worker));
      const send = (signal: 'SIGTERM' | 'SIGKILL') => {
        // Membership was pinned before selection or established by a later scan.
        // Re-resolving an old alias here would mistake it for the new install.
        if (!live()) return;
        worker.signals.push(signal);
        save(); // Retain intent before signalling, including a lost signal reply.
        deps.signal(worker, signal);
      };
      if (!worker.signals.includes('SIGKILL')) send('SIGTERM');
      for (const deadline = deps.now() + deps.waitMs; live() && deps.now() < deadline;)
        await deps.sleep(Math.min(100, deadline - deps.now()));
      if (live()) send('SIGKILL');
      for (const deadline = deps.now() + deps.waitMs; live() && deps.now() < deadline;)
        await deps.sleep(Math.min(100, deadline - deps.now()));
      worker.gone = !live();
      save();
      invariant(
        worker.gone,
        'RELEASE_WORKER_SURVIVED',
        'A previous-runtime worker remains; resume its retained retirement.',
      );
    }
  }
  verified = await probe();
  invariant(verified, 'RELEASE_OWNER_UNVERIFIED', unverified);
  state.verified = verified;
  save();
  return {
    owner: 'selected',
    supervisor: state.service.id,
    selectionPath: selection.selectionPath,
    installedDirectory: installed,
    previousInstall: selection.previousInstall,
    rollbackCommand,
    executablePath: state.installed,
    previousOwnerCli: backup,
    previousOwnerKind: state.previous.kind,
    previousOwnerMode: String(state.previous.mode),
    previousOwnerSha256: state.previous.sha256,
    process: JSON.stringify(verified),
    retiredWorkers: JSON.stringify(state.retired),
    note: state.restartRequested
      ? 'Owner restarted and verified; previous entry point retained for rollback.'
      : 'Owner already runs the selected install; no restart needed.',
  };
}
