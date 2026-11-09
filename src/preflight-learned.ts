// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { knownLockfiles } from './ecosystems.js';
import { durableReplace } from './native-durability.js';
import { retainedRootSibling } from './root-paths.js';
import { safeRelative } from './safe-relative.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { plausibleTestFile } from './test-file-name.js';
import { rememberHostedCheck } from './preflight-hosted-timing.js';

/** What preflight learned the hard way: test files that failed in a landing check or a local
 * preflight while a path was changed. The next preflight that changes one of those paths runs them
 * as a protected tier, even when the import graph does not reach them (that miss is why they were
 * learned). A disposable clone-local record shared by sibling Lanes; never uploaded, no server
 * call. Bounded by age and entries, never by how many tests a selection may hold. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const MAX_LANES = 200;
/** Decides whether a reported name is a test file of this project. Preflight passes the project
 * runner's globs; a landing result has no runner at hand, so it falls back to the test-name shape of
 * any ecosystem (`x.test.mjs`, `x_test.go`, `test_x.py`, `XTest.java`). */
export type TestFilter = (file: string) => boolean;
/** Every lockfile the ecosystem registry (src/ecosystems.ts) recognises, at any depth. */
const LOCKFILES: ReadonlySet<string> = new Set(knownLockfiles());
const lockfile = { test: (path: string) => LOCKFILES.has(path.slice(path.lastIndexOf('/') + 1)) };
const storeSchema = z
  .object({
    /** changed path -> failing test -> last failure time (ms). */
    learned: z.record(z.string(), z.record(z.string(), z.number())),
    /** The changed paths each Lane last submitted for landing, so its check failure can be mapped. */
    lanes: z.record(z.string(), z.object({ paths: z.array(z.string()), at: z.number() }).strict()),
  })
  .strict();
type Store = z.infer<typeof storeSchema>;

const storePath = (root: string) =>
  join(retainedRootSibling(root, '.forge-client'), 'agent', 'preflight-learned.json');
function read(root: string): Store {
  try {
    return storeSchema.parse(JSON.parse(readFileSync(storePath(root), 'utf8')));
  } catch {
    return { learned: {}, lanes: {} };
  }
}
function write(root: string, store: Store, now: number) {
  const pairs = Object.entries(store.learned)
    .flatMap(([path, tests]) => Object.entries(tests).map(([test, at]) => ({ path, test, at })))
    .filter(item => now - item.at <= MAX_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ENTRIES);
  const learned: Store['learned'] = {};
  for (const { path, test, at } of pairs) (learned[path] ??= {})[test] = at;
  const lanes = Object.fromEntries(
    Object.entries(store.lanes)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_LANES),
  );
  try {
    mkdirSync(join(storePath(root), '..'), { recursive: true, mode: 0o700 });
    durableReplace(storePath(root), JSON.stringify({ learned, lanes }));
  } catch {
    /* Learning is a hint; it never fails the command that observed it. */
  }
}
/** Only changed source paths carry the association; Markdown and lockfile edits explain nothing. */
const keyPaths = (paths: string[]) =>
  paths.filter(path => !/\.md$/.test(path) && !lockfile.test(path) && !plausibleTestFile(path));

/** Records that these tests failed while these paths were changed. */
export function learnFailures(
  root: string,
  paths: string[],
  tests: string[],
  now = Date.now(),
  isTest: TestFilter = plausibleTestFile,
) {
  const failing = [...new Set(tests.filter(test => safeTestName(test) && isTest(test)))];
  const keys = keyPaths(paths);
  if (!failing.length || !keys.length) return;
  const store = read(root);
  for (const path of keys) for (const test of failing) (store.learned[path] ??= {})[test] = now;
  write(root, store, now);
}

/** Stored names stay plain relative paths whatever the filter says. */
const safeTestName = (test: unknown): test is string =>
  typeof test === 'string' && test.length <= 1024 && /^[\w.@+\-/]+$/.test(test) && safeRelative(test);

/** Tests learned for any of these changed paths, oldest evidence first dropped by age. `isTest`
 * keeps those the project runner still treats as test files. */
export function learnedTests(
  root: string,
  paths: string[],
  now = Date.now(),
  isTest: TestFilter = () => true,
): string[] {
  const store = read(root);
  const tests = new Set<string>();
  for (const path of keyPaths(paths))
    for (const [test, at] of Object.entries(store.learned[path] ?? {}))
      if (now - at <= MAX_AGE_MS && isTest(test)) tests.add(test);
  return [...tests].sort();
}

/** Tests that failed in a landing check under any changed path within `windowMs`. A sibling file of
 * the same module family fails the same guards, so the next change near it ranks these first (the
 * selector keeps only those that consume the change, and the time budget still trims them). */
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
export function recentFailedTests(root: string, now = Date.now(), windowMs = RECENT_MS): string[] {
  const tests = new Set<string>();
  for (const failures of Object.values(read(root).learned))
    for (const [test, at] of Object.entries(failures)) if (now - at <= windowMs) tests.add(test);
  return [...tests].sort();
}

/** Remembers the changed paths of the landing a Lane is submitting (finish gates already read
 * them), so a later check failure for that Lane, seen by land or wait, can be learned. */
export function rememberLandingPaths(root: string, laneId: string, paths: string[], now = Date.now()) {
  if (!paths.length) return;
  const store = read(root);
  store.lanes[laneId] = { paths: [...new Set(paths)].sort(), at: now };
  write(root, store, now);
}

type LandingResult = {
  submission?: {
    error?: { code?: string } | null;
    timing?: { checkReservedAt?: string; ciObservedAt?: string; ciEndedAt?: string };
    testFiles?: { failed?: { file: string }[] };
  };
};
/** A terminal CHECK_FAILED that names failing test files teaches preflight those files for the
 * Lane's changed paths, and any ended check teaches it how long this project's hosted check runs
 * (src/preflight-hosted-timing.ts). Reads only the response the client already holds; the Lane is
 * the one the command ran for (its checkout or explicit laneId). */
export function learnFromLanding(root: string, result: unknown, laneId?: unknown) {
  try {
    const submission = (result as LandingResult | undefined)?.submission;
    rememberHostedCheck(root, submission?.timing);
    if (submission?.error?.code !== 'CHECK_FAILED') return;
    const failed = (submission.testFiles?.failed ?? []).map(item => item.file);
    if (!failed.length) return;
    const lane =
      typeof laneId === 'string' && laneId ? laneId : readHostedLaneCheckout(root)?.selection.laneId;
    if (!lane) return;
    const lanes = read(root).lanes;
    // An explicit laneId may be the short prefix the CLI accepts.
    const paths = (lanes[lane] ?? Object.entries(lanes).find(([id]) => id.startsWith(lane))?.[1])?.paths;
    if (paths) learnFailures(root, paths, failed);
  } catch {
    /* Never let learning change a landing outcome. */
  }
}
