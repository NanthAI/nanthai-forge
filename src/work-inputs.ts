// SPDX-License-Identifier: Apache-2.0
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, isAbsolute, join } from 'node:path';
import { digest } from './hash.js';
import { NativeSource } from './native-source.js';
import { workGit } from './work-git.js';
import { invariant } from './errors.js';
import {
  inputAssessmentCommandSchema,
  type DeclaredInput,
  type InputObservation,
} from './work-input-types.js';
import { checkEnvironment } from './work-run.js';
import type { Check, CheckEnvironment, CheckRun, WorkData, WorkView } from './work-types.js';
import type { WorkStore } from './work-store.js';

const unknown = (input: DeclaredInput, details: string): InputObservation => ({
  input,
  status: 'unknown',
  producer: 'local-observation',
  details,
});
function sourceFile(store: WorkStore, head: string, path: string) {
  if (store.native) {
    const source = new NativeSource(store.root),
      entry = source.state(head).files.find(file => file.path === path);
    if (!entry) return;
    const bytes = source.object(entry.blob);
    return { sha256: entry.blob, size: bytes.length, mode: entry.mode };
  }
  // Literal path lookup; no external filters, textconv, replacement objects or fetch.
  const tree = workGit(store.root, ['ls-tree', '-z', head, '--', path], undefined, false, true);
  const info = /^([0-9]+) blob ([0-9a-f]+)\t/.exec(tree.toString('utf8'));
  if (!info || tree.toString('utf8').slice(info[0].length, -1) !== path) return;
  const bytes = workGit(store.root, ['cat-file', 'blob', info[2]!], undefined, false, true);
  return { sha256: digest(bytes), size: bytes.length, mode: info[1] === '100755' ? 'executable' : 'file' };
}
function toolFile(executable: string, environment: CheckEnvironment) {
  const paths = isAbsolute(executable)
    ? [executable]
    : (environment.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map(path => join(path, executable));
  for (const path of paths) {
    let fd: number | undefined;
    try {
      if (!isAbsolute(path)) return; // Relative PATH entries depend on the detached workspace; do not substitute this process's cwd.
      const locator = realpathSync(path),
        info = statSync(locator);
      if (!info.isFile() || (process.platform !== 'win32' && !(info.mode & 0o111))) continue;
      fd = openSync(locator, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const before = fstatSync(fd),
        hash = createHash('sha256'),
        bytes = Buffer.alloc(64 * 1024);
      let size = 0,
        length: number;
      while ((length = readSync(fd, bytes, 0, bytes.length, null))) {
        hash.update(bytes.subarray(0, length));
        size += length;
      }
      const after = fstatSync(fd),
        current = statSync(locator);
      if (
        !before.isFile() ||
        before.size !== size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.mode !== after.mode ||
        before.ino !== current.ino ||
        before.dev !== current.dev ||
        realpathSync(path) !== locator
      )
        return;
      return { sha256: hash.digest('hex'), size, locator, mode: String(before.mode & 0o777) };
    } catch {
      /* A missing or unstable optional observation never prevents execution. */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
export function observeCheckInputs(
  store: WorkStore,
  check: Check,
  head: string,
  environment: CheckEnvironment,
): InputObservation[] | undefined {
  if (!check.declaredInputs?.length) return;
  return check.declaredInputs.map(input => {
    try {
      if (input.kind === 'external')
        return {
          input,
          status: input.claimSha256 ? 'claimed' : 'unknown',
          producer: 'user-declared',
          ...(input.claimSha256 ? { sha256: input.claimSha256 } : {}),
          details: 'External input was not independently observed; a supplied digest is a user claim.',
        };
      if (input.kind === 'environment') {
        // Never read arbitrary process.env names: only the already forwarded ordinary runtime snapshot.
        const value = environment.env[input.name];
        return value === undefined
          ? unknown(
              input,
              'This setting is absent from the forwarded ordinary runtime snapshot; no secret or external environment value was read.',
            )
          : {
              input,
              status: 'observed',
              sha256: digest(value),
              producer: 'forwarded-runtime',
              details:
                'Digest of the selected ordinary runtime setting; value not copied into this observation.',
            };
      }
      const fromSource =
        input.kind === 'source' || (!isAbsolute(input.executable) && /[/\\]/.test(input.executable));
      const path = input.kind === 'source' ? input.path : input.executable.replace(/^\.\//, '');
      const observed = fromSource ? sourceFile(store, head, path) : toolFile(path, environment);
      return observed
        ? {
            input,
            status: 'observed',
            ...observed,
            producer: fromSource ? 'selected-source' : 'local-tool-bytes',
            details: fromSource
              ? 'Exact file bytes/mode in the selected committed source; dirty work is separate.'
              : 'Resolved tool file bytes/mode observed without executing a version command; dependencies are not complete.',
          }
        : unknown(
            input,
            'Selected file/tool is absent, excluded or unavailable; complete input coverage is not established.',
          );
    } catch {
      return unknown(
        input,
        'Selected input could not be observed safely. Source, execution and original evidence remain available.',
      );
    }
  });
}
const identity = (observation: InputObservation) =>
  JSON.stringify({
    sha256: observation.sha256,
    size: observation.size,
    locator: observation.locator,
    mode: observation.mode,
  });
function validationApplicability(
  data: WorkData,
  run: CheckRun,
  environment: CheckEnvironment,
  view?: WorkView,
) {
  const exactView = Boolean(
    view?.status === 'clean' &&
    run.viewId === view.id &&
    run.head === view.head &&
    run.base === view.base &&
    JSON.stringify(run.inputs) === JSON.stringify(view.inputs) &&
    JSON.stringify(run.dependencies) === JSON.stringify(view.dependencies ?? []),
  );
  const definition = data.checks.find(check => check.id === run.check.id)?.definition;
  const checkDefinition =
    definition === undefined
      ? ('unavailable' as const)
      : definition === run.check.definition
        ? ('current' as const)
        : ('changed' as const);
  const recordedRuntime =
    environment.fingerprint === run.environment.fingerprint ? ('current' as const) : ('changed' as const);
  const successfulOutcome =
    run.status === 'passed' &&
    Boolean(run.endedAt) &&
    run.exitCode === 0 &&
    !run.signal &&
    !run.cancelRequested;
  const reasons: string[] = [];
  if (!successfulOutcome) reasons.push('A complete successful command outcome is unavailable.');
  if (!exactView)
    reasons.push('The selected View, source, ordered inputs or dependencies differ from the original run.');
  if (checkDefinition !== 'current') reasons.push('The original check definition is changed or unavailable.');
  if (recordedRuntime !== 'current') reasons.push('Recorded runtime settings changed.');
  return {
    outcome: run.status,
    successfulOutcome,
    exactView,
    checkDefinition,
    recordedRuntime,
    exactPassedRun:
      successfulOutcome && exactView && checkDefinition === 'current' && recordedRuntime === 'current',
    reasons,
    reuse: 'disabled' as const,
    humanReview: 'separate' as const,
  };
}
export function declaredInputApplicability(
  store: WorkStore,
  data: WorkData,
  run: CheckRun,
  environment: CheckEnvironment,
  selected?: WorkView,
) {
  const view =
    selected ??
    data.views.filter(item => item.intentId === data.views.find(v => v.id === run.viewId)?.intentId).at(-1);
  const reasons: string[] = [],
    check = data.checks.find(item => item.id === run.check.id);
  if (check?.definition !== run.check.definition) reasons.push('The check definition changed.');
  if (environment.fingerprint !== run.environment.fingerprint)
    reasons.push('Recorded runtime settings changed.');
  const current =
    view?.status === 'clean' && view.head
      ? observeCheckInputs(store, run.check, view.head, environment)
      : undefined;
  const inputs = (run.check.declaredInputs ?? []).map((input, index) => {
    const original = run.inputObservations?.[index],
      observation = current?.[index];
    const known =
      original?.status === 'observed' &&
      observation?.status === 'observed' &&
      JSON.stringify(original.input) === JSON.stringify(input);
    const applicability = known
      ? identity(original) === identity(observation)
        ? 'current'
        : 'changed'
      : 'unknown';
    return { input, applicability, original: original ?? null, current: observation ?? null };
  });
  const applicability = !inputs.length
    ? ('unknown' as const)
    : reasons.length || inputs.some(input => input.applicability === 'changed')
      ? ('changed' as const)
      : inputs.some(input => input.applicability === 'unknown')
        ? ('unknown' as const)
        : ('current' as const);
  return {
    applicability,
    reasons,
    viewId: view?.id ?? null,
    head: view?.head ?? null,
    inputs,
    validation: validationApplicability(data, run, environment, view),
    coverage:
      'Only declared, observed inputs are compared. Undeclared dependencies and external effects remain unknown; this diagnostic never reuses evidence, skips checks or supplies approval.',
  };
}
export function assessCheckInputs(store: WorkStore, input: unknown, revision: number) {
  const parsed = inputAssessmentCommandSchema.safeParse(input);
  invariant(
    parsed.success && Number.isSafeInteger(revision) && revision >= 0,
    'BAD_ARGUMENT',
    'Choose a retained check run and exact clean View.',
  );
  return store.locked(() => {
    const data = store.load(),
      command = parsed.data,
      run = data.runs.find(item => item.id === command.runId);
    invariant(run, 'NOT_FOUND', 'Check run not found.');
    const view = data.views.find(item => item.id === command.viewId);
    invariant(
      view?.status === 'clean' && view.head === command.expectedHead,
      'VIEW_STALE',
      'Choose an existing clean View and exact source head.',
    );
    return {
      revision: data.revision,
      result: { runId: run.id, ...declaredInputApplicability(store, data, run, checkEnvironment(), view) },
    };
  });
}
