// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { reviewPaths } from './native-source-review.js';
import { DOCS_RULE, markdownDoc, resolveDocsComposition } from './native-docs-resolve.js';
import { runApplicability } from './work-evidence.js';
import { interactionRequestSchema, type CheckRun } from './work-types.js';
import type { WorkStore } from './work-store.js';
import type { z } from 'zod';

export const pathsOverlap = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Runner-derived facts, separate from the command's reported test selection.
 * Ineligible evidence retains its reason for ordinary merged-View selection. */
export function interactionEvidence(
  store: WorkStore,
  run: CheckRun,
  request: z.infer<typeof interactionRequestSchema>,
): NonNullable<CheckRun['interaction']> {
  const evidence: NonNullable<CheckRun['interaction']> = {
    ...request,
    mergedHead: run.head,
    eligible: false,
    reason: 'Interaction coverage unavailable',
    lanePaths: [],
    mainPaths: [],
    overlap: [],
  };
  const fail = (reason: string) => ({ ...evidence, reason });
  try {
    if (!store.native) return fail('Interaction requires native immutable ancestry');
    const source = new NativeSource(store.root),
      data = store.load();
    const old = data.runs.find(item => item.id === request.reusedRunId);
    const checked = old && data.views.find(item => item.id === old.viewId);
    const merged = data.views.find(item => item.id === run.viewId);
    // Applicability's candidate-recency test is evaluated before the new View;
    // composing the replacement must not by itself invalidate the reused run.
    const priorData = { ...data, views: data.views.filter(view => view.id !== run.viewId) };
    if (
      !old ||
      !checked ||
      !merged ||
      old.status !== 'passed' ||
      !old.endedAt ||
      old.head !== request.checkedHead ||
      checked.head !== old.head ||
      checked.status !== 'clean' ||
      checked.composedMain !== request.base ||
      old.comparisonBase !== request.base ||
      old.base !== checked.base ||
      JSON.stringify(old.inputs) !== JSON.stringify(checked.inputs) ||
      JSON.stringify(old.dependencies) !== JSON.stringify(checked.dependencies ?? []) ||
      old.check.id !== run.check.id ||
      old.check.definition !== run.check.definition ||
      runApplicability(priorData, old, run.environment).applicability !== 'current'
    )
      return fail('Reused passing run pins or applicability changed');
    if (
      merged.status !== 'clean' ||
      merged.resolution ||
      checked.resolution ||
      merged.composedMain !== request.main ||
      run.comparisonBase !== request.main ||
      JSON.stringify(old.dependencies) !== JSON.stringify(run.dependencies) ||
      JSON.stringify(old.inputs.map(pin => pin.laneId)) !==
        JSON.stringify(run.inputs.map(pin => pin.laneId)) ||
      run.check.declaredInputs?.length ||
      run.check.credentials?.length ||
      run.check.env?.length
    )
      return fail('Changed composition or uncertain external inputs');
    if (
      !source.contains(request.main, request.base) ||
      !source.contains(request.checkedHead, request.base) ||
      !source.contains(run.head, request.main) ||
      !source.contains(run.head, request.checkedHead)
    )
      return fail('Missing interaction ancestry');
    const composed = source.compose(request.main, request.checkedHead, 'Interaction proof', run.startedAt);
    // Finish's sync applies the same deterministic Markdown rule; recompute, never trust it.
    const docs = composed.head
        ? null
        : resolveDocsComposition(
            source,
            request.checkedHead,
            request.main,
            'Interaction proof',
            run.startedAt,
          ),
      head = composed.head ?? docs?.head;
    if (!head || source.tree(source.state(head).files) !== source.tree(source.state(run.head).files))
      return fail('Merged source differs from clean pinned composition');
    const changed = (base: string, head: string) =>
      reviewPaths(source.state(base).files, source.state(head).files)
        .filter(path => path.status !== 'unchanged')
        .map(path => path.path)
        .sort();
    evidence.lanePaths = changed(request.base, request.checkedHead);
    evidence.mainPaths = changed(request.base, request.main);
    evidence.overlap = [
      ...new Set(
        [...evidence.lanePaths, ...evidence.mainPaths].filter(path =>
          evidence.lanePaths.some(a =>
            evidence.mainPaths.some(b => pathsOverlap(a, b) && (path === a || path === b)),
          ),
        ),
      ),
    ].sort();
    // The command still classifies both complete sides before allowing docs scope.
    if (evidence.overlap.length && evidence.overlap.every(markdownDoc))
      return {
        ...evidence,
        basis: 'docs-overlap',
        eligible: true,
        reason: docs
          ? `Validated Markdown-only overlap; resolved conflicts in ${docs.paths.join(', ')} (${DOCS_RULE}); side classification required`
          : 'Validated clean Markdown-only overlap; side classification required',
      };
    // A main audit intentionally sets FULL=1; all other runtime settings must match.
    const runtime = (item: CheckRun) => {
      const environment = { ...item.environment };
      Reflect.deleteProperty(environment, 'fingerprint');
      const env = { ...environment.env };
      if (item.mainCheck) delete env.FORGE_CHECK_FULL;
      return JSON.stringify({ ...environment, env });
    };
    const mainRun = [...data.runs].reverse().find(item => {
      const view = data.views.find(view => view.id === item.viewId);
      return (
        item.head === request.main &&
        item.status === 'passed' &&
        !!item.endedAt &&
        item.checkSelection?.scope === 'full' &&
        item.check.id === run.check.id &&
        item.check.definition === run.check.definition &&
        runtime(item) === runtime(run) &&
        view?.status === 'clean' &&
        view.head === item.head &&
        item.base === view.base &&
        JSON.stringify(item.inputs) === JSON.stringify(view.inputs) &&
        JSON.stringify(item.dependencies) === JSON.stringify(view.dependencies ?? [])
      );
    });
    if (!mainRun) return fail('No exact passing full coverage of pinned main');
    return {
      ...evidence,
      mainRunId: mainRun.id,
      basis: 'main-full-coverage',
      eligible: true,
      reason: docs
        ? `Validated interaction and both passing sides; resolved conflicts in ${docs.paths.join(', ')} (${DOCS_RULE})`
        : 'Validated clean interaction and both passing sides',
    };
  } catch {
    return fail('Unavailable immutable interaction inputs');
  }
}
