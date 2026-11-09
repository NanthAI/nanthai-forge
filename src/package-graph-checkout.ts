// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { buildPackageGraph, type PackageGraph } from './package-graph.js';
import { buildModuleGraph } from './module-graph.js';
import { packageTestSelection } from './package-test-selection.js';
import { packageIntersectionTestSelection } from './package-intersection.js';
import { checkoutPackageFlags } from './package-command-flags-checkout.js';
import type { PackageFlagSource } from './package-command-flags.js';

/** Paths walked at most: past this the graph is unknown (full), never a partial view. */
const MAX_PATHS = 500_000;

/** Every file path of a checkout, without hidden folders or installed packages, or null past the cap. */
function checkoutPaths(directory: string) {
  const paths: string[] = [];
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(join(directory, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = dir ? posix.join(dir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!walk(path)) return false;
      } else if (entry.isFile() && paths.push(path) > MAX_PATHS) return false;
    }
    return true;
  };
  return walk('') ? paths : null;
}

/** The package-graph selection for `changed` in a checked-out Candidate: manifests and (for the
 * module graph, src/module-graph.ts) Python, Go, Rust, Java and Kotlin sources read from disk, no
 * repository code run, no Forge call. */
export function checkoutPackageSelection(
  directory: string,
  changed: string[],
  flags?: PackageFlagSource | { refusal: string },
) {
  const paths = checkoutPaths(directory);
  const read = (path: string) => {
    try {
      return readFileSync(join(directory, path), 'utf8');
    } catch {
      return undefined;
    }
  };
  if (!paths)
    return packageTestSelection({ status: 'unknown', reason: `more than ${MAX_PATHS} files` }, changed);
  const graph = buildPackageGraph(paths, read);
  return packageTestSelection(graph, changed, () => buildModuleGraph({ paths, read }), flags);
}

/** The manifest package graph of a checked-out directory (no repository code runs). */
export function checkoutPackageGraph(directory: string): PackageGraph {
  const paths = checkoutPaths(directory);
  if (!paths) return { status: 'unknown', reason: `more than ${MAX_PATHS} files` };
  return buildPackageGraph(paths, path => {
    try {
      return readFileSync(join(directory, path), 'utf8');
    } catch {
      return undefined;
    }
  });
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** For a scoped configured command (docs/workflows.md#check-command-scope): writes the affected
 * packages and their per-ecosystem commands to a file outside the checkout, for `FORGE_CHECK_PACKAGES`.
 * Nothing for a full run or a changes file without paths. `remove()` deletes the file.
 * With `runner` (Node and scripts/check-packages-run.mjs) and a runnable scoped selection it also
 * writes `run`, an executable for `FORGE_CHECK_PACKAGES_RUN` that runs those commands in the
 * checkout, so a repository's own CI script opts in with one line. */
export function writeCheckPackages(
  directory: string,
  changes: { mode?: unknown; paths?: unknown; mainPaths?: unknown; members?: unknown } | undefined,
  runner?: { node: string; script: string },
  check?: { executable: string; args: readonly string[] },
): { path: string; run: string | null; remove: () => void } | null {
  if (changes?.mode !== 'scoped' || !Array.isArray(changes.paths)) return null;
  const strings = (list: unknown[]) => list.filter((path): path is string => typeof path === 'string');
  const changed = strings(changes.paths);
  // A scoped main-race recheck names main's delta: the packages that can see both changes. A cohort
  // recheck names each member's sides (Issue 28f08555): the union of their intersections.
  // The project's own test flags come from forge.json or the declared check's text.
  const flags = checkoutPackageFlags(directory, check);
  const members = Array.isArray(changes.members)
    ? changes.members.map(member => {
        const { paths, mainPaths } = (member ?? {}) as { paths?: unknown; mainPaths?: unknown };
        return {
          lanePaths: Array.isArray(paths) ? strings(paths) : [],
          mainPaths: Array.isArray(mainPaths) ? strings(mainPaths) : [],
        };
      })
    : undefined;
  const selection = members
    ? checkoutPackageIntersection(directory, changed, [], flags, members)
    : Array.isArray(changes.mainPaths)
      ? checkoutPackageIntersection(directory, changed, strings(changes.mainPaths), flags)
      : checkoutPackageSelection(directory, changed, flags);
  const folder = mkdtempSync(join(tmpdir(), 'forge-packages-'));
  const path = join(folder, 'packages.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      scope: selection.scope,
      reason: selection.reason,
      packages: selection.packages,
      commands: selection.commands.map(({ ecosystem, cwd, argv, flagsFrom }) => ({
        ecosystem,
        cwd,
        argv,
        ...(flagsFrom ? { flagsFrom } : {}),
      })),
    }),
    { mode: 0o600, flag: 'wx' },
  );
  let run: string | null = null;
  if (runner && selection.scope === 'scoped' && selection.commands.length) {
    run = join(folder, 'run');
    writeFileSync(
      run,
      `#!/bin/sh\nexec ${[runner.node, runner.script, path, directory].map(shellQuote).join(' ')}\n`,
      { mode: 0o700, flag: 'wx' },
    );
  }
  return { path, run, remove: () => rmSync(folder, { recursive: true, force: true }) };
}

/** A scoped main-race recheck's package selection (src/package-intersection.ts) in a checkout. */
export function checkoutPackageIntersection(
  directory: string,
  changed: string[],
  mainPaths: string[],
  flags?: PackageFlagSource | { refusal: string },
  members?: { lanePaths: string[]; mainPaths: string[] }[],
) {
  const paths = checkoutPaths(directory);
  const graph = paths
    ? buildPackageGraph(paths, path => {
        try {
          return readFileSync(join(directory, path), 'utf8');
        } catch {
          return undefined;
        }
      })
    : ({ status: 'unknown', reason: `more than ${MAX_PATHS} files` } as const);
  return packageIntersectionTestSelection(graph, changed, mainPaths, flags, members);
}
