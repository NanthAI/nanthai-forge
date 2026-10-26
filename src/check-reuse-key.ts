// SPDX-License-Identifier: Apache-2.0
import { actionsCheckRuntime, checkRoute } from './check-backend.js';
import { readPolicy } from './work-autonomy.js';
import { modalRuntime } from './modal-plan.js';
import { digest } from './hash.js';
import { NativeSource } from './native-source.js';
import { workGit } from './work-git.js';
import { checkPassthrough } from './check-environment.js';
import { observeCheckInputs } from './work-inputs.js';
import { selfMetricReuseKey } from './self-metrics-reuse-key.js';
import type { CheckRun, CheckEnvironment } from './work-types.js';
import type { WorkStore } from './work-store.js';

/** Runtime strings remain intact in receipts; only Node major.minor is an input. */
export function checkNodeVersion(run: Pick<CheckRun, 'backend' | 'environment'>) {
  return run.backend && run.backend.actual !== 'local'
    ? /(?:^|;)node:([^;]+)/.exec(run.backend.runtime ?? '')?.[1]
    : run.environment.node;
}

/** Paths, timestamps and process/install fingerprints are observations, not content. */
export function checkReuseKey(
  store: WorkStore,
  run: Pick<CheckRun, 'head' | 'check' | 'environment' | 'backend' | 'inputObservations'>,
): string | undefined {
  try {
    let tree: string, lockfile: string;
    if (store.native) {
      const source = new NativeSource(store.root),
        files = source.state(run.head).files;
      tree = digest(JSON.stringify(files));
      lockfile = files.find(file => file.path === 'package-lock.json')?.blob ?? digest('');
    } else {
      tree = workGit(store.root, ['rev-parse', `${run.head}^{tree}`]).trim();
      const entry = workGit(store.root, ['ls-tree', '-z', run.head, '--', 'package-lock.json']);
      const blob = /^[0-9]+ blob ([0-9a-f]+)\tpackage-lock.json\0$/.exec(entry)?.[1];
      lockfile = blob
        ? digest(workGit(store.root, ['cat-file', 'blob', blob], undefined, false, true))
        : digest('');
    }
    return selfMetricReuseKey({
      tree,
      lockfile,
      definition: run.check.definition,
      node: checkNodeVersion(run),
      declaredInputs: {
        inputs: (run.check.declaredInputs ?? []).map((input, index) => {
          const observed = run.inputObservations?.[index];
          return {
            input,
            status: observed?.status ?? 'unknown',
            sha256: observed?.sha256,
            size: observed?.size,
            mode: observed?.mode,
          };
        }),
        environment: checkPassthrough(run.check).map(name => ({
          name,
          sha256: run.environment.env[name] === undefined ? null : digest(run.environment.env[name]!),
        })),
      },
    });
  } catch {
    return; // Unavailable source cannot establish a reusable identity.
  }
}

export function reusableCheckInputs(run: CheckRun) {
  return (
    (run.inputObservations?.length ?? 0) === (run.check.declaredInputs?.length ?? 0) &&
    checkPassthrough(run.check).every(name => name in run.environment.env) &&
    (run.check.declaredInputs ?? []).every((input, index) => {
      const observed = run.inputObservations?.[index];
      return (
        observed?.status === 'observed' &&
        !!observed.sha256 &&
        JSON.stringify(observed.input) === JSON.stringify(input)
      );
    })
  );
}

/** Re-observe declared inputs; never manufacture keys for legacy receipts. */
export function currentCheckReuseKey(
  store: WorkStore,
  run: CheckRun,
  environment: CheckEnvironment,
  backend?: CheckRun['backend'],
) {
  if (!backend) {
    const policy = readPolicy(store).checks,
      route = checkRoute(policy?.runner ?? 'local', run.check, store.native);
    backend = {
      ...route,
      ...(route.actual === 'local'
        ? {}
        : {
            runtime:
              route.actual === 'github-actions'
                ? actionsCheckRuntime(policy?.repo, policy?.runsOn)
                : modalRuntime,
          }),
    };
  }
  const current = {
    ...run,
    environment,
    backend,
    inputObservations: observeCheckInputs(store, run.check, run.head, environment),
  };
  return reusableCheckInputs(current) ? checkReuseKey(store, current) : undefined;
}

/** Both legacy partial flags and explicit test-list selections are non-gating. */
export const gateCheck = (run: CheckRun) =>
  run.checkSelection?.partial !== true && run.checkSelection?.scope !== 'partial';
