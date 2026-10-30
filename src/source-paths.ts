// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { exclusion, sourceExclusion, safeRelative } from './files.js';
import { invariant } from './errors.js';
import { ignoredBy, readIgnoreLayer, type IgnoreMatch } from './source-ignore.js';
import { forgeCachePath } from './forge-cache-paths.js';

export type NativeExcludedPath = { path: string; reason: string; ignore?: IgnoreMatch };
type SourcePathOptions = {
  retained?: string[] | undefined;
  excluded?: { path: string; reason: string }[] | undefined;
  scope?: string[] | undefined;
  visitDirectory?: ((path: string) => void) | undefined;
  onExcluded?: ((item: NativeExcludedPath) => void) | undefined;
  /** Inventory only: do not accumulate or validate included source files. */
  capture?: boolean;
  /** Analysis can inventory files that its byte reader later rejects. */
  validate?: boolean;
  /** Exact imported history is validated without rewriting its retained paths. */
  preserveRetained?: boolean;
};
/** One local ignore walk for capture, first-write advice and status inventory. */
export function scanSourcePaths(root: string, options: SourcePathOptions = {}): string[] {
  const {
    retained = [],
    excluded,
    scope,
    visitDirectory,
    onExcluded,
    capture = true,
    preserveRetained = false,
    validate = capture,
  } = options;
  const paths: string[] = [];
  const retainedFiles = new Set(retained),
    retainedDirectories = new Set<string>();
  for (const file of retainedFiles)
    for (let index = file.indexOf('/'); index !== -1; index = file.indexOf('/', index + 1))
      retainedDirectories.add(file.slice(0, index));
  function walk(dir: string, patterns: ReturnType<typeof readIgnoreLayer>) {
    visitDirectory?.(dir);
    const names = readdirSync(join(root, dir)).sort();
    const layer = readIgnoreLayer(root, dir, names);
    const next = layer.length ? [...patterns, ...layer] : patterns;
    for (const name of names) {
      const path = dir ? `${dir}/${name}` : name;
      if (
        scope &&
        !scope.some(item => item === path || item.startsWith(path + '/') || path.startsWith(item + '/'))
      )
        continue;
      if (!safeRelative(path)) {
        invariant(!validate, 'UNSAFE_PATH', 'Native source paths must be portable relative paths.');
        continue;
      }
      // Tracked-path and ignore-rule overrides must never re-include client
      // metadata. Exact historical imports remain byte-for-byte unchanged.
      if (!preserveRetained && forgeCachePath(path)) {
        const item = { path, reason: 'forge-metadata' };
        excluded?.push(item);
        onExcluded?.(item);
        continue;
      }
      const selected = retainedFiles.has(path),
        descendant = retainedDirectories.has(path);
      const stat = lstatSync(join(root, path));
      if (scope?.some(item => item.startsWith(path + '/')))
        invariant(stat.isDirectory(), 'UNSAFE_PATH', 'Scoped source parent is not a real directory.');
      // Analysis name heuristics must not drop source modules such as secrets.ts.
      // Real credential/config names and explicit ignore rules stay excluded.
      const reason = stat.isDirectory() ? exclusion(path) : sourceExclusion(path);
      if (reason && !selected && !descendant) {
        excluded?.push({ path, reason });
        onExcluded?.({ path, reason });
        continue;
      }
      const match = ignoredBy(next, path, stat.isDirectory());
      // Preserve imported/tracked Git paths, while explicit Forge exclusions
      // apply to subsequent captures too. Historical States stay immutable.
      if (match && ((match.source === '.forgeignore' && !preserveRetained) || (!selected && !descendant))) {
        const item: NativeExcludedPath = {
          path,
          reason: match.source === '.forgeignore' ? 'forgeignored' : 'gitignored',
        };
        excluded?.push(item);
        onExcluded?.({ ...item, ignore: match });
        continue;
      }
      if (validate)
        invariant(
          stat.isDirectory() || stat.isSymbolicLink() || (stat.isFile() && stat.nlink === 1),
          'UNSUPPORTED_NATIVE_FILE',
          `Native source cannot capture this special or linked path: ${path}. Original files are preserved.`,
        );
      if (stat.isDirectory()) walk(path, next);
      else if (capture) paths.push(path);
    }
  }
  walk('', []);
  return paths.sort();
}

export function nativePaths(
  root: string,
  retained: string[] = [],
  excluded?: { path: string; reason: string }[],
  scope?: string[],
  visitDirectory?: (path: string) => void,
): string[] {
  return scanSourcePaths(root, { retained, excluded, scope, visitDirectory });
}
