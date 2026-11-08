// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import type { NativeFile } from './native-state-format.js';
import { captureExclusion, readSource } from './files.js';
import { preserveLegacyCacheUse } from './client-cache-use.js';
import { ignoredBy, ignoreLayer } from './source-ignore.js';
import { indexedBlob, statIndexRefresh, type CheckoutStatIndex } from './checkout-stat-index.js';

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
  const refresh = options.index ? statIndexRefresh(root) : null;
  const sourceRoot = realpathSync(root);
  const allowed = new Map(files.map(file => [file.path, file]));
  const target = new Map(options.target?.map(file => [file.path, file]) ?? []);
  const directories = new Set<string>();
  for (const file of [...files, ...(options.target ?? [])])
    for (let i = file.path.indexOf('/'); i !== -1; i = file.path.indexOf('/', i + 1))
      directories.add(file.path.slice(0, i));
  const preserved: string[] = [];
  function visit(directory: string, layers: ReturnType<typeof ignoreLayer>, parentIgnored = false) {
    const names = readdirSync(join(root, directory));
    const local = ignoreLayer(directory, name =>
      names.includes(name)
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
        for (const name of readdirSync(join(root, path)))
          if (!(name === markerName || (name === 'cache-use.json' && preserveLegacyCacheUse(root)))) {
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
      if (!saved && options.deferExtras && !directories.has(path)) continue;
      if (!saved && stat.isDirectory()) {
        visit(path, next, ignored);
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
        observedDigest === file.blob &&
        (stat.isSymbolicLink()
          ? file.mode === 'symlink'
          : file.mode !== 'symlink' && Boolean(stat.mode & 0o111) === (file.mode === 'executable')),
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
                  ? stat.mode & 0o111
                    ? 'executable'
                    : 'file'
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
