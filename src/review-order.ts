// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The order a person reads a change in (Item 52235fbf): files grouped by what needs eyes, each with the observed fact
// that put it there. "Needs your eyes" holds only what the Lane page's Facts name: a conflict with another Lane or main
// and a protected-path match; every other code file is "Code" (Item c2388099). Never a risk score: every reason is a fact Forge saw (a status, a mode, a path, a protected-path
// rule, a conflict with another Lane). The web review screen and the agent's `diff {summary:true}` share this module,
// so both give the same group and the same words for the same facts. Pure: no reads, no clock, safe in any client.

export type ReviewGroup = 'eyes' | 'code' | 'tests' | 'low';
export type ReviewFacts = {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  /** File modes on each side, when the manifest has them. */
  before?: string | null;
  after?: string | null;
  /** Prose by the one docs rule (documentationPath in prose-paths.ts). The caller decides it, so this module imports
   * nothing and adds no chunk or module to any client that loads it. */
  doc?: boolean;
  /** Matched one of the project's protected-path rules. Omitted when the rules were not read. */
  protected?: boolean;
  /** Exact conflicts found at save: with whom (a Lane label or "main") and on which of this Lane's lines. */
  crossing?: readonly { with: string; lines: string }[];
};
export type ReviewEntry = { path: string; group: ReviewGroup; reason: string; rank: number };

export const reviewGroupLabels: Record<ReviewGroup, { title: string; hint: string }> = {
  eyes: { title: 'Needs your eyes', hint: 'overlaps and protected paths' },
  code: { title: 'Code', hint: 'no overlap, not protected' },
  tests: { title: 'Tests', hint: 'what proves it' },
  low: { title: 'Low risk', hint: 'docs, fixtures and binary files' },
};

const TEST = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|\.(?:test|spec)\.[^/]+$|_test\.[^/]+$/i;
const FIXTURE = /(?:^|\/)(?:__)?fixtures?(?:__)?\//i;
const BINARY =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|jar|wasm|woff2?|ttf|otf|eot|mp[34]|mov|webm|ogg|wav|bin|dat|so|dylib|dll|exe|class|pyc)$/i;

/** One file's group and its reason, from facts alone. Lower rank reads first inside its group. */
export function reviewEntry(facts: ReviewFacts): ReviewEntry {
  const { path, status } = facts;
  const crossing = facts.crossing?.[0];
  if (crossing)
    return {
      path,
      group: 'eyes',
      rank: 0,
      reason:
        crossing.with === 'main'
          ? `conflicts with main at ${crossing.lines}`
          : `same lines as ${crossing.with}, ${crossing.lines}`,
    };
  if (facts.protected) return { path, group: 'eyes', rank: 1, reason: 'a protected path' };
  const after = status === 'deleted' ? null : (facts.after ?? null);
  if (after === 'gitlink' || facts.before === 'gitlink')
    return { path, group: 'code', rank: 2, reason: 'a submodule pointer' };
  if (after === 'symlink' && facts.before !== 'symlink')
    return { path, group: 'code', rank: 2, reason: 'now a link' };
  if (after === 'executable' && facts.before !== 'executable' && status !== 'added')
    return { path, group: 'code', rank: 2, reason: 'now executable' };
  if (FIXTURE.test(path))
    return {
      path,
      group: 'low',
      rank: 4,
      reason: status === 'deleted' ? 'test fixture removed' : 'a test fixture',
    };
  if (BINARY.test(path))
    return { path, group: 'low', rank: 5, reason: status === 'deleted' ? 'binary, removed' : 'binary' };
  if (TEST.test(path))
    return {
      path,
      group: 'tests',
      rank: status === 'deleted' ? 0 : status === 'added' ? 1 : 2,
      reason: status === 'deleted' ? 'test removed' : status === 'added' ? 'new test file' : 'test changed',
    };
  if (facts.doc)
    return { path, group: 'low', rank: 3, reason: status === 'deleted' ? 'doc removed' : 'docs only' };
  return {
    path,
    group: 'code',
    rank: status === 'deleted' ? 3 : status === 'added' ? 4 : 5,
    reason: status === 'deleted' ? 'removed' : status === 'added' ? 'new file' : 'code changed',
  };
}

export const reviewGroups: readonly ReviewGroup[] = ['eyes', 'code', 'tests', 'low'];

/** Every file in reading order: by group, then rank, then path. File order is the same entries sorted by path. */
export function reviewOrder(files: readonly ReviewFacts[]): ReviewEntry[] {
  return files
    .map(reviewEntry)
    .sort(
      (a, b) =>
        reviewGroups.indexOf(a.group) - reviewGroups.indexOf(b.group) ||
        a.rank - b.rank ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
}

/** How many files fall in each group, for the head sentence and the agent summary. */
export function reviewCounts(entries: readonly Pick<ReviewEntry, 'group'>[]) {
  const counts: Record<ReviewGroup, number> = { eyes: 0, code: 0, tests: 0, low: 0 };
  for (const entry of entries) counts[entry.group]++;
  return counts;
}
