// SPDX-License-Identifier: Apache-2.0
import { validatePrefixRun } from './landing-diagnosis.js';
import { hostname } from 'node:os';
import { processAlive } from './local-process.js';
import { finishChild } from './finish-child.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readSource } from './files.js';
import { NativeSource } from './native-source.js';
import { actionsCheckRuntime, checkRoute } from './check-backend.js';
import { effectivePolicy } from './autonomy-policy.js';
import { readPolicy } from './work-autonomy.js';
import { checkPassthrough } from './check-environment.js';
import { observeCheckInputs } from './work-inputs.js';
import { modalPlan, modalRuntime, type ModalPlan } from './modal-plan.js';
import { checkEnvironment } from './check-environment.js';
import { type Check, type CheckRun, type WorkView } from './work-types.js';
import { batchEdit } from './landing-batch-store.js';
import { workProgress } from './work-progress.js';
import {
  successfulCheck as successful,
  readCheckJson as readJson,
  checkEvidenceFingerprint as evidence,
  retainedPassedCheck,
  executionSelection,
} from './check-reuse-evidence.js';
export { retainedPassedCheck, validateReusedCheck } from './check-reuse-evidence.js';
import type { WorkStore } from './work-store.js';
import type { WorkService } from './work.js';
import type { BatchPrefix, LandingBatch } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';

const same = isDeepStrictEqual;
/** Run/View IDs, timestamps and controller CLI pins are orchestration, not execution inputs.
 * Adopt the original validated shard placement: timing history is scheduling advice.
 * Selection reasons and shadow coverage describe the check; they do not execute it.
 * Scoped/custom commands also retain exact base and ordered Lane/dependency pins. */
function recipe(plan: ModalPlan) {
  const inputs = Object.fromEntries(
    Object.entries(plan).filter(
      ([name]) => !['runId', 'viewId', 'head', 'pin', 'source', 'output', 'costSafetyMargin'].includes(name),
    ),
  );
  return {
    ...inputs,
    selection: { scope: plan.selection.scope, tests: plan.selection.tests },
    groups: { count: plan.groups.length, tests: plan.groups.flat().sort() },
  };
}
function tree(store: WorkStore, head: string) {
  return new NativeSource(store.root).state(head).files;
}
function observedInputs(run: CheckRun) {
  return (
    checkPassthrough(run.check).every(name => name in run.environment.env) &&
    (run.check.declaredInputs ?? []).every(
      (input, index) =>
        run.inputObservations?.[index]?.status === 'observed' &&
        same(input, run.inputObservations[index]!.input),
    )
  );
}

export async function reuseLandingCheck(
  work: WorkService,
  batch: LandingBatch,
  prefix: BatchPrefix,
  driver: LandingDriver,
) {
  const existing = work.store.select('runs', prefix.runId);
  if (existing) validatePrefixRun(work, batch, prefix, existing);
  if (
    existing &&
    (existing.cancelRequested ||
      !(
        existing.status === 'interrupted' ||
        (['queued', 'preparing', 'running'].includes(existing.status) &&
          existing.runner.host === hostname() &&
          !processAlive(existing.runner))
      ))
  )
    return;
  const reused = await reuseCheck(work, batch, prefix, driver, undefined, existing);
  if (reused && existing && reused.reusedFrom) prefix.runId = reused.id;
  return reused;
}

/** Main audits use the same retained full-plan evidence before run registration. */
export function reuseMainCheck(work: WorkService, view: WorkView, runId: string, check: Check) {
  return reuseCheck(
    work,
    undefined,
    { viewId: view.id, head: view.head!, runId, entryIds: [] },
    { generation: 0, beforePublish() {} },
    check,
  );
}

async function reuseCheck(
  work: WorkService,
  batch: LandingBatch | undefined,
  prefix: BatchPrefix,
  driver: LandingDriver,
  audit?: Check,
  replaced?: CheckRun,
): Promise<CheckRun | undefined> {
  if (!work.store.native || (!batch?.environment && !audit)) return;
  const store = work.store,
    data = store.load(),
    view = data.views.find(view => view.id === prefix.viewId),
    first = data.landingEntries?.find(entry => entry.id === batch?.entryIds[0]),
    check = data.checks.find(check => check.id === (audit?.id ?? first?.checkId)),
    environment = batch?.environment ?? checkEnvironment();
  if (
    !view?.head ||
    view.status !== 'clean' ||
    !check ||
    check.definition !== (audit?.definition ?? first?.definition)
  )
    return;
  const policy = readPolicy(store).checks,
    route = checkRoute(policy?.runner ?? 'local', check, true),
    runtime =
      route.actual === 'github-actions' ? actionsCheckRuntime(policy?.repo, policy?.runsOn) : modalRuntime;
  const draft: CheckRun = {
    id: replaced ? finishChild(prefix.runId, 'passed-twin') : prefix.runId,
    viewId: view.id,
    head: view.head,
    base: view.base,
    inputs: view.inputs,
    dependencies: view.dependencies ?? [],
    ...(view.composedMain ? { comparisonBase: view.composedMain } : {}),
    check,
    environment,
    ...(view.mainCheck ? { mainCheck: view.mainCheck } : {}),
    inputObservations: observeCheckInputs(store, check, view.head, environment),
    backend: route,
    status: 'queued',
    startedAt: new Date().toISOString(),
    runner: { pid: process.pid, host: 'reuse' },
    details: '',
  };
  if (!observedInputs(draft)) return;
  const candidates = data.runs.filter(
    run =>
      successful(run) &&
      !run.reusedFrom &&
      !run.optimistic &&
      !run.recovery &&
      run.interaction === undefined &&
      run.check.id === check.id &&
      run.check.definition === check.definition &&
      same({ ...run.check, at: '' }, { ...check, at: '' }) &&
      same(run.environment, draft.environment) &&
      same(run.inputObservations, draft.inputObservations) &&
      observedInputs(run) &&
      run.backend?.actual === route.actual,
  );
  if (!candidates.length) return;
  const directory = mkdtempSync(join(store.directory, 'check-reuse-'));
  try {
    // Reuse the execution planner; do not invent a second test-selection algorithm.
    // This prepares local files only, with no provider IO, registration or dispatch.
    let plan: ModalPlan | null;
    let files: ReturnType<typeof tree>;
    try {
      plan = await modalPlan(store, draft, directory, policy?.shards, runtime);
      if (!plan || (audit && !(view.mainCheck && plan.standard && plan.selection.scope === 'full'))) return;
      files = tree(store, draft.head);
    } catch {
      return;
    }
    const localExecutable = () =>
      observeCheckInputs(
        store,
        { ...check, declaredInputs: [{ kind: 'tool', executable: check.executable }] },
        draft.head,
        draft.environment,
      )?.[0];
    for (const candidate of candidates.reverse()) {
      const original = retainedPassedCheck(store, candidate);
      if (!original) continue;
      const exactSourcePins =
        original.base === draft.base &&
        original.comparisonBase === draft.comparisonBase &&
        same(original.inputs, draft.inputs) &&
        same(original.dependencies, draft.dependencies);
      // A full standard check executes the same complete source inventory after
      // acceptance/audit changes composition metadata. Scoped/custom commands
      // still depend on their original comparison and ordered source inputs.
      if (
        !exactSourcePins &&
        !(plan.standard && plan.selection.scope === 'full' && original.checkSelection?.scope === 'full')
      )
        continue;
      const executable = route.actual === 'local' ? localExecutable() : undefined;
      try {
        if (!same(tree(store, original.head), files)) continue;
        if (route.actual === 'local') {
          // Legacy local runs have no recipe/runtime pin. A checked batch retains
          // the admitted Node bytes; arbitrary external executables remain unknown.
          const oldBatch = data.landingBatches?.find(batch =>
            batch.prefixes.some(prefix => prefix.runId === original.id),
          );
          const pins = oldBatch?.entryIds.map(
            id => data.landingEntries?.find(entry => entry.id === id)?.runtimeSnapshot,
          );
          if (
            executable?.status !== 'observed' ||
            !pins?.length ||
            pins.some(
              pin =>
                !pin?.nodeBinary ||
                pin.nodeExecutable !== executable.locator ||
                pin.nodeBinary !== executable.sha256,
            )
          )
            continue;
          const changes = readJson(store, original.id, 'changes.json') as Record<string, unknown>;
          const current = JSON.parse(
            readSource(directory, 'changes.json', 4 * 1024 * 1024)!.toString('utf8'),
          );
          if (
            !(plan.standard && plan.selection.scope === 'full') &&
            !same({ ...changes, head: draft.head }, current)
          )
            continue;
          if (
            plan.standard &&
            !same(executionSelection(original.checkSelection), executionSelection(plan.selection))
          )
            continue;
        } else if (!same(recipe(readJson(store, original.id, 'modal-plan.json') as ModalPlan), recipe(plan)))
          continue;
        // Verify every referenced source blob, including lockfiles and symlink bytes.
        const source = new NativeSource(store.root);
        for (const file of files) source.object(file.blob);
      } catch {
        continue;
      }
      const reused = await batchEdit(
        work,
        batch?.id ?? prefix.runId,
        current => {
          const existing = current.runs.find(run => run.id === draft.id);
          if (existing) return existing;
          if (
            replaced &&
            !same(
              current.runs.find(run => run.id === replaced.id),
              replaced,
            )
          )
            return;
          const retained = retainedPassedCheck(
            store,
            current.runs.find(run => run.id === original.id),
          );
          if (!retained || evidence(retained) !== evidence(original)) return;
          if (current.checks.find(item => item.id === check.id)?.definition !== check.definition) return;
          const settings = effectivePolicy(current).checks;
          if (
            checkRoute(settings?.runner ?? 'local', check, true).actual !== route.actual ||
            (route.actual === 'github-actions' &&
              actionsCheckRuntime(settings?.repo, settings?.runsOn) !== runtime) ||
            (route.actual !== 'local' && settings?.shards !== policy?.shards)
          )
            return;
          const savedBatch = current.landingBatches?.find(item => item.id === batch?.id);
          if (
            (batch &&
              (savedBatch?.status !== 'checking' ||
                !savedBatch.prefixes.some(item => same(item, prefix)) ||
                !same(savedBatch.environment, draft.environment))) ||
            !same(
              current.views.find(item => item.id === view.id),
              view,
            )
          )
            return;
          if (!same(observeCheckInputs(store, check, draft.head, draft.environment), draft.inputObservations))
            return;
          if (route.actual === 'local' && !same(executable, localExecutable())) return;
          const now = new Date().toISOString();
          const reused: CheckRun = {
            ...draft,
            runner: { pid: 0, host: 'retained-check' },
            status: 'passed',
            startedAt: now,
            endedAt: now,
            exitCode: 0,
            signal: null,
            ...(original.checkSelection ? { checkSelection: original.checkSelection } : {}),
            reusedFrom: { runId: original.id, endedAt: original.endedAt!, evidence: evidence(original) },
            details: `reused check ${original.id} from ${original.endedAt}`,
            backend: {
              ...route,
              cost: {
                runner: route.actual,
                billedSeconds: 0,
                billedMinutes: 0,
                estimatedCostUsd: 0,
                items: [],
                basis: `Reused check ${original.id}; no new execution. Original usage remains on that run.`,
              },
            },
          };
          if (replaced && savedBatch) {
            const selected = savedBatch.prefixes.find(item => same(item, prefix))!;
            selected.runId = reused.id;
            // Re-evaluate any persisted interrupted verdict with the new receipt.
            delete savedBatch.settlement;
            for (const entry of current.landingEntries ?? []) {
              if (entry.batchId === batch!.id && entry.runId === replaced.id) entry.runId = reused.id;
            }
          }
          current.runs.push(reused);
          return reused;
        },
        driver.beforePublish,
      );
      if (reused?.reusedFrom)
        workProgress('reused check', `${reused.reusedFrom.runId} from ${reused.reusedFrom.endedAt}`);
      return reused;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return;
}
