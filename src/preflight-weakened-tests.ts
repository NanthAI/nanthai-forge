// SPDX-License-Identifier: Apache-2.0
// Preflight and land side of the weakened-test detector (Issue 11901a0c). Local and static: the base
// State and blobs come from this machine's object stores, the head bytes from the Lane folder; no
// server call, no test run. A flag never fails the Lane; a reason line in the landing message clears it.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeFile } from './state/format.js';
import { scanWeakenedTests, type TestFileChange, type WeakenedFlag } from './weakened-tests.js';

/** `Weakened-tests: <why>` on its own line of the landing message clears the flags. */
const REASON = /^[ \t]*weakened-tests:[ \t]*(\S[^\r\n]{3,}?)[ \t\r]*$/im;
const SHOWN = 20;
/** Larger files are generated or data; parsing them would cost more than it can tell. */
const MAX_BYTES = 1 << 20;
/** Lane bound (a codemod over hundreds of tests): files and bytes read, and time from the start.
 * Past it the rest is counted as not checked, never flagged; the check stays under about 2 s. */
const MAX_FILES = 200;
const MAX_LANE_BYTES = 8 << 20;
const BUDGET_MS = 1500;
/** Object-store reader, digest and State parser, passed in by the caller (`localObjects`, `digest`,
 * `parseNativeState`): a shared module imported here would split the CLI bundle's eager chunks
 * and add a chunk to every agent command (tests/perf-harness.test.mjs, 7b2ae8d8). */
type LocalReads = {
  objects: (root: string, maxBytes?: number) => (id: string) => Buffer | null;
  digest: (bytes: string | Uint8Array) => string;
  files: (state: Buffer) => readonly NativeFile[];
};
const CLEAR =
  'Not a failure. If each change is right, add one line "Weakened-tests: <why>" to the land --save message.';

/** JS/TS sources under a test folder or named *.test / *.spec, fixtures excluded. */
const isTestSource = (path: string) =>
  /\.[cm]?[jt]sx?$/.test(path) &&
  !/(?:^|\/)(?:fixtures?|__fixtures__|node_modules)\//.test(path) &&
  (/(?:^|\/)(?:tests?|__tests__|spec|e2e)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path));

export function weakenedTestsReason(message: string | undefined) {
  return message?.match(REASON)?.[1] ?? null;
}

/** Flags for the saved head's changed test files against its base State, and how many changed test
 * files were past the Lane bound, or null when the base is not on this machine (nothing is known, so
 * nothing is claimed). Only a change to an existing test file is judged; files added alongside it
 * are read so a test moved into them is not "removed". */
export function laneWeakenedTests(
  { objects: localObjects, digest, files: stateFiles }: LocalReads,
  root: string,
  base: string,
  head: readonly NativeFile[],
  text: (path: string) => string | undefined,
): { flags: WeakenedFlag[]; unchecked: number } | null {
  const started = performance.now();
  const state = localObjects(root)(base);
  if (!state) return null;
  const object = localObjects(root, MAX_BYTES);
  const tests = (files: readonly NativeFile[]) =>
    new Map(
      files.filter(file => file.mode === 'file' && isTestSource(file.path)).map(file => [file.path, file]),
    );
  const before = tests(stateFiles(state));
  const after = tests(head);
  // Changed existing files first (they are judged), then added or deleted ones (moves).
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter(path => before.get(path)?.blob !== after.get(path)?.blob)
    .sort((a, b) => Number(before.has(b) && after.has(b)) - Number(before.has(a) && after.has(a)));
  if (!changed.some(path => before.has(path))) return { flags: [], unchecked: 0 };
  let budget = MAX_LANE_BYTES;
  const bytes = (file: NativeFile | undefined, saved: boolean) => {
    if (!file) return null;
    const local = saved ? text(file.path) : undefined;
    const found =
      local !== undefined && digest(local) === file.blob ? local : object(file.blob)?.toString('utf8');
    if (found !== undefined) budget -= found.length;
    return found;
  };
  const changes: TestFileChange[] = [];
  let unchecked = 0;
  for (const [index, path] of changed.entries()) {
    const existing = before.has(path) && after.has(path);
    if (index >= MAX_FILES || budget <= 0 || performance.now() - started > BUDGET_MS) {
      if (existing) unchecked++;
      continue;
    }
    const left = bytes(before.get(path), false);
    const right = bytes(after.get(path), true);
    // Bytes this machine does not hold (or too large to judge) cost precision, never a false flag.
    if (left !== undefined && right !== undefined) changes.push({ path, before: left, after: right });
  }
  const scan = scanWeakenedTests(changes, started + BUDGET_MS);
  return { flags: scan.flags, unchecked: unchecked + scan.unchecked };
}

/** The reply field for preflight and land: flags by file and test (no values), how to clear them,
 * and how many changed test files were past the Lane bound (a count, no names). */
export function weakenedTestsReply(flags: readonly WeakenedFlag[] | null, message?: string, unchecked = 0) {
  const notChecked = unchecked ? { notChecked: `not checked: ${unchecked} files` } : {};
  if (!flags?.length) return unchecked ? { count: 0, ...notChecked } : undefined;
  const reason = weakenedTestsReason(message);
  return {
    count: flags.length,
    flags: flags.slice(0, SHOWN),
    ...(flags.length > SHOWN ? { more: flags.length - SHOWN } : {}),
    ...notChecked,
    ...(reason ? { cleared: reason } : { clear: CLEAR }),
  };
}

/** The reply field for a Lane checkout's saved head (`files`) against its base; undefined when
 * nothing is flagged or the comparison cannot be made here. Never throws: it only advises. */
export function laneWeakenedTestsReply(
  reads: LocalReads,
  root: string,
  base: string,
  files: readonly NativeFile[],
  message?: string,
) {
  try {
    const text = (path: string) => {
      // State paths are validated relative paths; never read outside the Lane folder.
      if (path.startsWith('/') || path.split('/').includes('..')) return undefined;
      try {
        // Size first: a huge file is neither read here nor from the object store.
        if (statSync(join(root, path)).size > MAX_BYTES) return undefined;
        return readFileSync(join(root, path), 'utf8');
      } catch {
        return undefined;
      }
    };
    const scan = laneWeakenedTests(reads, root, base, files, text);
    return scan ? weakenedTestsReply(scan.flags, message, scan.unchecked) : undefined;
  } catch {
    return undefined;
  }
}
