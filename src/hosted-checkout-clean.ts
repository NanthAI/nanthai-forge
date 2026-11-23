// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import {
  EVENT_PROBE_PREFIX,
  hostedLaneMarkerName,
  laneScratchName,
  laneScratchPath,
} from './forge-cache-paths.js';
import { ForgeError, invariant } from './errors.js';
import type { NativeFile } from './state/format.js';
import { captureExclusion, readSource } from './files.js';
import { preserveLegacyCacheUse } from './client-cache-use.js';
import { ignoredBy, ignoreLayer } from './source-ignore.js';
import { indexedBlob, statIndexRefresh, type CheckoutStatIndex } from './checkout-stat-index.js';
import { diskShapeMatches, diskMode } from './source-links.js';
import { fold } from './hosted-checkout-delta.js';
import { workingMatches, worktreeText } from './checkout-text.js';
import { checkoutPathExists } from './hosted-checkout-files.js';

export type CheckoutChange = { path: string; kind: 'edited' | 'extra' | 'deleted' };

/** Validate saved source even when ignored. Return only disjoint local artifacts
 * to carry across publication; never follow links or read ignored output bytes.
 * The early guard defers extras until the target manifest is available. */
export function cleanHostedCheckout(
  root: string,
  files: NativeFile[],
  markerName: string,
  marked: boolean,
  options: {
    target?: NativeFile[];
    deferExtras?: boolean;
    index?: CheckoutStatIndex;
    /** List every difference from the saved files instead of refusing at the first one. */
    collect?: CheckoutChange[];
    /** A clone refresh (Git parity): an untracked path that no saved or incoming path meets stays
     * where it is and is returned to carry across a directory swap, instead of refusing. */
    carryExtras?: boolean;
    /** In-place sync only: validate the delta's paths and Forge metadata before publishing.
     * The caller checks the complete installed tree after publication. */
    scope?: readonly string[] | undefined;
  } = {},
): string[] {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  invariant(
    rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    'UNSAFE_PATH',
    'Checkout directory must be real.',
  );
  // Started before the first lstat of saved files, so its `since` precedes every observation.
  const refresh = options.index && !options.scope ? statIndexRefresh(root) : null;
  const sourceRoot = realpathSync(root);
  // Files the checkout's `.gitattributes` convert hold their blob as CRLF (44ef42b9), not an edit.
  const text = worktreeText(root, files);
  const scoped = options.scope && new Set(options.scope);
  const allowed = new Map(
    files.filter(file => !scoped || scoped.has(file.path)).map(file => [file.path, file]),
  );
  const target = new Map(options.target?.map(file => [file.path, file]) ?? []);
  const directories = new Set<string>();
  for (const file of [...files, ...(options.target ?? [])])
    for (let i = file.path.indexOf('/'); i !== -1; i = file.path.indexOf('/', i + 1))
      directories.add(file.path.slice(0, i));
  // Spellings an untracked entry may meet on a case- or normalization-insensitive disk.
  const spelled = new Map<string, string[]>();
  if (options.carryExtras)
    for (const path of new Set([...allowed.keys(), ...target.keys(), ...directories])) {
      const key = fold(path);
      spelled.set(key, [...(spelled.get(key) ?? []), path]);
    }
  /** The same directory entry under another spelling than a saved or incoming path's. */
  const meetsSpelling = (path: string, stat: Stats) =>
    (spelled.get(fold(path)) ?? []).some(other => {
      if (other === path) return false;
      try {
        const there = lstatSync(join(root, other));
        return there.ino === stat.ino && there.dev === stat.dev;
      } catch {
        return false;
      }
    });
  const preserved: string[] = [];
  let exactMetadataName: boolean | undefined;
  const children = new Map<string, Set<string>>();
  for (const path of scoped ?? []) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const directory = parts.slice(0, i).join('/');
      const names = children.get(directory) ?? new Set<string>();
      names.add(parts[i]!);
      children.set(directory, names);
    }
  }
  const namesAt = (directory: string, complete: boolean) => {
    const absolute = join(root, directory);
    if (complete) return readdirSync(absolute);
    const wanted = children.get(directory);
    const names =
      wanted && [...wanted].some(name => checkoutPathExists(join(absolute, name)))
        ? // Exact spelling matters even where lookup accepts another spelling.
          readdirSync(absolute).filter(name => wanted.has(name))
        : [];
    if (!directory && !names.includes('.forge')) names.push('.forge');
    return names;
  };
  function visit(
    directory: string,
    layers: ReturnType<typeof ignoreLayer>,
    parentIgnored = false,
    complete = !scoped,
  ) {
    const names = namesAt(directory, complete);
    const local = ignoreLayer(directory, name =>
      !complete || names.includes(name)
        ? readSource(sourceRoot, join(directory, name), Number.MAX_SAFE_INTEGER)?.toString('utf8')
        : undefined,
    );
    const next = [...layers, ...local];
    for (const entry of names) {
      const path = directory ? `${directory}/${entry}` : entry;
      const stat = lstatSync(join(root, path));
      if (path === '.forge') {
        if (!(marked && stat.isDirectory() && !stat.isSymbolicLink())) {
          if (options.collect) {
            options.collect.push({ path, kind: 'extra' });
            continue;
          }
          throw new ForgeError(
            'WORK_CONFLICT',
            'Existing Forge metadata at ".forge" is preserved.',
            undefined,
            { obstruction: { kind: 'unknown-metadata', path: '.forge' } },
          );
        }
        const metadata = readdirSync(join(root, path));
        for (const name of metadata) {
          if (
            markerName === hostedLaneMarkerName &&
            (name === laneScratchName ||
              (name.toLowerCase() === laneScratchName &&
                !metadata.includes(laneScratchName) &&
                existsSync(join(root, laneScratchPath))))
          ) {
            preserved.push(laneScratchPath);
            continue;
          }
          if (
            !(
              name === markerName ||
              (name === 'cache-use.json' && preserveLegacyCacheUse(root)) ||
              // An older client's event probe killed mid-attempt: Forge-owned and empty of work (48835eea).
              name.startsWith(EVENT_PROBE_PREFIX)
            )
          ) {
            // An alias on a case-insensitive disk was an ignored entry in the full walk.
            if (scoped && !(exactMetadataName ??= readdirSync(root).includes('.forge'))) break;
            if (options.collect) {
              options.collect.push({ path: `${path}/${name}`, kind: 'extra' });
              continue;
            }
            throw new ForgeError(
              'WORK_CONFLICT',
              `Existing Forge metadata at ${JSON.stringify(`${path}/${name}`)} is preserved.`,
              undefined,
              { obstruction: { kind: 'unknown-metadata', path: `${path}/${name}` } },
            );
          }
        }
        continue;
      }
      const saved = allowed.get(path),
        incoming = target.get(path);
      const ignored =
        !saved &&
        (parentIgnored ||
          Boolean(captureExclusion(path, stat.isDirectory())) ||
          Boolean(ignoredBy(next, path, stat.isDirectory())));
      // Prefix intersections must be inspected too: an ignored dependency link
      // cannot become the parent of incoming source, nor hide saved source.
      const targetParent =
        !saved &&
        !incoming &&
        ignored &&
        path
          .split('/')
          .slice(0, -1)
          .some((_, i, parts) => target.has(parts.slice(0, i + 1).join('/')));
      if (!saved && !incoming && !directories.has(path) && !targetParent && ignored) {
        preserved.push(path);
        continue;
      }
      // Git leaves untracked files alone unless an incoming path would overwrite them. A name that
      // is a saved or incoming file, or the folder of one, still takes the checks below.
      if (
        options.carryExtras &&
        !saved &&
        !incoming &&
        !directories.has(path) &&
        !meetsSpelling(path, stat)
      ) {
        preserved.push(path);
        continue;
      }
      if (!saved && options.deferExtras && !directories.has(path)) continue;
      if (!saved && stat.isDirectory()) {
        visit(path, next, ignored, complete || Boolean(scoped?.has(path)));
        continue;
      }
      if (!saved && options.deferExtras) continue;
      const file = saved ?? incoming;
      // Like save and dirty checks: an exact lstat match with this baseline is not re-read.
      if (saved && options.index && indexedBlob(options.index, path, stat, saved.blob)) {
        refresh?.kept(path, stat, saved.blob);
        allowed.delete(path);
        continue;
      }
      const bytes = stat.isSymbolicLink()
        ? readlinkSync(join(root, path), { encoding: 'buffer' })
        : stat.isFile() && stat.nlink === 1
          ? readFileSync(join(root, path))
          : null;
      const observedDigest = bytes ? digest(bytes) : null;
      const matches = Boolean(
        file &&
        bytes &&
        (observedDigest === file.blob || workingMatches(text, path, bytes, file.blob, file.mode)) &&
        diskShapeMatches(stat, file.mode),
      );
      if (!matches && options.collect) {
        options.collect.push({ path, kind: saved ? 'edited' : 'extra' });
        allowed.delete(path);
        continue;
      }
      if (!matches)
        throw new ForgeError(
          'WORK_CONFLICT',
          `Local checkout changes at ${JSON.stringify(path)} are preserved.`,
          undefined,
          {
            obstruction: {
              path,
              kind: saved ? 'source-edit' : 'extra-source',
              expectedDigest: file?.blob ?? null,
              observedDigest,
              expectedMode: file?.mode ?? null,
              observedMode: stat.isSymbolicLink()
                ? 'symlink'
                : stat.isFile()
                  ? diskMode(stat, file?.mode)
                  : 'other',
            },
          },
        );
      if (saved) refresh?.read(path, stat, saved.blob);
      allowed.delete(path);
    }
  }
  visit('', []);
  if (options.collect) for (const path of allowed.keys()) options.collect.push({ path, kind: 'deleted' });
  else if (allowed.size)
    throw new ForgeError(
      'WORK_CONFLICT',
      `Local checkout deletion at ${JSON.stringify(allowed.keys().next().value)} is preserved.`,
      undefined,
      { obstruction: { kind: 'deletion', path: allowed.keys().next().value } },
    );
  // Clean: entries re-read only because they were racy are trusted from now on (Git's refresh).
  refresh?.commit();
  return preserved;
}
