// SPDX-License-Identifier: Apache-2.0
// Browser work shares one existing test job; the other jobs need no browser cache.
import { createRequire } from 'node:module';
import { testDuration } from './test-shards.mjs';
import { browserTests, isBrowserTest } from './test-browser-names.mjs';
export { browserTests, isBrowserTest };
/** Browser fixtures present in an inventory (Map, Set or array of paths). */
export function browserFiles(files) {
  return [...(files instanceof Map ? files.keys() : files)].filter(isBrowserTest).sort();
}
export function browserChange(paths, files, graphCache = {}) {
  if (paths === undefined) return true;
  if (
    paths.some(
      path =>
        path.startsWith('web/') ||
        isBrowserTest(path) ||
        /^(?:tests\/(?:fixtures|browser)\/|tests\/[^/]*fixture[^/]*\.mjs$)/.test(path) ||
        [
          'package.json',
          'package-lock.json',
          'tests/browser-runtime.mjs',
          'scripts/check-browser-runtime.mjs',
          'scripts/browser-test-policy.mjs',
          'scripts/test-browser-names.mjs',
        ].includes(path),
    )
  )
    return true;
  if (!files || !paths.some(path => /^(?:src|convex)\//.test(path))) return false;
  // Reuse the source selector's import graph; never execute inspected repository modules.
  // Lazy because the public scope job runs before npm installs the parser.
  const { testImportGraph } = createRequire(import.meta.url)('./test-import-graph.mjs');
  const graph = (graphCache.graph ||= testImportGraph(files, [], { typeImports: true }));
  if (graph.error) return true;
  const pending = [...paths],
    visited = new Set(pending);
  for (const path of pending) {
    if (path.startsWith('web/')) return true;
    for (const importer of graph.reverse.get(path) ?? [])
      if (/^(?:web|src|convex)\//.test(importer) && !visited.has(importer)) {
        visited.add(importer);
        pending.push(importer);
      }
  }
  return false;
}

export function browserSelection(selection, paths, files, graphCache) {
  // This policy annotates actual browser coverage, not arbitrary projects using
  // the standard executor. Their ordinary selection and recipe stay unchanged.
  const present = browserFiles(files);
  if (!present.length) return selection;
  // Full means full (Item 687d1eda): every full selection (full gates, audits, full-gated reverts)
  // runs every browser test, so a pass can never stand on browser tests it left out.
  const enabled =
    selection.scope === 'full' ||
    (selection.scope === 'scoped' && selection.tests.some(isBrowserTest)) ||
    browserChange(paths, files, graphCache);
  // docs-site also checks static generated contracts: retain that part on non-web changes.
  const tests = enabled
    ? [...new Set([...selection.tests, ...present])].sort()
    : selection.tests.filter(file => !isBrowserTest(file) || file === 'tests/docs-site.test.mjs');
  return { ...selection, tests, browser: enabled };
}

export function browserGroups(groups, enabled, durations = {}) {
  if (!enabled) return groups;
  const files = groups.flat(),
    browsers = files.filter(isBrowserTest);
  if (!browsers.length) return groups;
  const ordinary = files.filter(file => !isBrowserTest(file));
  if (!ordinary.length) return [browsers];
  const balanced = Array.from({ length: Math.min(groups.length, ordinary.length + 1) }, () => []);
  balanced[balanced.length - 1] = browsers;
  const fallback = testDuration('', durations);
  const weight = file => (durations[file] > 0 ? durations[file] : fallback);
  const slots = balanced.map(group => {
    const workers = [0, 0];
    for (const file of group) workers[workers[0] <= workers[1] ? 0 : 1] += weight(file);
    return workers;
  });
  // Seed the browser job, then fill every job with ordinary files using the same
  // two-worker duration model as the ordinary partitioner. No reserved empty capacity.
  for (const file of ordinary.sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    let best = 0;
    const score = index => [
      Math.max(...slots[index], Math.min(...slots[index]) + weight(file)),
      slots[index][0] + slots[index][1],
    ];
    for (let index = 1; index < balanced.length; index++) {
      const a = score(index),
        b = score(best);
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) best = index;
    }
    balanced[best].push(file);
    slots[best][slots[best][0] <= slots[best][1] ? 0 : 1] += weight(file);
  }
  return balanced;
}

export function browserShard(groups, enabled) {
  return enabled ? groups.findIndex(group => group.some(isBrowserTest)) : -1;
}
