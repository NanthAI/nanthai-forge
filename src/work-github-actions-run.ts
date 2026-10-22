// SPDX-License-Identifier: Apache-2.0
import { retainCheckCoverage } from './check-coverage.js';
import { actionsCost, actionsRate, unknownCost } from './check-cost.js';
import { mkdirBelow } from './mkdir-below.js';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPolicy } from './work-autonomy.js';
import { modalPlan, validateModalPlan, type ModalPlan } from './modal-plan.js';
import { actionsApi, ActionsApiError, type ActionsApi } from './github-actions-api.js';
import { actionsJournal, deleteActionsRef, exportActionsSnapshot } from './github-actions-export.js';
import { ActionsDispatchRejected, ActionsDispatchUnknown } from './github-actions-dispatch.js';
import { controlActions } from './github-actions-controller.js';
import { durableReplace } from './native-durability.js';
import { remoteCancellation, cancellationDetails } from './work-run-cancellation.js';
import { updateModalRun } from './work-modal-run.js';
import { CheckQueue } from './check-queue.js';
import { workProgress } from './work-progress.js';
import { createRunReceipt } from './work-run-receipt.js';
import { invariant } from './errors.js';
import { GitSyncError } from './github-sync-git.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

export async function launchGithubActionsRun(
  store: WorkStore,
  run: CheckRun,
  api: ActionsApi = actionsApi,
  exportSnapshot = exportActionsSnapshot,
  deleteRef = deleteActionsRef,
) {
  const path = join(store.directory, `check-${run.id}`);
  mkdirBelow(store.directory, path);
  const control = new CheckQueue(undefined, {
    identity: { control: true, runId: run.id, phase: 'GitHub Actions check' },
  });
  let signalled: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    signalled = signal;
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, onSignal);
  const sequencePath = join(path, 'github-actions-progress-sequence');
  let sequence = existsSync(sequencePath) ? Number(readFileSync(sequencePath, 'utf8')) || 0 : 0;
  const progress = (message: string) => {
    const line = `[github-actions ${++sequence}] ${message}`;
    durableReplace(sequencePath, String(sequence));
    appendFileSync(join(path, 'stdout.log'), `${line}\n`, { mode: 0o600 });
    workProgress('github-actions check', line, `${run.id}:${sequence}`);
  };
  try {
    const policy = readPolicy(store).checks;
    // Adopt retained routing, even if the project's runner settings changed.
    const journalPath = join(path, 'github-actions.json');
    const retained = existsSync(journalPath)
      ? (JSON.parse(readFileSync(journalPath, 'utf8')) as { repo: string; runsOn: string })
      : undefined;
    const repo = retained?.repo ?? policy?.repo,
      runsOn = retained?.runsOn ?? policy?.runsOn ?? 'ubuntu-latest';
    invariant(repo, 'BAD_ARGUMENT', 'GitHub Actions runner requires checks.repo (owner/name).');
    const runtime = `github-actions;repo:${repo};node:24.19.0;runs-on:${runsOn};unfinished-retry:1`;
    let plan: ModalPlan;
    if (existsSync(join(path, 'modal-plan.json'))) {
      plan = JSON.parse(readFileSync(join(path, 'modal-plan.json'), 'utf8'));
      validateModalPlan(plan, run);
      invariant(plan.runtime === runtime, 'EVIDENCE_CHANGED', 'Retained Actions route changed.');
    } else {
      const created = await modalPlan(store, run, path, policy?.shards, runtime);
      if (!created) {
        durableReplace(
          join(path, 'result.json'),
          JSON.stringify(
            createRunReceipt({
              status: 'runner-unavailable',
              backend: run.backend,
              endedAt: new Date().toISOString(),
              exitCode: null,
              signal: null,
              details:
                'GitHub Actions cannot export local credential configuration; select the local runner explicitly.',
            }),
          ),
        );
        return;
      }
      plan = created;
    }
    run.backend = { ...run.backend!, pin: plan.pin, lockfile: plan.lockfile, runtime: plan.runtime };
    run.status = 'running';
    updateModalRun(store, run);
    const { journal, save } = actionsJournal(path, plan, repo, runsOn);
    if (journal.rateUsdPerMinute === undefined) {
      journal.rateUsdPerMinute = policy?.ratesUsdPerMinute?.[runsOn] ?? actionsRate(runsOn);
    }
    save();
    const cancelled = () => {
      const queued = control.cancelled();
      return remoteCancellation(
        store,
        run,
        signalled ? { reason: 'signal', signal: signalled } : queued ? { reason: 'queue' } : undefined,
      );
    };
    progress(
      `Pinned ${run.head}; ${plan.selection.scope}; ${plan.groups.length} test shards plus static checks; ${journal.repo} (${journal.runsOn})`,
    );
    if (!cancelled() || journal.dispatching)
      await exportSnapshot(plan, journal, save, undefined, undefined, ms => api.sleep(ms), progress);
    const outcome = await controlActions(plan, journal, save, api, cancelled, progress);
    run.backend.executionIds = journal.runId ? [String(journal.runId)] : [];
    run.backend.billableMinutes = outcome.billableMinutes;
    run.backend.cost = outcome.cost;
    if (outcome.cost.estimatedCostUsd !== null) run.backend.estimatedCostUsd = outcome.cost.estimatedCostUsd;
    else delete run.backend.estimatedCostUsd;
    const receipt = createRunReceipt({
      ...outcome,
      cancellation: run.cancellation,
      backend: run.backend,
      checkSelection: plan.standard ? plan.selection : undefined,
      endedAt: new Date().toISOString(),
      signal: null,
      artifacts: [
        ...(run.check.artifactPaths ?? []).map(sourcePath => ({
          status: 'unavailable' as const,
          sourcePath,
          details: 'Actions output remains in retained job logs; selected file download is unavailable.',
        })),
        ...retainCheckCoverage(store, run, path, plan.standard ? plan.selection : undefined),
      ],
      details: `GitHub Actions result bound to the pinned source, check and shard plan. Job timestamps and the retained per-label rate provide a gross USD estimate; GitHub/Blacksmith billing is authoritative. Ref: refs/heads/forge-check/${run.id}.${cancellationDetails(run)} ${outcome.status === 'passed' ? 'Run ref is removed after recording this result.' : 'Run ref and logs retained for diagnosis; remove the run-owned ref after inspection.'}`,
    });
    durableReplace(join(path, 'result.json'), JSON.stringify(receipt));
    if (outcome.status === 'passed') {
      try {
        await deleteRef(plan, journal, save, undefined, ms => api.sleep(ms), progress);
        progress('Removed run-owned ref after recording result.');
      } catch {
        progress('Result recorded; run-owned ref cleanup requires reconciliation.');
      }
    }
  } catch (error) {
    try {
      const journalFile = join(path, 'github-actions.json');
      if (existsSync(journalFile)) {
        const journal = JSON.parse(
          readFileSync(journalFile, 'utf8'),
        ) as import('./github-actions-export.js').ActionsJournal;
        run.backend!.cost = actionsCost(
          journal.runsOn,
          journal.rateUsdPerMinute === undefined ? actionsRate(journal.runsOn) : journal.rateUsdPerMinute,
          journal.jobUsage ?? [],
        );
        if (run.backend!.cost.estimatedCostUsd !== null)
          run.backend!.estimatedCostUsd = run.backend!.cost.estimatedCostUsd;
        else delete run.backend!.estimatedCostUsd;
      }
    } catch {
      run.backend!.cost = unknownCost('github-actions');
      delete run.backend!.estimatedCostUsd;
    }
    // Never serialize raw transport errors or stacks. Git's stderr is kept only after redaction.
    const dispatchRejected = error instanceof ActionsDispatchRejected;
    const receipt = createRunReceipt({
      status: dispatchRejected ? 'failed' : 'interrupted',
      cancellation: run.cancellation,
      backend: run.backend,
      endedAt: new Date().toISOString(),
      exitCode: dispatchRejected ? 1 : null,
      signal: null,
      details: dispatchRejected
        ? `${error.code}: ${error.message} Source export and dispatch rejections are retained.`
        : `GitHub Actions controller interrupted (${errorKind(error)}${error instanceof GitSyncError && error.detail ? `: git said "${error.detail}"` : ''}); source export, dispatch intent and job identities are retained. Check gh access and workflow registration, then reconcile the retained run. Retained dispatch outcomes govern recovery; ambiguous reruns are never repeated.`,
    });
    progress(receipt.details);
    durableReplace(join(path, 'result.json'), JSON.stringify(receipt));
  } finally {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.off(signal, onSignal);
    control.release();
  }
}

// Only a stable code or error class: transport messages can contain credentials.
function errorKind(error: unknown) {
  if (error instanceof ActionsApiError || error instanceof ActionsDispatchUnknown)
    return `${error.code}: ${error instanceof ActionsApiError ? error.outcome : 'ambiguous'}${error.httpStatus === undefined ? '' : ` HTTP ${error.httpStatus}`}`;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Z_]{3,64}$/.test(code)) return code;
  return error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown';
}
