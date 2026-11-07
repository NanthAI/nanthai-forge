// SPDX-License-Identifier: Apache-2.0
// How close each test is to a changed module, read from the parsed import graph only: no file
// reads, no process, no server call. Preflight ranks local tests with it; landing coverage never
// depends on it (a missing edge proves nothing).

const testFile = path => /^tests\/[^/]+\.test\.mjs$/.test(path);
const testHelper = path => path.startsWith('tests/') && !testFile(path);

/** Evidence that keeps landing coverage but never makes a test close: a computed or unknown path,
 * or a by-name loader's closure edge (every Convex module named anywhere the test's code reaches). */
export const weakEdge = evidence => !evidence || evidence.kind === 'dynamic' || evidence.byName === true;
/** Product code running a changed module: a static import or an in-process Convex dispatch. A path
 * string in product code is data, not execution. */
const runsModule = evidence =>
  !weakEdge(evidence) && ['import', 'function-reference'].includes(evidence.kind);

/** Ranks compare as [product hops, carrier fan-in, helper hops]: fewer product modules between the
 * change and the test first, then a specific carrier (the test itself, or a fixture few tests use)
 * before a shared harness, then fewer fixture hops. */
export const compareRank = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** One index per parsed graph. `consumers(path)` returns test -> rank for the tests that run a
 * changed module: tests that load it, directly or through test fixtures (product hops 0), and
 * tests that load, directly or through fixtures, a module that imports or dispatches it (product
 * hops 1, "fixture-reached": a fixture that loads `convex/a.ts` runs every module `a.ts` imports
 * for each test that uses it). `readers` limits carriers to edges that read the file's text rather
 * than run it (for comment-only edits). Fan-in is memoized per carrier, so a whole change costs one
 * bounded walk of the test side of the graph. */
export function closenessIndex(graph) {
  const carried = new Map();
  /** Tests reached from a carrier through test helpers, with their helper depth. */
  const through = carrier => {
    if (carried.has(carrier)) return carried.get(carrier);
    const found = new Map();
    if (testFile(carrier)) found.set(carrier, 0);
    else {
      const depth = new Map([[carrier, 0]]);
      const queue = [carrier];
      for (let i = 0; i < queue.length; i++) {
        const current = queue[i];
        for (const importer of graph.reverse.get(current) ?? []) {
          if (depth.has(importer) || weakEdge(graph.evidence.get(current)?.get(importer))) continue;
          depth.set(importer, depth.get(current) + 1);
          if (testFile(importer)) found.set(importer, depth.get(importer));
          else if (testHelper(importer)) queue.push(importer);
        }
      }
    }
    carried.set(carrier, found);
    return found;
  };
  const consumers = (path, { readers = false, maxHops = 1 } = {}) => {
    const found = new Map();
    const offer = (test, rank) => {
      const previous = found.get(test);
      if (!previous || compareRank(rank, previous) < 0) found.set(test, rank);
    };
    const carriers = (module, hops) => {
      for (const importer of graph.reverse.get(module) ?? []) {
        const evidence = graph.evidence.get(module)?.get(importer);
        if (!importer.startsWith('tests/') || weakEdge(evidence)) continue;
        if (readers && evidence.kind === 'import') continue;
        const tests = through(importer);
        for (const [test, depth] of tests) offer(test, [hops, tests.size, depth]);
      }
    };
    if (testFile(path)) return found;
    carriers(path, 0);
    if (readers || testHelper(path)) return found;
    // Product modules that run the changed one, nearest first, up to `maxHops` modules between.
    const seen = new Set([path]);
    let level = [path];
    for (let hops = 1; hops <= maxHops && level.length; hops++) {
      const next = [];
      for (const module of level)
        for (const importer of graph.reverse.get(module) ?? [])
          if (
            !seen.has(importer) &&
            !importer.startsWith('tests/') &&
            runsModule(graph.evidence.get(module)?.get(importer))
          ) {
            seen.add(importer);
            next.push(importer);
            carriers(importer, hops);
          }
      level = next;
    }
    return found;
  };
  return { consumers };
}
