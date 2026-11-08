// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { buildPackageGraph } from './package-graph.js';
import { packageTestSelection } from './package-test-selection.js';

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

/** The package-graph selection for `changed` in a checked-out Candidate: manifests read from disk,
 * no repository code run, no Forge call. */
export function checkoutPackageSelection(directory: string, changed: string[]) {
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
  return packageTestSelection(graph, changed);
}

/** For a scoped configured command (docs/workflows.md#check-command-scope): writes the affected
 * packages and their per-ecosystem commands to a file outside the checkout, for `FORGE_CHECK_PACKAGES`.
 * Nothing for a full run or a changes file without paths. `remove()` deletes the file. */
export function writeCheckPackages(
  directory: string,
  changes: { mode?: unknown; paths?: unknown } | undefined,
): { path: string; remove: () => void } | null {
  if (changes?.mode !== 'scoped' || !Array.isArray(changes.paths)) return null;
  const changed = changes.paths.filter((path): path is string => typeof path === 'string');
  const selection = checkoutPackageSelection(directory, changed);
  const folder = mkdtempSync(join(tmpdir(), 'forge-packages-'));
  const path = join(folder, 'packages.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      scope: selection.scope,
      reason: selection.reason,
      packages: selection.packages,
      commands: selection.commands.map(({ ecosystem, cwd, argv }) => ({ ecosystem, cwd, argv })),
    }),
    { mode: 0o600, flag: 'wx' },
  );
  return { path, remove: () => rmSync(folder, { recursive: true, force: true }) };
}
