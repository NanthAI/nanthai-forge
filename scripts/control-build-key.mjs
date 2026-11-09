// SPDX-License-Identifier: Apache-2.0
// Cache key for the trusted control build (`npm run build:core` output in dist/): a content hash of
// exactly the files that build reads, so unrelated commits reuse one cached build. Any CI can call
// it: `node scripts/control-build-key.mjs [ROOT]` prints one hex digest. Plain Node, no dependencies.
import { isMainModule } from './main-module.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';

// package.json "build:core": prepare-convex-api.mjs (writes only convex/_generated, outside dist),
// tsc over tsconfig.json "include" (src/**/*.ts plus the scripts/*.d.mts typings src imports), then
// build-edit-hook.mjs (vite bundle of src/agent-edit-hook.ts). The lockfile pins the compilers.
// The vite bundle also inlines every module reachable from its entry, including scripts/*.mjs.
export const controlBuildInputs = {
  files: [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'scripts/prepare-convex-api.mjs',
    'scripts/build-edit-hook.mjs',
    'scripts/control-build-key.mjs',
  ],
  directories: [
    { path: 'src', match: /\.(?:ts|mts|cts|json)$/ },
    { path: 'scripts', match: /\.d\.mts$/, depth: 1 },
  ],
  bundleEntry: 'src/agent-edit-hook.ts',
};

/** Files the bundle inlines: the entry plus its relative imports, followed transitively. */
export function bundled(root, entry) {
  const seen = new Set();
  const visit = path => {
    if (seen.has(path)) return;
    let text;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    seen.add(path);
    for (const [, specifier] of text.matchAll(
      /(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g,
    )) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      visit(target.endsWith('.js') && path.endsWith('.ts') ? target.replace(/\.js$/, '.ts') : target);
    }
  };
  visit(entry);
  return [...seen];
}

function listed(root, { path, match, depth = Infinity }, level = 0) {
  let entries;
  try {
    entries = readdirSync(join(root, path), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap(entry => {
    const child = posix.join(path, entry.name);
    if (entry.isDirectory())
      return level + 1 < depth ? listed(root, { path: child, match, depth }, level + 1) : [];
    return entry.isFile() && match.test(entry.name) ? [child] : [];
  });
}

export function controlBuildKey(root = '.', inputs = controlBuildInputs) {
  const base = resolve(root);
  const paths = [
    ...inputs.files,
    ...inputs.directories.flatMap(directory => listed(base, directory)),
    ...(inputs.bundleEntry ? bundled(base, inputs.bundleEntry) : []),
  ];
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    let bytes;
    try {
      bytes = readFileSync(join(base, path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update(`${path}\0missing\0`);
      continue;
    }
    // Length-prefixed records keep file boundaries unambiguous.
    hash.update(`${path}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

if (isMainModule(import.meta.url)) console.log(controlBuildKey(process.argv[2] ?? '.'));
