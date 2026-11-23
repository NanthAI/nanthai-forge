// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { captureExclusion, localCredentialName, safeRelative } from './files.js';
import { invariant } from './errors.js';
import { forgeIncludes, ignoredBy, ignoreNames, readIgnoreLayer, type IgnoreMatch } from './source-ignore.js';
import type { TreeRecorder } from './checkout-stat-index.js';
import { credentialNameHold } from './capture-credential-check.js';
import { forgeCachePath } from './forge-cache-paths.js';
import { gitlinkDirectory } from './gitlink-workspace.js';
import { inDependencyDirectory } from './dependency-dirs.js';

export type NativeExcludedPath = {
  path: string;
  reason: string;
  ignore?: IgnoreMatch;
  /** A built-in exclusion that the ignore rules also match. */
  ignoredToo?: boolean;
};
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
  /** Record this whole-checkout walk for later checks (checkout-tree.json, checkout-stat-index). */
  tree?: TreeRecorder | undefined;
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
    tree,
  } = options;
  const paths: string[] = [];
  const retainedFiles = new Set(retained),
    retainedDirectories = new Set<string>();
  for (const file of retainedFiles)
    for (let index = file.indexOf('/'); index !== -1; index = file.indexOf('/', index + 1))
      retainedDirectories.add(file.slice(0, index));
  function excludeIgnored(patterns: ReturnType<typeof readIgnoreLayer>, path: string, directory: boolean) {
    const match = ignoredBy(patterns, path, directory);
    // Explicit Forge exclusions also apply to retained paths; Git exclusions preserve them.
    if (
      !match ||
      !(
        (match.source === '.forgeignore' && !preserveRetained) ||
        (!retainedFiles.has(path) && !retainedDirectories.has(path))
      )
    )
      return false;
    const item: NativeExcludedPath = {
      path,
      reason: match.source === '.forgeignore' ? 'forgeignored' : 'gitignored',
    };
    excluded?.push(item);
    onExcluded?.({ ...item, ignore: match });
    return true;
  }
  function walk(dir: string, patterns: ReturnType<typeof readIgnoreLayer>) {
    visitDirectory?.(dir);
    tree?.directory(dir);
    const names = readdirSync(join(root, dir)).sort();
    for (const name of ignoreNames) if (names.includes(name)) tree?.input(dir ? `${dir}/${name}` : name);
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
        // Excluded entries never become source; their names must not prevent capturing valid files.
        if (excludeIgnored(next, path, lstatSync(join(root, path)).isDirectory())) continue;
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
      // A submodule checked out at a saved path is one opaque leaf (its pointer is its HEAD);
      // its files are never walked, captured or reported as added source.
      if (selected && stat.isDirectory() && !stat.isSymbolicLink() && gitlinkDirectory(root, path)) {
        tree?.directory(path);
        if (capture) paths.push(path);
        continue;
      }
      if (scope?.some(item => item.startsWith(path + '/')))
        invariant(stat.isDirectory(), 'UNSAFE_PATH', 'Scoped source parent is not a real directory.');
      // Only metadata, dependency installs and real credential names are excluded by name, in
      // every language; build folders follow ignore rules (cmd/build/main.go is source).
      let reason = captureExclusion(path, stat.isDirectory());
      if (reason && !selected && !descendant) {
        // Say whether ignore rules would drop it anyway; only the rest is worth a save notice.
        const ignoredToo = !!ignoredBy(next, path, stat.isDirectory());
        // A new file's credential-looking name is only a prompt: its bytes decide, unless an
        // exact `.forgeignore` negation includes it on purpose. Local credential files
        // (`.env`, `.netrc`) are never re-included. Ignored files are never read.
        if (reason === 'sensitive-name' && stat.isFile() && !ignoredToo && !localCredentialName(name)) {
          tree?.input(path, stat);
          reason = forgeIncludes(next, path) ? null : credentialNameHold(root, path, stat.size);
        }
        if (reason) {
          excluded?.push({ path, reason });
          onExcluded?.({ path, reason, ignoredToo });
          continue;
        }
      }
      if (excludeIgnored(next, path, stat.isDirectory())) continue;
      // Package managers hard-link installed files from a shared store. Below a dependency folder
      // that no ignore rule names, an untracked hard-linked file is an install: leave it out and
      // say so, instead of refusing the whole save. Tracked paths and other folders still fail.
      if (stat.isFile() && stat.nlink > 1 && !selected && inDependencyDirectory(path)) {
        tree?.input(path, stat);
        const item = { path, reason: 'dependency-install' };
        excluded?.push(item);
        onExcluded?.(item);
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
  paths.sort();
  if (tree && capture && !scope && !preserveRetained) tree.write(paths, retainedFiles);
  return paths;
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
