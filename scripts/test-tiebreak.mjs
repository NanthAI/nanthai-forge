// SPDX-License-Identifier: Apache-2.0
// Tie-breaking for preflight tests that rank equally close to a change (Issue 964e2d2b). A hub
// module is loaded by well over a hundred tests that all share one import-graph rank; the time budget
// then keeps a prefix of that tie. Ordering the tie by file name made coverage depend on names, so
// one new equally close test could push a relevant importer out. A tied test now orders by what
// Forge already holds: a recent landing failure, how much its name and text are about the changed
// modules, then a stable hash. Reads only text already in the inventory; no file read, no call.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/** At most this many changed modules are matched against test text: the cost of a large change is
 * bounded (modules * tied tests * text size), and the most specific names carry the signal. */
const MAX_MODULES = 32;
const stripExtension = path => posix.basename(path).replace(/(?:\.test)?\.[cm]?[jt]sx?$/, '');
const splitWords = name =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    // `saves` and `save` are the same word; a plural never separates a test from its module.
    .map(word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));

/** Stable, name-independent order key: the same test gets the same key for the same change on any
 * machine, and the key of one test never depends on which other tests exist. */
export const changeSalt = paths => [...new Set(paths)].sort().join('\n');
export const stableKey = (salt, test) =>
  createHash('sha256').update(salt).update('\0').update(test).digest('hex').slice(0, 16);

/** Share (0-100) of a test's name words that also name a changed module: `hosted-compose.test.mjs`
 * is all about `projectHostedComposeJobs.ts`; `hosted-agent-cache.test.mjs` is a third about it. */
function affinity(test, modules) {
  const own = splitWords(stripExtension(test));
  if (!own.length) return 0;
  let best = 0;
  for (const words of modules) {
    const theirs = new Set(words);
    best = Math.max(best, own.filter(word => theirs.has(word)).length);
  }
  return Math.round((best / own.length) * 100);
}

/** Relevance of tests to a change, compared as [recent failure, name affinity, mentions]; larger is
 * more relevant. `mentions` counts how often the test's own text names a changed module. Memoized per
 * test; one object serves one change. */
export function relevanceFor({ files, changed, recent = new Set() }) {
  const names = [...new Set(changed.map(stripExtension).filter(name => name.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_MODULES);
  const modules = names.map(splitWords);
  const memo = new Map();
  return test => {
    let value = memo.get(test);
    if (value) return value;
    const text = files.get(test);
    let mentions = 0;
    if (typeof text === 'string')
      for (const name of names)
        for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) mentions++;
    value = [recent.has(test) ? 1 : 0, affinity(test, modules), Math.min(mentions, 99)];
    memo.set(test, value);
    return value;
  };
}

/** Descending comparison of two relevance tuples (more relevant first). */
export const compareRelevance = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
};
