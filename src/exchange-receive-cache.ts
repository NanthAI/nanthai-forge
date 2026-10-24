// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { nativeManifestSchema } from './work-archive-metadata.js';
import { exchangeRootSchema, isExchangeRoot } from './native-exchange-tree.js';
import { commitExchangeDirectory } from './native-exchange-files.js';

/** Disposable retained bytes are trusted only after checking hosted digest pins. */
export function retainedExchangeBase(ownerDirectory: string, manifestSha256: string) {
  for (const entry of readdirSync(ownerDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('exchange-')) continue;
    try {
      const directory = join(ownerDirectory, entry.name),
        manifestBytes = readFileSync(join(directory, 'manifest.json'));
      if (digest(manifestBytes) !== manifestSha256) continue;
      const manifest = nativeManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8'))),
        pin = manifest.files.find(file => file.path === 'work.json');
      if (!pin) continue;
      const work = readFileSync(join(directory, 'work.json'));
      if (work.length === pin.size && digest(work) === pin.sha256)
        return { manifestBytes, manifest, work, pin };
    } catch {
      /* Missing/corrupt disposable caches are not proof of a common base. */
    }
  }
  return undefined;
}

// Authority is checked by the caller's fresh checkpoint read before each lookup.
export function cachedExchangeMetadata(directory: string, rootBytes: Buffer) {
  const path = join(directory, `exchange-cache-${digest(rootBytes)}`);
  try {
    const raw = JSON.parse(rootBytes.toString('utf8'));
    // Includes receive directories made by older CLIs, before this cache existed.
    const retained = !existsSync(path)
      ? retainedExchangeBase(
          directory,
          isExchangeRoot(raw) ? exchangeRootSchema.parse(raw).manifest.sha256 : digest(rootBytes),
        )
      : undefined;
    const manifest = retained?.manifestBytes ?? readFileSync(join(path, 'manifest.json')),
      work = retained?.work ?? readFileSync(join(path, 'work.json'));
    if (isExchangeRoot(raw)) {
      const root = exchangeRootSchema.parse(raw);
      if (
        digest(manifest) !== root.manifest.sha256 ||
        manifest.length !== root.manifest.size ||
        digest(work) !== root.work.sha256 ||
        work.length !== root.work.size
      )
        return undefined;
    } else if (!manifest.equals(rootBytes)) return undefined;
    const parsed = nativeManifestSchema.parse(JSON.parse(manifest.toString('utf8'))),
      pin = parsed.files.find(file => file.path === 'work.json');
    if (!pin || pin.sha256 !== digest(work) || pin.size !== work.length) return undefined;
    return { manifest, work };
  } catch {
    return undefined;
  }
}
export function retainExchangeMetadata(directory: string, rootBytes: Buffer, manifest: Buffer, work: Buffer) {
  const path = join(directory, `exchange-cache-${digest(rootBytes)}`);
  // A damaged disposable entry is ignored; never replace ambiguous retained bytes.
  if (!existsSync(path)) commitExchangeDirectory(path, { 'manifest.json': manifest, 'work.json': work });
}
