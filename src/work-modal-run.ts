import { modalCredentials } from './modal-credentials.js';
import { readPolicy } from './work-autonomy.js';
import { modalRunCost } from './check-cost.js';
import { ForgeError } from './errors.js';
import { localFallbackAllowed, runnerRetryMessage } from './check-fallback.js';
import { mkdirBelow } from './mkdir-below.js';
import { pollCancellation } from './work-cancel-poll.js';
import { ModalShardLogs } from './modal-shard-logs.js';
import { processStartTime } from './local-process.js';
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CheckQueue } from './check-queue.js';
import { modalQuarantine } from './check-quarantine.js';
import { modalPlan, validateModalPlan, type ModalPlan } from './modal-plan.js';
import { bindModalResult, modalClient, type ModalClient, type ModalEvent } from './modal-client.js';
import { workProgress } from './work-progress.js';
import { modalControllerError } from './modal-controller-error.js';
import { createRunReceipt } from './work-run-receipt.js';
import { durableReplace, syncDirectory, syncFile } from './native-durability.js';
import type { CheckRun } from './work-types.js';
import type { WorkStore } from './work-store.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 250));
export function updateModalRun(store: WorkStore, run: CheckRun) {
  store.locked(() => {
    const tx = store.records(),
      selected = tx.find('runs', run.id)!;
    // Cancellation is owned by the latest record, not this controller's cached copy.
    const { cancelRequested } = selected.record;
    tx.replace('runs', selected.position, { ...run, ...(cancelRequested ? { cancelRequested } : {}) });
    store.commitRecords(tx);
  });
}
export function modalFallback(run: CheckRun, category: string) {
  run.backend = {
    ...run.backend!,
    actual: 'local',
    fallback: `Modal ${category}; falling back to local execution.`,
  };
  run.details += ` ${run.backend.fallback}`;
  workProgress('check fallback', run.backend.fallback!);
}
/** Returns false only for a recorded, safe local route. Unknown remote outcomes never repeat. */
export async function launchModalRun(
  store: WorkStore,
  run: CheckRun,
  client: ModalClient = modalClient,
  infrastructureRetries = 0,
): Promise<boolean> {
  const path = join(store.directory, `check-${run.id}`);
  mkdirBelow(store.directory, path);
  let queue: CheckQueue | undefined, cancel: ReturnType<typeof setInterval> | undefined;
  const sequencePath = join(path, 'modal-progress-sequence');
  let sequence = 0;
  try {
    sequence = Number(readFileSync(sequencePath, 'utf8')) || 0;
  } catch {
    /* First progress. */
  }
  const progress = (message: string) => {
    const line = `[modal ${++sequence}] ${message}`;
    durableReplace(sequencePath, String(sequence));
    appendFileSync(join(path, 'stdout.log'), `${line}\n`, { mode: 0o600 });
    workProgress('modal check', line, `${run.id}:${sequence}`);
  };
  let plan: ModalPlan | undefined;
  let credentials: ReturnType<typeof modalCredentials> | undefined;
  try {
    run.backend!.credentialsRef =
      run.backend!.credentialsRef === undefined
        ? (readPolicy(store).checks?.credentialsRef ?? null)
        : run.backend!.credentialsRef;
    updateModalRun(store, run);
    credentials = modalCredentials(store.root, run.backend!.credentialsRef);
    if (existsSync(join(path, 'modal-plan.json'))) {
      plan = JSON.parse(readFileSync(join(path, 'modal-plan.json'), 'utf8')) as ModalPlan;
      validateModalPlan(plan, run);
    } else {
      plan = (await modalPlan(store, run, path)) ?? undefined;
      if (!plan) {
        if (!localFallbackAllowed(store, run)) {
          const receipt = createRunReceipt({
            status: 'runner-unavailable',
            backend: run.backend,
            endedAt: new Date().toISOString(),
            exitCode: null,
            signal: null,
            details: `Modal cannot use local credential configuration in source. ${runnerRetryMessage('runner-unavailable')}`,
          });
          durableReplace(join(path, 'result.json'), JSON.stringify(receipt));
          return true;
        }
        modalFallback(run, 'local credential configuration in source');
        updateModalRun(store, run);
        return false;
      }
    }
    run.backend = { ...run.backend!, pin: plan.pin, lockfile: plan.lockfile, runtime: plan.runtime };
    updateModalRun(store, run);
    queue = new CheckQueue(
      join(
        process.env.FORGE_CHECK_QUEUE_DIR ?? join(homedir(), '.forge'),
        run.mainCheck ? 'modal-audit-queue' : 'modal-check-queue',
      ),
      {
        limit: 4,
        identity: { runId: run.id, phase: 'Modal check' },
      },
    );
    while (!queue.tryAcquire()) {
      if (pollCancellation(() => store.select('runs', run.id))) break;
      await pause();
    }
    if (pollCancellation(() => store.select('runs', run.id)))
      writeFileSync(join(path, 'modal-cancel'), 'cancel', { mode: 0o600 });
    run.status = 'running';
    updateModalRun(store, run);
    progress(
      `Pinned ${run.head}; ${plan.selection.scope}; ${plan.groups.length} test shards plus static checks`,
    );
    let pollingFailed = false;
    const cancellationFailure = new Promise<never>((_, reject) => {
      cancel = setInterval(() => {
        try {
          if (pollCancellation(() => store.select('runs', run.id)))
            writeFileSync(join(path, 'modal-cancel'), 'cancel', { mode: 0o600 });
        } catch (error) {
          pollingFailed = true;
          clearInterval(cancel);
          reject(error);
        }
      }, 250);
    });
    const shardLogs = new ModalShardLogs(path, plan.groups.length);
    let artifacts: NonNullable<CheckRun['artifacts']> = [];
    const artifactsPath = join(path, 'modal-artifacts.json');
    if (existsSync(artifactsPath)) artifacts = JSON.parse(readFileSync(artifactsPath, 'utf8'));
    const artifactCopies = new Map<number, { size: number; hash: ReturnType<typeof createHash> }>();
    let completed = 0,
      failed = 0;
    let terminal: Extract<ModalEvent, { kind: 'result' | 'error' }> | undefined;
    // Replayed remote logs are deduplicated by execution/stream/line identity.
    const seenPath = join(path, 'modal-log-cursors.json');
    let cursors: Record<string, number> = {};
    try {
      cursors = JSON.parse(readFileSync(seenPath, 'utf8'));
    } catch {
      /* First stream. */
    }
    await Promise.race([
      cancellationFailure,
      client(
        join(path, 'modal-plan.json'),
        event => {
          if (pollingFailed) return;
          if (event.kind === 'progress') progress(event.message);
          if (
            event.kind === 'artifactChunk' ||
            event.kind === 'artifactEnd' ||
            event.kind === 'artifactUnavailable'
          ) {
            if (plan!.artifacts[event.index] !== event.sourcePath)
              throw new Error('Unselected remote artifact.');
            const filename = `artifact-${event.index}.bin`,
              artifactDir = join(path, 'artifacts'),
              target = join(artifactDir, filename);
            if (event.kind === 'artifactUnavailable')
              artifacts[event.index] = {
                status: 'unavailable',
                sourcePath: event.sourcePath,
                details: 'Remote output could not be captured safely.',
              };
            else {
              let copy = artifactCopies.get(event.index);
              if (!copy) {
                mkdirBelow(path, artifactDir);
                writeFileSync(target, '', { mode: 0o600 });
                copy = { size: 0, hash: createHash('sha256') };
                artifactCopies.set(event.index, copy);
              }
              if (event.kind === 'artifactChunk') {
                if (event.offset !== copy.size) throw new Error('Remote artifact offset changed.');
                const bytes = Buffer.from(event.base64, 'base64');
                appendFileSync(target, bytes);
                copy.size += bytes.length;
                copy.hash.update(bytes);
              } else {
                if (event.size !== copy.size || event.sha256 !== copy.hash.digest('hex'))
                  throw new Error('Remote artifact digest mismatch.');
                syncFile(target);
                artifacts[event.index] = {
                  status: 'retained',
                  sourcePath: event.sourcePath,
                  filename,
                  size: event.size,
                  sha256: event.sha256,
                };
              }
            }
            durableReplace(artifactsPath, JSON.stringify(artifacts));
          }

          if (event.kind === 'timing' && plan!.selection.tests.includes(event.file)) {
            const timingPath = join(store.directory, 'modal-durations.json');
            let timings: Record<string, number> = {};
            try {
              timings = JSON.parse(readFileSync(timingPath, 'utf8'));
            } catch {
              /* First observation. */
            }
            timings[event.file] = event.seconds;
            durableReplace(timingPath, JSON.stringify(timings));
          }
          if (event.kind === 'execution') {
            shardLogs.register(event);
            if (run.backend!.image && run.backend!.image !== event.image)
              throw new Error('Runtime image changed.');
            run.backend!.image = event.image;
            run.backend!.executionIds = [
              ...new Set([...(run.backend!.executionIds ?? []), event.executionId]),
            ];
            updateModalRun(store, run);
          }
          if (event.kind === 'log') {
            if (!run.backend?.executionIds?.includes(event.executionId))
              throw new Error('Unknown execution log.');
            const key = `${event.executionId}:${event.stream}`;
            if (event.line <= (cursors[key] ?? -1)) return;
            shardLogs.append(event.executionId, event.text);
            appendFileSync(join(path, `${event.stream}.log`), event.text, { mode: 0o600 });
            if (/^(?:ok|not ok) (?:\d+|-)/m.test(event.text.trimStart())) {
              completed++;
              if (event.text.trimStart().startsWith('not ok')) failed++;
              progress(`[test] completed=${completed} failed=${failed}`);
            }
            cursors[key] = event.line;
            const temp = `${seenPath}.tmp`;
            writeFileSync(temp, JSON.stringify(cursors), { mode: 0o600 });
            renameSync(temp, seenPath);
          }
          if (event.kind === 'result') {
            bindModalResult(plan!, event);
            terminal = event;
          }
          if (event.kind === 'error') {
            if (event.estimatedCostUsd !== undefined) run.backend!.estimatedCostUsd = event.estimatedCostUsd;
            if (event.costUsage) run.backend!.costUsage = event.costUsage;
            terminal = event;
          }
        },
        pid => queue?.child(pid, processStartTime(pid)),
        credentials,
      ),
    ]);
    if (
      terminal?.kind === 'error' &&
      terminal.safeFallback &&
      infrastructureRetries === 0 &&
      localFallbackAllowed(store, run) &&
      ['auth', 'network', 'billing'].includes(terminal.category) &&
      !store.select('runs', run.id)?.cancelRequested
    ) {
      progress(`Modal ${terminal.category}; confirmed remote work stopped; local fallback`);
      modalFallback(run, terminal.category);
      updateModalRun(store, run);
      return false;
    }
    const cancelled = store.select('runs', run.id)?.cancelRequested;
    const outcome = terminal?.kind === 'result' ? terminal : undefined;
    const unavailable =
      terminal?.kind === 'error' &&
      ['auth', 'network', 'billing'].includes(terminal.category) &&
      terminal.safeFallback
        ? terminal.category === 'billing'
          ? 'runner-budget-exhausted'
          : 'runner-unavailable'
        : undefined;
    if (outcome) {
      run.backend!.estimatedCostUsd = outcome.estimatedCostUsd;
      if (outcome.costUsage) run.backend!.costUsage = outcome.costUsage;
    }
    run.backend!.cost = modalRunCost(run.backend!);
    const endedAt = new Date().toISOString();
    const summary = outcome ? shardLogs.failureSummary(outcome) : '';
    const assessment =
      outcome && plan.standard ? modalQuarantine(store, run, outcome, plan.groups, endedAt) : undefined;
    run.backend!.retryable =
      !cancelled && !outcome && terminal?.kind === 'error' && terminal.category !== 'unknown';
    if (assessment) {
      run.backend!.testVerdicts = assessment.testVerdicts;
      run.backend!.quarantine = assessment.quarantine;
      run.backend!.verdict = assessment.verdict;
    }
    const failureSummary =
      summary ||
      (assessment?.blocked
        ? assessment.testVerdicts
            .filter(item => item.verdict !== 'passed')
            .map(item => `${item.verdict}: ${item.test}`)
            .join('\n')
            .slice(0, 4096) ||
          'Failed shard retry has no complete attributed test report; inspect retained attempts.'
        : '');
    const receipt = createRunReceipt({
      status: cancelled
        ? 'cancelled'
        : outcome
          ? assessment?.blocked ||
            (outcome.exitCode !== 0 && (!assessment || !assessment.testVerdicts.length))
            ? 'failed'
            : 'passed'
          : (unavailable ?? 'interrupted'),
      backend: run.backend,
      ...(failureSummary ? { failureSummary } : {}),
      checkSelection: plan.standard ? plan.selection : undefined,
      ...(run.check.measureResources
        ? {
            resourceUsage: {
              status: 'unavailable',
              details:
                'Remote gross compute cost is estimated separately; native process resource measurement is unavailable.',
            },
          }
        : {}),
      ...(run.check.artifactPaths?.length
        ? {
            artifacts: run.check.artifactPaths.map(
              (sourcePath, index) =>
                artifacts[index] ?? {
                  status: 'unavailable',
                  sourcePath,
                  details:
                    'Remote selected output capture is unavailable; execution IDs and source are retained.',
                },
            ),
          }
        : {}),
      endedAt,
      exitCode: outcome?.exitCode ?? null,
      signal: null,
      details: unavailable
        ? runnerRetryMessage(unavailable)
        : outcome
          ? `Modal outcome bound to the exact source, definition, selection and runtime; compute cost is estimated. ${outcome.details ?? ''} ${assessment?.verdict === 'flake' ? 'Flake verdict (pass after failure); attempts and available named results retained.' : ''} ${assessment?.quarantine.length ? 'Quarantined tests still ran and reported; only their attributed failures are non-blocking.' : ''}`.trim()
          : `Modal infrastructure interrupted the check; no check failure was recorded. Retry resumes the same pinned Candidate/plan and retains completed shards. ${terminal?.kind === 'error' ? (terminal.details ?? `Modal ${terminal.category} failure.`) : ''}`.trim(),
    });
    if (
      ['interrupted', 'runner-unavailable', 'runner-budget-exhausted'].includes(receipt.status) &&
      run.backend?.retryable &&
      infrastructureRetries > 0
    ) {
      // Keep intermediate interruption evidence out of result.json: observers must
      // not end finish while its same-View infrastructure recovery is still active.
      durableReplace(join(path, `interruption-${randomUUID()}.json`), JSON.stringify(receipt));
      progress(
        'Infrastructure interrupted; retrying the same Candidate/plan once; completed shards retained.',
      );
      if (cancel) {
        clearInterval(cancel);
        cancel = undefined;
      }
      queue?.release();
      queue = undefined;
      return await launchModalRun(store, run, client, infrastructureRetries - 1);
    }
    const temp = join(path, `${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600 });
    syncFile(temp);
    renameSync(temp, join(path, 'result.json'));
    syncDirectory(path);
    return true;
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'MODAL_CREDENTIALS_REQUIRED') {
      const receipt = createRunReceipt({
        status: 'runner-unavailable',
        backend: run.backend,
        endedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        error: { code: error.code, message: error.message },
        details: error.message,
      });
      durableReplace(join(path, 'result.json'), JSON.stringify(receipt));
      return true;
    }
    run.backend!.cost = modalRunCost(run.backend!);
    const redacted =
      error instanceof Error && credentials
        ? new Error(
            Object.values(credentials).reduce(
              (message, value) => message.split(value).join('[redacted]'),
              error.message,
            ),
          )
        : error;
    const message = modalControllerError(redacted);
    // No inferred success or automatic retry following an ambiguous creation/transport result.
    progress(`Controller interrupted: ${message}; retained execution IDs and source pins are preserved.`);
    run.backend!.retryable = false;
    run.status = 'interrupted';
    run.endedAt = new Date().toISOString();
    run.details = `Modal controller interrupted: ${message}. No command was repeated. Retained execution IDs require reconciliation.`;
    const receipt = createRunReceipt({
      status: run.status,
      backend: run.backend,
      endedAt: run.endedAt,
      exitCode: null,
      signal: null,
      details: run.details,
    });
    durableReplace(join(path, 'result.json'), JSON.stringify(receipt));
    updateModalRun(store, run);
    return true;
  } finally {
    if (cancel) clearInterval(cancel);
    queue?.release();
  }
}
