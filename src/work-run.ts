import { launchGithubActionsRun } from './work-github-actions-run.js';
import { mkdirBelow } from './mkdir-below.js';
import { pollCancellation } from './work-cancel-poll.js';
import { shardLogName } from './modal-shard-logs.js';
import { localCost, modalRunCost } from './check-cost.js';
import { checkRoute } from './check-backend.js';
import { launchModalRun } from './work-modal-run.js';
// SPDX-License-Identifier: Apache-2.0
import { withWorkLockOptions } from './work-lock.js';
import { wakeGithubPush } from './github-auto-push.js';
import { lightweightDocsRun } from './work-docs-admission.js';
import { interactionEvidence } from './work-interaction.js';
import { writeCheckScope } from './work-check-scope.js';
import { failureSummary } from './agent-run-failure.js';
import { receiptSchema, createRunReceipt } from './work-run-receipt.js';
import { automaticCleanup } from './work-auto-clean.js';
import { readPolicy } from './work-autonomy.js';
import { CheckQueue, foregroundQueued } from './check-queue.js';
import { diskGuard } from './disk-guard.js';
import { processAlive, processIdentity, processStartTime, processGroupAlive } from './local-process.js';
import { spawn } from 'node:child_process';
import { recoverRecordRuns } from './work-record-runs.js';
import { SelectedRunObserver } from './work-run-observation.js';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeSource } from './native-source.js';
import { readSource } from './files.js';
import { ForgeError, invariant } from './errors.js';
import { evidenceView } from './work-evidence.js';
import { executionGuard, workGit } from './work-git.js';
import { checkRunSchema, type CheckRun, type EvidenceCommand, type WorkData } from './work-types.js';
import type { WorkStore } from './work-store.js';
import { captureArtifacts } from './work-artifacts.js';
import { observeCheckInputs } from './work-inputs.js';
import { resourceCommand, readResources } from './work-resources.js';

export const runInterruption = new AbortController();

const active = (run: CheckRun) =>
  run.status === 'queued' || run.status === 'preparing' || run.status === 'running';
const directory = (store: WorkStore, id: string) => join(store.directory, `check-${id}`);
export { checkEnvironment } from './check-environment.js';
import {
  checkEnvironment,
  checkProcessEnvironment,
  checkEnvironmentDescription,
} from './check-environment.js';
function safeDirectory(path: string): boolean {
  return (
    existsSync(path) &&
    lstatSync(path).isDirectory() &&
    !lstatSync(path).isSymbolicLink() &&
    realpathSync(path) === path
  );
}
export function runOutputDirectory(store: WorkStore, id: string) {
  const path = directory(store, id);
  invariant(safeDirectory(path), 'NOT_FOUND', 'Run output directory is unavailable.');
  return path;
}
const adoptingModalRuns = new Set<string>();
export function recoverRuns(store: WorkStore, data: Pick<WorkData, 'runs'>): boolean {
  let changed = false;
  for (const run of data.runs.filter(active)) {
    const path = directory(store, run.id);
    try {
      const bytes = safeDirectory(path) ? readSource(path, 'result.json', 4 * 1024 * 1024) : null;
      if (bytes) {
        const result = receiptSchema.safeParse(JSON.parse(bytes.toString('utf8')));
        if (
          result.success &&
          (!['modal', 'github-actions'].includes(run.backend?.actual ?? '') ||
            result.data.backend?.pin === run.backend?.pin)
        ) {
          Object.assign(run, result.data);
          changed = true;
          continue;
        }
      }
    } catch {
      /* Ambiguous output never manufactures a successful result. */
    }
    if (run.runner.host !== hostname()) continue;
    if (['modal', 'github-actions'].includes(run.backend?.actual ?? '') && !processAlive(run.runner)) {
      const key = `${store.root}:${run.id}`;
      if (!adoptingModalRuns.has(key)) {
        adoptingModalRuns.add(key);
        queueMicrotask(() => {
          void adoptModalRun(store, run.id).finally(() => adoptingModalRuns.delete(key));
        });
      }
      continue;
    }
    if (!processAlive(run.runner)) {
      run.status = 'interrupted';
      run.endedAt = new Date().toISOString();
      run.details =
        'Runner process ended or its PID was reused before a completion record. Workspace/output are retained; the original command is not repeated.';
      if (processGroupAlive(run.childPid, run.childStartTime))
        run.details +=
          ' Its process group is still alive; check capacity and workspace are retained until it exits.';
      if (run.check.measureResources) run.resourceUsage = readResources(path);
      changed = true;
    }
  }
  return changed;
}
/** Claim the current stored runner under the owner lock before starting an adopter.
 * Observation copies never acquire execution ownership or overwrite a live runner. */
export async function adoptModalRun(
  store: WorkStore,
  id: string,
  start: (store: WorkStore, run: CheckRun) => Promise<unknown> = launch,
): Promise<void> {
  let claimed: CheckRun | undefined;
  try {
    store.locked(() => {
      const tx = store.records(),
        selected = tx.find('runs', id),
        run = selected?.record;
      if (
        !run ||
        !active(run) ||
        !['modal', 'github-actions'].includes(run.backend?.actual ?? '') ||
        run.runner.host !== hostname() ||
        processAlive(run.runner)
      )
        return;
      run.runner = { ...processIdentity(), host: hostname() };
      tx.replace('runs', selected!.position, run);
      store.commitRecords(tx);
      claimed = run;
    });
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'WORK_BUSY') {
      await new Promise(resolve => setTimeout(resolve, 250));
      return adoptModalRun(store, id, start);
    }
    throw error;
  }
  if (claimed) await start(store, claimed);
}
function saveCompletion(store: WorkStore, id: string, complete?: (error?: unknown) => void) {
  try {
    store.locked(() => {
      const tx = store.records(),
        selected = tx.find('runs', id),
        run = selected?.record;
      if (run && active(run) && recoverRuns(store, { runs: [run] })) {
        tx.replace('runs', selected!.position, run);
        store.commitRecords(tx);
      }
    });
    if (store.native) automaticCleanup(store, `check:${id}`, 'check runner', { runId: id });
    wakeGithubPush(store);
    complete?.();
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'WORK_BUSY')
      setTimeout(() => saveCompletion(store, id, complete), 250);
    else complete?.(error);
    // The durable receipt remains inspectable/reconcilable if metadata cannot be saved.
  }
}
async function launch(store: WorkStore, run: CheckRun, complete?: (error?: unknown) => void): Promise<void> {
  if (run.backend?.actual === 'github-actions') {
    await launchGithubActionsRun(store, run);
    saveCompletion(store, run.id, complete);
    return;
  }
  if (run.backend?.actual === 'modal') {
    if (await launchModalRun(store, run, undefined, 1)) {
      saveCompletion(store, run.id, complete);
      return;
    }
  }
  return launchLocal(store, run, complete);
}
async function launchLocal(
  store: WorkStore,
  run: CheckRun,
  complete?: (error?: unknown) => void,
): Promise<void> {
  const lightweight = await lightweightDocsRun(store, run);
  const path = directory(store, run.id),
    workspace = join(path, 'workspace');
  const processEnvironment = checkProcessEnvironment(run.check, run.environment, path);
  let child: ReturnType<typeof spawn> | undefined;
  let queue: CheckQueue | undefined;
  let queuedPoll: ReturnType<typeof setTimeout> | undefined;
  let warnings = run.warnings ?? [];
  const selected = new SelectedRunObserver(store, run.id);
  let poll: ReturnType<typeof setInterval> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let finished = false;
  let measured: ReturnType<typeof resourceCommand>;
  const onSignal = () => {
    runInterruption.abort();
    stopping = true;
    if (child?.pid) {
      stop('SIGKILL');
      return; // The close event records the command's actual exit/signal.
    }
    void finish(null, null, 'Finish interrupted by a signal before its check started.');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGHUP', onSignal);
  const stop = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      /* Exited groups are reconciled by the child's close event; never signal an unrelated stored PID. */
    }
  };
  const finish = async (
    code: number | null,
    signal: NodeJS.Signals | null,
    failure?: string,
    error?: CheckRun['error'],
  ) => {
    if (finished) return;
    stopping ||= queue?.cancelled() ?? false;
    if (stopping && !failure)
      failure = run.mainCheck
        ? 'Main audit cancelled or yielded to foreground work. Evidence is retained; the scheduler retries latest main when the queue is idle.'
        : 'Check cancelled by its finish or queue controller. Evidence is retained; a new run operation can retry execution.';
    finished = true;
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    process.off('SIGHUP', onSignal);
    if (poll) clearInterval(poll);
    if (queuedPoll) clearTimeout(queuedPoll);
    if (escalation) clearTimeout(escalation);
    if (stopping) stop('SIGKILL');
    let details =
      checkEnvironmentDescription(run.check) +
      ' ' +
      (failure ??
        'Recorded command outcome. Coverage and external inputs are unknown; no checks or reviews are automatically reused.');
    if (!stopping && code !== 0 && processEnvironment.omitted.length)
      warnings.push(`Clean environment; may need env passthrough: ${processEnvironment.omitted.join(', ')}`);
    if (run.backend?.fallback) details += ` ${run.backend.fallback}`;
    if (measured)
      details +=
        ' Exit/signal belong to the native time wrapper; it reports the selected command exit status and may encode command signals as exit codes.';
    let artifacts: CheckRun['artifacts'];
    try {
      if (run.check.artifactPaths?.length && existsSync(workspace) && error?.code !== 'DISK_LOW')
        artifacts = await captureArtifacts(workspace, path, run.check.artifactPaths);
    } catch {
      artifacts = run.check.artifactPaths?.map(sourcePath => ({
        status: 'unavailable',
        sourcePath,
        details: 'Build-output capture was interrupted. Existing workspace/bytes are retained.',
      }));
    }
    let cleanup: (() => void) | undefined;
    if (existsSync(workspace) && error?.code !== 'DISK_LOW') {
      try {
        const detached =
          store.native || workGit(workspace, ['symbolic-ref', '-q', 'HEAD'], undefined, true).trim() === '';
        const native = new NativeSource(store.root);
        const unchanged = store.native
          ? native.tree(native.capture(workspace, false, run.head)) ===
            native.tree(native.state(run.head).files)
          : workGit(workspace, ['rev-parse', 'HEAD']).trim() === run.head &&
            !workGit(workspace, ['status', '--porcelain', '--untracked-files=no']).trim();
        let descendants = false;
        if (child?.pid && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 0);
            descendants = true;
          } catch {
            /* No remaining process group. */
          }
        }
        const blockers = [
          !safeDirectory(workspace) && 'the workspace is not a plain directory',
          !detached && 'the branch changed',
          !unchanged && 'source differs from the run State',
          descendants && 'a process group remains',
          artifacts?.some(item => item.status === 'unavailable') && 'selected output capture is incomplete',
        ].filter(Boolean);
        if (!blockers.length)
          cleanup = () => {
            if (store.native) {
              // Policy-enabled cleanup validates and records its action after publication.
              // Other presets retain legacy cleanup without changing Work format or run evidence.
              if (readPolicy(store).lifecycle.cleanRegenerableCopies) return;
              rmSync(workspace, { recursive: true });
            } else workGit(store.root, ['worktree', 'remove', '--force', workspace]);
            rmSync(join(path, 'runtime'), { recursive: true, force: true });
          };
        else
          details += ` Run workspace retained: ${blockers.join('; ')}. nforge agent ROOT clean removes it once the run is finished.`;
      } catch {
        details += ' Run workspace cleanup is unconfirmed; existing files are retained.';
      }
    }
    let checkSelection: CheckRun['checkSelection'];
    try {
      const bytes = readSource(path, 'selection.json', 4 * 1024 * 1024);
      if (bytes) {
        const parsed = checkRunSchema.shape.checkSelection.safeParse(JSON.parse(bytes.toString('utf8')));
        if (parsed.success && parsed.data && (parsed.data.scope !== 'interaction' || run.interaction)) {
          checkSelection = parsed.data;
          details += ` Check selection: ${checkSelection.scope}; ${checkSelection.reason}; ${checkSelection.tests.length} test files (command-reported).`;
        }
      }
    } catch {
      /* Optional command-reported selection is unavailable; logs retain command output. */
    }
    const receipt = createRunReceipt({
      backend: {
        ...(run.backend ?? { requested: 'local', actual: 'local' }),
        cost:
          run.backend?.costUsage ||
          (run.backend?.requested === 'modal' && run.backend.estimatedCostUsd !== undefined)
            ? {
                ...modalRunCost(run.backend),
                basis: modalRunCost(run.backend).basis + ' Local fallback adds no provider runner charge.',
              }
            : localCost(run.id),
      },
      status: stopping ? 'cancelled' : code === 0 && !failure ? 'passed' : 'failed',
      ...(!stopping && (code !== 0 || failure) ? { failureSummary: failureSummary(store, run) } : {}),
      exitCode: code,
      signal,
      endedAt: new Date().toISOString(),
      details,
      ...(warnings.length ? { warnings } : {}),
      ...(error ? { error } : {}),
      ...(artifacts ? { artifacts } : {}),
      ...(checkSelection ? { checkSelection } : {}),
      ...(run.check.measureResources ? { resourceUsage: readResources(path, measured?.producer) } : {}),
    });
    const temp = join(path, `${randomUUID()}.tmp`);
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(receipt));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, join(path, 'result.json'));
      const parent = openSync(path, 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
      receiptSchema.parse(JSON.parse(readSource(path, 'result.json', 4 * 1024 * 1024)!.toString('utf8')));
      try {
        cleanup?.();
      } catch {
        /* Terminal receipt is durable; retain any remaining files. */
      }

      queue?.release();
      saveCompletion(store, run.id, complete);
    } catch (error) {
      complete?.(error); /* Unknown completion never authorizes another Playbook step. */
    }
  };
  const preparationFailed = (error: unknown) => {
    if (child?.pid) {
      stopping = true;
      stop('SIGKILL');
    }
    finish(
      null,
      null,
      error instanceof ForgeError
        ? `${error.code}: ${error.message}`
        : 'Run preparation was interrupted or failed. Inspect retained work/output; this operation will not execute again.',
      error instanceof ForgeError ? { code: error.code, message: error.message } : undefined,
    );
  };
  const prepare = () => {
    try {
      warnings = [...new Set([...warnings, ...diskGuard(store.root)])];
      processEnvironment.prepare();
      if (store.native) new NativeSource(store.root).materialize(run.head, workspace, false);
      else workGit(store.root, ['worktree', 'add', '--detach', workspace, run.head]);
      for (const name of [
        'FORGE_CHECK_CHANGES',
        'FORGE_CHECK_BASE',
        'FORGE_CHECK_HEAD',
        'FORGE_CHECK_INTERACTION',
        'FORGE_CHECK_DOCS_ADMISSION',
      ])
        delete processEnvironment.env[name];
      if (run.mainCheck) processEnvironment.env.FORGE_CHECK_FULL = '1';
      else if (run.optimistic || run.recovery) {
        delete processEnvironment.env.FORGE_CHECK_FULL;
        processEnvironment.env.FORGE_CHECK_SCOPED = '1';
      }
      if (run.interaction !== undefined) processEnvironment.env.FORGE_CHECK_INTERACTION = '1';
      if (lightweight) processEnvironment.env.FORGE_CHECK_DOCS_ADMISSION = '1';
      try {
        processEnvironment.env.FORGE_CHECK_CHANGES =
          run.backend?.requested === 'modal' && existsSync(join(path, 'changes.json'))
            ? join(path, 'changes.json')
            : writeCheckScope(store, run, path);
        processEnvironment.env.FORGE_CHECK_BASE = run.comparisonBase ?? run.base;
        processEnvironment.env.FORGE_CHECK_HEAD = run.head;
      } catch (error) {
        if (lightweight) throw error;
        // An unavailable comparison runs the full standard check.
      }
      processEnvironment.env.FORGE_CHECK_SELECTION = join(path, 'selection.json');
      const out = openSync(
        join(path, 'stdout.log'),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      let err: number | undefined;
      try {
        err = openSync(
          join(path, 'stderr.log'),
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        closeSync(out);
        throw error;
      }
      // Preparation and log creation run once. A busy final admission keeps the
      // same workspace, descriptors, run identity and machine-capacity ticket.
      const spawnPrepared = () => {
        let retrying = false,
          cancelled = false;
        try {
          store.locked(() => {
            const tx = store.records(),
              selected = tx.find('runs', run.id)!;
            const saved = selected.record;
            if (saved.cancelRequested || queue?.cancelled() || (run.mainCheck && foregroundQueued())) {
              cancelled = true;
              return;
            }
            try {
              measured = resourceCommand(run.check, path);
            } catch {
              /* Optional diagnostics never prevent the selected command from starting. */
            }
            warnings = [...new Set([...warnings, ...diskGuard(store.root)])];
            // Serialize the last cancellation check with spawn and its running journal.
            child = spawn(measured?.executable ?? run.check.executable, measured?.args ?? run.check.args, {
              cwd: workspace,
              env: processEnvironment.env,
              shell: false,
              detached: process.platform !== 'win32',
              stdio: ['ignore', out, err],
            });
            child.once('error', () =>
              finish(
                null,
                null,
                'Selected executable could not start. Inspect its definition; no target command was repeated.',
              ),
            );
            child.once('close', (code, signal) => finish(code, signal));
            saved.status = 'running';
            queue?.update({ phase: 'running check' });
            saved.startedAt = new Date().toISOString();
            saved.warnings = warnings;
            if (child.pid) {
              saved.childPid = child.pid;
              saved.childStartTime = processStartTime(child.pid);
              queue?.child(child.pid, saved.childStartTime);
            }
            tx.replace('runs', selected.position, saved);
            store.commitRecords(tx);
          });
          if (cancelled) {
            stopping = true;
            finish(null, null, 'Cancelled before the selected executable started.');
            return;
          }
          poll = setInterval(() => {
            try {
              if (
                !stopping &&
                (pollCancellation(() => selected.read()) ||
                  queue?.cancelled() ||
                  (run.mainCheck && foregroundQueued()))
              ) {
                stopping = true;
                stop('SIGTERM');
                escalation = setTimeout(() => stop('SIGKILL'), 2000);
              }
            } catch (error) {
              stop('SIGKILL');
              void finish(
                null,
                null,
                error instanceof ForgeError
                  ? `${error.code}: ${error.message}`
                  : 'Check cancellation observation failed; no command was repeated.',
                error instanceof ForgeError ? { code: error.code, message: error.message } : undefined,
              );
            }
          }, 250);
        } catch (error) {
          if (error instanceof ForgeError && error.code === 'WORK_BUSY' && !child) {
            retrying = true;
            queuedPoll = setTimeout(spawnPrepared, 100);
            return;
          }
          preparationFailed(error);
        } finally {
          if (!retrying) {
            closeSync(out);
            closeSync(err!);
          }
        }
      };
      spawnPrepared();
    } catch (error) {
      preparationFailed(error);
    }
  };

  const attempt = () => {
    try {
      if (pollCancellation(() => selected.read()) || queue?.cancelled()) {
        stopping = true;
        void finish(null, null, 'Cancelled while queued, before materialization or execution.');
        return;
      }
      if (queue && !queue.tryAcquire()) {
        queuedPoll = setTimeout(attempt, 750 + Math.random() * 500);
        return;
      }
      const cancelled = store.locked(() => {
        const tx = store.records(),
          found = tx.find('runs', run.id)!;
        if (found.record.cancelRequested) return true;
        queue?.update({ phase: 'preparing check' });
        found.record.status = 'preparing';
        if (lightweight)
          found.record.details +=
            ' Validated docs-only interaction: merged static checks bypass heavyweight capacity.';
        tx.replace('runs', found.position, found.record);
        store.commitRecords(tx);
        return false;
      });
      if (cancelled) {
        stopping = true;
        void finish(null, null, 'Cancelled while queued, before materialization or execution.');
        return;
      }
      prepare();
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'WORK_BUSY') {
        queuedPoll = setTimeout(attempt, 750 + Math.random() * 500);
        return;
      }
      void finish(
        null,
        null,
        error instanceof ForgeError
          ? `${error.code}: ${error.message}`
          : 'Check queue preparation failed; this operation will not execute again.',
        error instanceof ForgeError ? { code: error.code, message: error.message } : undefined,
      );
    }
  };
  try {
    mkdirBelow(store.directory, path);
    if (run.backend?.fallback)
      appendFileSync(join(path, 'stdout.log'), `[check route] ${run.backend.fallback}\n`, { mode: 0o600 });
    if (!lightweight)
      queue = new CheckQueue(undefined, {
        identity: {
          runId: run.id,
          root: store.root,
          laneId: run.inputs[0]?.laneId,
          priority: run.mainCheck ? 'audit' : 'landing',
          phase: 'queued for check',
        },
      });
    attempt();
  } catch (error) {
    void finish(
      null,
      null,
      error instanceof ForgeError
        ? `${error.code}: ${error.message}`
        : 'Check queue preparation failed; this operation will not execute again.',
      error instanceof ForgeError ? { code: error.code, message: error.message } : undefined,
    );
  }
}
export function runWork(
  store: WorkStore,
  command: Exclude<EvidenceCommand, { action: 'import-checks' | 'export-check' }>,
  revision: number,
  sequence?: { id: string; complete: (error?: unknown) => void },
) {
  invariant(
    Number.isSafeInteger(revision) && revision >= 0,
    'BAD_ARGUMENT',
    'Send a valid expected work revision.',
  );
  if (command.action === 'read-check-output') {
    const run = store.select('runs', command.operationId);
    invariant(run, 'NOT_FOUND', 'Run not found.');
    const path = runOutputDirectory(store, run.id);
    const outputPath =
      command.shard === undefined
        ? join(path, `${command.stream}.log`)
        : join(path, 'shards', shardLogName(command.shard, command.attempt));
    if (command.shard !== undefined)
      invariant(
        safeDirectory(join(path, 'shards')),
        'NOT_FOUND',
        'Shard logs are not available as a regular local directory.',
      );
    let fd: number;
    try {
      fd = openSync(
        outputPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
    } catch {
      throw new ForgeError('NOT_FOUND', 'Run output is not available as a regular local file.');
    }
    try {
      const info = fstatSync(fd);
      invariant(
        info.isFile() && info.nlink === 1,
        'UNSAFE_PATH',
        'Run output must be a regular file with one hard link.',
      );
      const offset = command.tail ? Math.max(0, info.size - command.tail) : command.offset;
      const bytes = Buffer.alloc(command.tail ?? command.bytes);
      const length = readSync(fd, bytes, 0, bytes.length, offset);
      return {
        revision: store.revision(),
        result: {
          stream: command.stream,
          ...(command.shard === undefined ? {} : { shard: command.shard, attempt: command.attempt ?? 1 }),
          offset,
          nextOffset: offset + length,
          bytes: info.size,
          base64: bytes.subarray(0, length).toString('base64'),
          text: bytes.subarray(0, length).toString('utf8'),
          more: offset + length < info.size,
          private: true,
        },
      };
    } finally {
      closeSync(fd);
    }
  }
  let started: CheckRun | undefined;
  const result = store.locked(() => {
    if (!store.native) executionGuard(store.root);
    const tx = recoverRecordRuns(store, store.records()),
      data = tx.data();
    const selected = tx.find('runs', command.operationId),
      existing = selected?.record;
    if (command.action === 'cancel-check') {
      invariant(existing, 'NOT_FOUND', 'Run not found.');
      if (active(existing) && !existing.cancelRequested) {
        existing.cancelRequested = true;
        tx.replace('runs', selected!.position, existing);
        data.revision = store.commitRecords(tx);
      }
      return { revision: data.revision, result: existing };
    }
    if (existing) {
      invariant(
        existing.viewId === command.viewId &&
          existing.head === command.expectedHead &&
          existing.check.id === command.checkId &&
          existing.check.definition === command.expectedDefinition &&
          existing.environment.fingerprint === command.expectedEnvironment &&
          JSON.stringify(
            existing.interaction && {
              version: existing.interaction.version,
              reusedRunId: existing.interaction.reusedRunId,
              base: existing.interaction.base,
              checkedHead: existing.interaction.checkedHead,
              main: existing.interaction.main,
            },
          ) === JSON.stringify(command.interaction),
        'EVIDENCE_CHANGED',
        'This run operation already has different pins. Its command is not repeated.',
      );
      return { revision: data.revision, result: existing };
    }
    invariant(data.revision === revision, 'WORK_STALE', 'Work changed. Refresh before starting a new run.');
    const reserved = tx.find('playbookRuns', command.operationId, 'stepRun')?.record;
    invariant(
      !reserved || reserved.id === sequence?.id,
      'EVIDENCE_CHANGED',
      'This operation ID belongs to a pinned Playbook step.',
    );
    if (sequence) {
      const parent = tx.find('playbookRuns', sequence.id)?.record;
      invariant(
        parent?.status === 'running' &&
          !parent.cancelRequested &&
          parent.steps.some(s => s.runId === command.operationId),
        'EVIDENCE_CHANGED',
        'The Playbook stopped before this step registered.',
      );
    }
    const selectedView = tx.find('views', command.viewId)?.record;
    if (selectedView) data.views.push(selectedView);
    const view = evidenceView(data, command.viewId, command.expectedHead);
    const check = tx.find('checks', command.checkId)?.record;
    // A retained batch owns its runtime pins across driver process restarts.
    const batch = (store.native ? (store.load().landingBatches ?? []) : []).find(batch =>
      batch.prefixes.some(
        prefix =>
          prefix.runId === command.operationId &&
          prefix.viewId === command.viewId &&
          prefix.head === command.expectedHead,
      ),
    );
    const environment = batch?.environment ?? checkEnvironment();
    invariant(
      check?.definition === command.expectedDefinition &&
        environment.fingerprint === command.expectedEnvironment,
      'EVIDENCE_CHANGED',
      'Check definition or runtime settings changed. Inspect them before starting.',
    );
    const warnings = diskGuard(store.root);
    const inputObservations = observeCheckInputs(store, check, command.expectedHead, environment);
    const policy = readPolicy(store).checks;
    const route = checkRoute(policy?.runner ?? 'local', check, store.native);
    started = {
      backend: {
        ...route,
        ...(route.actual === 'modal' ? { credentialsRef: policy?.credentialsRef ?? null } : {}),
      },
      id: command.operationId,
      viewId: view.id,
      head: command.expectedHead,
      base: view.base,
      ...(view.composedMain ? { comparisonBase: view.composedMain } : {}),
      inputs: view.inputs,
      ...(view.mainCheck ? { mainCheck: view.mainCheck } : {}),
      ...(view.optimistic ? { optimistic: true } : {}),
      ...(view.recovery ? { recovery: view.recovery } : {}),
      dependencies: view.dependencies ?? [],
      check,
      environment,
      status: 'queued',
      queuedAt: new Date().toISOString(),
      warnings,
      startedAt: new Date().toISOString(),
      runner: { ...processIdentity(), host: hostname() },
      details:
        checkEnvironmentDescription(check) +
        ' Queued for machine-wide check capacity; preparing the exact committed candidate for the selected command. No evidence reuse.',
      ...(inputObservations ? { inputObservations } : {}),
      ...(sequence ? { playbookRunId: sequence.id } : {}),
    };
    if (command.interaction !== undefined) {
      started.interaction = command.interaction
        ? interactionEvidence(store, started, command.interaction)
        : null;
      tx.setSchema(15);
    }
    tx.append('runs', started);
    data.revision = store.commitRecords(tx);
    return { revision: data.revision, result: started };
  });
  if (started) {
    // A cancelled finish must not prevent its runner from publishing the terminal receipt.
    void withWorkLockOptions({ cancelled: () => false }, () => launch(store, started!, sequence?.complete));
    return { revision: store.revision(), result: store.select('runs', started.id)! };
  }
  return result;
}
