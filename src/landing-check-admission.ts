// SPDX-License-Identifier: Apache-2.0
import { withDetachedChecks } from './check-execution-context.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { z } from 'zod';
import { readSource } from './files.js';
import { durableReplace } from './native-durability.js';
import { digest } from './hash.js';
import { checkEnvironment } from './check-environment.js';
import { checkRoute, actionsCheckRuntime } from './check-backend.js';
import { readPolicy } from './work-autonomy.js';
import { observeCheckInputs } from './work-inputs.js';
import { writeCheckScope } from './work-check-scope.js';
import { withQueueSlot } from './landing-queue.js';
import { batchEdit } from './landing-batch-store.js';
import { reuseLandingCheck } from './landing-check-reuse.js';
import { retainDiagnosisNode, validatePrefixRun } from './landing-diagnosis.js';
import { retryWorkPhase } from './work-retry.js';
import type { WorkService } from './work.js';
import type { CheckRun } from './work-types.js';
import type { LandingBatch, BatchPrefix } from './landing-batch-types.js';
import type { LandingDriver } from './landing-driver.js';
import { recoverLandingCheck } from './landing-check-recovery.js';

const reservationSchema = z.object({ runId: z.uuid(), viewId: z.uuid(), head: z.string() });
const active = (run: CheckRun) => ['queued', 'preparing', 'running'].includes(run.status);
/** Includes the runner-owned comparison: two identical trees can have different
 * scoped selections. Compute it without running source or contacting a provider. */
function identity(work: WorkService, run: CheckRun) {
  const path = mkdtempSync(join(work.store.directory, 'check-admission-'));
  try {
    return {
      head: run.head,
      base: run.base,
      inputs: run.inputs,
      dependencies: run.dependencies,
      check: { ...run.check, at: '' },
      environment: run.environment,
      observations: run.inputObservations,
      scope: JSON.parse(readFileSync(writeCheckScope(work.store, run, path), 'utf8')),
    };
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

/** Serialize only admission for an exact Candidate. A peer adopts the existing
 * run/View pins before dispatch, then observes the same physical controller.
 * No owner lock or admission ticket is held during check execution/waiting. */
export async function admitLandingCheck(
  work: WorkService,
  batch: LandingBatch,
  prefix: BatchPrefix,
  driver: LandingDriver,
  waitMs?: number,
  parent?: BatchPrefix,
) {
  const store = work.store;
  const reservationAt =
    store.select('runs', prefix.runId)?.queuedAt ??
    (!store.select('runs', prefix.runId) ? new Date().toISOString() : undefined);
  if (!prefix.reservedAt && reservationAt)
    await batchEdit(
      work,
      batch.id,
      data => {
        const saved = data
          .landingBatches!.find(item => item.id === batch.id)!
          .prefixes.find(item => item.viewId === prefix.viewId);
        if (saved) prefix.reservedAt = saved.reservedAt ??= reservationAt;
      },
      driver.beforePublish,
      batch.channel,
    );
  const fresh = batch.confirmation?.runId === prefix.runId;
  const reuse = () => (fresh ? undefined : reuseLandingCheck(work, batch, prefix, driver));
  let recorded = store.select('runs', prefix.runId);
  if (recorded) {
    recorded = (await reuse()) ?? recorded;
    await recoverLandingCheck(work, batch, prefix, driver);
    recorded = store.select('runs', prefix.runId);
  }
  if (recorded && recorded.status !== 'interrupted') {
    validatePrefixRun(work, batch, prefix, recorded);
    if (!batch.admission) await retainDiagnosisNode(work, batch, prefix, parent, driver);
    return true;
  }
  const environment = batch.environment ?? checkEnvironment();
  const view = store.select('views', prefix.viewId)!,
    first = store.select('landingEntries', batch.entryIds[0]!)!,
    check = store.select('checks', first.checkId)!,
    settings = readPolicy(store).checks,
    route = checkRoute(settings?.runner ?? 'local', check, store.native),
    runtime =
      route.actual === 'github-actions' ? actionsCheckRuntime(settings?.repo, settings?.runsOn) : undefined;
  const draft = {
    head: prefix.head,
    base: view.base,
    comparisonBase: view.composedMain,
    inputs: view.inputs,
    dependencies: view.dependencies ?? [],
    check,
    environment,
    inputObservations: observeCheckInputs(store, check, prefix.head, environment),
    viewId: view.id,
  } as CheckRun;
  const pins = identity(work, draft),
    key = digest(JSON.stringify({ pins, route, runtime, shards: settings?.shards })),
    // The owner already watches drain-lease changes, including dead-holder recovery.
    directory = join(store.directory, 'landing-batch-drain', `check-${key}`),
    reservation = join(directory, 'reservation.json');
  const admitted = await withQueueSlot(
    directory,
    async () => {
      let run = store.select('runs', prefix.runId) ?? (await reuse());
      if (!run && !fresh) {
        let pending: CheckRun | undefined;
        try {
          const bytes = readSource(directory, 'reservation.json', 4096);
          if (bytes) {
            const saved = reservationSchema.parse(JSON.parse(bytes.toString('utf8')));
            const existing = store.select('runs', saved.runId);
            const selected = store.select('views', saved.viewId);
            // The reservation precedes dispatch, so a stopped submitter leaves
            // the same unstarted operation for its peer to reconcile. The key
            // also binds runner settings which a queued run has not planned yet.
            const candidate =
              existing ??
              (selected && {
                ...draft,
                id: saved.runId,
                viewId: selected.id,
                head: selected.head!,
                base: selected.base,
                inputs: selected.inputs,
                dependencies: selected.dependencies ?? [],
                comparisonBase: selected.composedMain,
                status: 'queued' as const,
              });
            if (
              candidate &&
              (!existing || active(existing)) &&
              !candidate.cancelRequested &&
              same(identity(work, candidate), pins)
            )
              pending = candidate;
          }
        } catch {
          /* Missing/corrupt disposable admission metadata cannot supply evidence. */
        }
        if (pending) {
          const shared = await batchEdit(
            work,
            batch.id,
            data => {
              const saved = data.landingBatches!.find(item => item.id === batch.id)!;
              const selected = saved.prefixes.find(item => item.runId === prefix.runId);
              const current = data.runs.find(run => run.id === pending!.id) ?? pending;
              if (!selected || !current || current.cancelRequested || !same(identity(work, current), pins))
                return;
              selected.runId = current.id;
              selected.viewId = current.viewId;
              // The shared run can belong to another Channel, outside this queue projection.
              return { prefix: selected, run: store.select('runs', current.id) };
            },
            driver.beforePublish,
            batch.channel,
          );
          if (shared) {
            Object.assign(prefix, shared.prefix);
            run = shared.run;
          }
        }
      }
      if (run) validatePrefixRun(work, batch, prefix, run);
      if (!batch.admission) await retainDiagnosisNode(work, batch, prefix, parent, driver);
      if (!run || run.status === 'interrupted') {
        durableReplace(
          reservation,
          JSON.stringify({ runId: prefix.runId, viewId: prefix.viewId, head: prefix.head }),
        );
        const dispatch = () =>
          retryWorkPhase(prefix.runId, () =>
            work.dispatch(
              {
                action: 'run-check',
                operationId: prefix.runId,
                viewId: prefix.viewId,
                expectedHead: prefix.head,
                checkId: first.checkId,
                expectedDefinition: first.definition,
                expectedEnvironment: batch.environment?.fingerprint ?? first.environment,
              },
              store.revision(),
              { beforePublish: driver.beforePublish },
            ),
          );
        await (route.actual === 'github-actions' ? withDetachedChecks(dispatch) : dispatch());
      }
    },
    { anchor: store.directory, waitMs },
  );
  return 'value' in admitted;
}
