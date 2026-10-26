import { landingRunBatch } from './landing-records-index.js';
// SPDX-License-Identifier: Apache-2.0
import { ForgeError, invariant } from './errors.js';
import { hostname } from 'node:os';
import { processIdentity } from './local-process.js';
import { diskGuard } from './disk-guard.js';
import { checkRoute, actionsCheckRuntime } from './check-backend.js';
import { modalRuntime } from './modal-plan.js';
import { checkReuseKey } from './check-reuse-key.js';
import { checkEnvironment, checkEnvironmentDescription } from './check-environment.js';
import { observeCheckInputs } from './work-inputs.js';
import { readPolicy } from './work-autonomy.js';
import { interactionEvidence } from './work-interaction.js';
import { runCandidateFamily } from './work-run-cancellation.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun, EvidenceCommand } from './work-types.js';

type RunCommand = Extract<EvidenceCommand, { action: 'run-check' }>;
/** Prepare exact source/input evidence and immutable run pages before the owner
 * lock. Registration validates this pointer, definitions and Playbook ownership;
 * no runner starts until the run record is committed. */
export function prepareRunRegistration(store: WorkStore, command: RunCommand, sequenceId?: string) {
  try {
    if (!store.readRecords()) store.locked(() => store.records(), { operation: 'run migration' });
    return store.observing(() => {
      const tx = store.readRecords();
      if (!tx || tx.find('runs', command.operationId)) return undefined;
      const check = tx.find('checks', command.checkId)?.record,
        view = tx.find('views', command.viewId)?.record;
      if (!check || check.definition !== command.expectedDefinition || view?.head !== command.expectedHead)
        return undefined;
      const batch =
        view.mainCheck || view.recovery
          ? undefined
          : landingRunBatch(store, tx, command.operationId, command.viewId, command.expectedHead);
      if (command.tests !== undefined)
        invariant(
          JSON.stringify(check.args) === JSON.stringify(['scripts/forge-check.mjs']) &&
            (check.executable === process.execPath || /(?:^|\/)node$/.test(check.executable)),
          'BAD_ARGUMENT',
          'Explicit test files require the standard Forge check.',
        );
      const environment = batch?.environment ?? checkEnvironment();
      if (environment.fingerprint !== command.expectedEnvironment)
        throw new ForgeError(
          'EVIDENCE_CHANGED',
          'Check definition or runtime settings changed. Inspect them before starting.',
        );
      const warnings = diskGuard(store.root),
        inputObservations = observeCheckInputs(store, check, command.expectedHead, environment),
        policy = readPolicy(store).checks,
        route = checkRoute(policy?.runner ?? 'local', check, store.native);
      const run: CheckRun = {
        backend: {
          ...route,
          ...(route.actual === 'modal' ? { credentialsRef: policy?.credentialsRef ?? null } : {}),
        },
        id: command.operationId,
        viewId: view.id,
        supersessionBaseline: runCandidateFamily(tx, view).at(-1)?.id ?? view.id,
        head: command.expectedHead,
        base: view.base,
        ...(view.composedMain ? { comparisonBase: view.composedMain } : {}),
        inputs: view.inputs,
        ...(view.mainCheck ? { mainCheck: view.mainCheck } : {}),
        ...(view.optimistic ? { optimistic: true } : {}),
        ...(view.recovery ? { recovery: view.recovery } : {}),
        dependencies: view.dependencies ?? [],
        check,
        ...(command.tests !== undefined
          ? {
              checkSelection: {
                scope: 'partial' as const,
                reason: 'Explicit test-file list; partial evidence cannot satisfy a landing gate.',
                tests: command.tests,
              },
            }
          : {}),
        environment,
        status: 'queued',
        queuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        warnings,
        runner: { ...processIdentity(), host: hostname() },
        details:
          checkEnvironmentDescription(check) +
          ' Queued for machine-wide check capacity; preparing the exact committed candidate for the selected command. No evidence reuse.',
        ...(inputObservations ? { inputObservations } : {}),
        ...(sequenceId ? { playbookRunId: sequenceId } : {}),
      };
      // Older readers without selection evidence must reject this optional feature.
      if (command.tests !== undefined) tx.setSchema(15);
      run.reuseKey = checkReuseKey(store, {
        ...run,
        backend: {
          ...run.backend!,
          ...(route.actual === 'local'
            ? {}
            : {
                runtime:
                  route.actual === 'github-actions'
                    ? actionsCheckRuntime(policy?.repo, policy?.runsOn)
                    : modalRuntime,
              }),
        },
      });
      if (command.interaction !== undefined) {
        run.interaction = command.interaction ? interactionEvidence(store, run, command.interaction) : null;
        tx.setSchema(15);
      }
      tx.append('runs', run);
      return { tx, run };
    });
  } catch (error) {
    // Busy, original-operation and requested-pin errors retain their precedence.
    return { error };
  }
}
