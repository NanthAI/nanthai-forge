// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource } from './native-source.js';
import { checkChangedPaths } from './work-check-scope.js';
import { selectTests, selectionSourcePath } from '../scripts/test-impact.mjs';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

export type TestVerdict = NonNullable<NonNullable<CheckRun['backend']>['testVerdicts']>[number];
export type TestObservation = {
  id: string;
  at: string;
  tests: TestVerdict[];
  source?: { head: string; definition: string; runtime?: string };
};
type Relation = 'related-change' | 'unrelated-change' | 'unchanged-source' | 'unknown';

/** Static impact is partial: unavailable or full-domain comparisons cannot establish a flake. */
export function testFlakeEvidence(store: WorkStore, run: CheckRun, history: TestObservation[]) {
  const source = new NativeSource(store.root);
  let files: Map<string, string> | undefined;
  const comparisons = new Map<string, (test: string) => Relation>();
  const comparison = (base: string) => {
    if (comparisons.has(base)) return comparisons.get(base)!;
    let relate: (test: string) => Relation = () => 'unknown';
    try {
      let paths = checkChangedPaths(store, base, run.head);
      // Keep the runner's complete landing-batch scope when available.
      if (base === (run.comparisonBase ?? run.base)) {
        try {
          const pinned = JSON.parse(
            readFileSync(join(store.directory, `check-${run.id}`, 'changes.json'), 'utf8'),
          );
          if (
            pinned.version === 1 &&
            pinned.base === base &&
            pinned.head === run.head &&
            Array.isArray(pinned.paths) &&
            pinned.paths.every((path: unknown) => typeof path === 'string')
          )
            paths = [...new Set([...paths, ...pinned.paths])] as string[];
        } catch {
          /* Missing scope leaves the immutable source comparison available. */
        }
      }
      if (!paths.length) relate = () => 'unchanged-source';
      else {
        files ??= new Map(
          source
            .state(run.head)
            .files.filter(file => selectionSourcePath(file.path))
            .map(file => [file.path, source.object(file.blob).toString('utf8')]),
        );
        const selection = selectTests({ files, paths });
        relate = test => {
          const file = test.split(' :: ')[0]!;
          if (paths.includes(file) || (selection.scope !== 'full' && selection.tests.includes(file)))
            return 'related-change';
          return selection.scope === 'full' ? 'unknown' : 'unrelated-change';
        };
      }
    } catch {
      /* Missing source/impact evidence is unknown, never evidence of independence. */
    }
    comparisons.set(base, relate);
    return relate;
  };
  const relation = (test: string) => comparison(run.comparisonBase ?? run.base)(test);
  return {
    canQuarantine: (test: string) => ['unrelated-change', 'unchanged-source'].includes(relation(test)),
    recovery(test: string): TestVerdict {
      const recovery = relation(test);
      const recovered: TestVerdict = { test, verdict: 'recovered', recovery };
      if (recovery === 'related-change' || recovery === 'unknown') return recovered;
      const fixedAt = history
        .filter(item => item.tests.some(result => result.test === test && result.verdict === 'fixed'))
        .map(item => item.at)
        .sort()
        .at(-1);
      for (const previous of history) {
        if (
          !previous.source ||
          (fixedAt && previous.at <= fixedAt) ||
          previous.source.definition !== run.check.definition ||
          previous.source.runtime !== run.backend?.runtime
        )
          continue;
        const old = previous.tests.find(item => item.test === test);
        if (!old || !['failed', 'recovered', 'flake'].includes(old.verdict)) continue;
        const between = comparison(previous.source.head)(test);
        if (
          between === 'unchanged-source' ||
          (recovery === 'unrelated-change' &&
            between === 'unrelated-change' &&
            ['unrelated-change', 'unchanged-source'].includes(old.recovery ?? '') &&
            old.verdict !== 'failed')
        ) {
          return {
            test,
            verdict: 'flake',
            recovery: between,
            evidenceRunId: previous.id,
          };
        }
      }
      return recovered;
    },
  };
}
