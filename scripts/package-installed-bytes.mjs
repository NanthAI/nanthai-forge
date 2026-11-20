// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clientCacheRoot } from '../src/root-paths.ts';
import { packageNpmKey } from './package-npm.mjs';
import { controlBuildKey } from './control-build-key.mjs';
import { packageDocuments, packageDocumentData, packageDocumentFragments } from './package-documents.mjs';

const receipt = root => join(clientCacheRoot(root), 'agent', 'package-installed-bytes.json');

// Byte evidence belongs to the exact package inputs and local platform. dist is derived, and
// package-lock pins the generated notice and installed dependency closure.
export function packageKey(root, manifest, npmContext) {
  const hash = createHash('sha256').update(
    JSON.stringify([
      process.version,
      process.platform,
      process.arch,
      controlBuildKey(root),
      packageNpmKey(root, npmContext),
    ]),
  );
  function read(path) {
    const target = join(root, path);
    if (statSync(target).isDirectory()) {
      for (const name of readdirSync(target).sort()) read(`${path}/${name}`);
    } else {
      const bytes = readFileSync(target);
      hash.update(`${path}\0${bytes.length}\0`).update(bytes);
    }
  }
  for (const path of [
    ...manifest.files.filter(path => path !== 'dist'),
    'scripts/agent-weight.mjs',
    'scripts/package-npm.mjs',
    'scripts/package-local.mjs',
    'scripts/package-notices.mjs',
    'scripts/package-smoke.mjs',
  ].sort())
    read(path);
  return hash.digest('hex');
}

export function cacheInstalledBytes(root, manifest, installedBytes, expectedKey, npmContext) {
  const path = receipt(root);
  const temporary = `${path}.${randomUUID()}`;
  try {
    const key = packageKey(root, manifest, npmContext);
    if (expectedKey !== undefined && key !== expectedKey) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify({ key, installedBytes }), {
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch {
    // A cache write cannot change the package verdict.
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function packageInstalledBytes(root, manifest, npmContext) {
  try {
    const cached = JSON.parse(readFileSync(receipt(root), 'utf8'));
    if (
      Number.isSafeInteger(cached.installedBytes) &&
      cached.installedBytes >= 0 &&
      cached.key === packageKey(root, manifest, npmContext)
    )
      return { bytes: cached.installedBytes, exact: true };
  } catch {
    // A cold, changed or unreadable installation cannot supply exact evidence.
  }

  // Every one of these files is required, byte-for-byte, by package smoke. Count only guaranteed
  // contents on a cold cache, so a refusal never depends on estimating compiled or dependency bytes.
  const files = new Set([
    'package-lock.json',
    ...manifest.files.filter(path => path.startsWith('scripts/')),
    ...(manifest.files.includes('docs')
      ? [...packageDocuments, ...packageDocumentData, ...packageDocumentFragments(root)]
      : []),
  ]);
  let bytes = 0;
  for (const path of files) {
    try {
      const entry = statSync(join(root, path));
      if (entry.isFile()) bytes += entry.size;
    } catch {
      // Package smoke still reports missing inputs separately.
    }
  }
  return { bytes, exact: false };
}
