// SPDX-License-Identifier: Apache-2.0
// Offline original notices are advisory; they never gate installation or start.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const backendLicenseSha256 = 'cee614f23a461cb4aba2910e7127ae0969bcf42a0a91a38d3e3449d843383086';
export const componentManifestSha256 = '1c0a5780aff4c7ef55f8d0d8c77c4122088578365a30cdae07be79ab59e8ac68';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function retainBackendNotice(
  directory,
  notice = new URL('../docs/vendor-notices/convex-backend-LICENSE.md', import.meta.url),
) {
  try {
    const bytes = await readFile(notice);
    if (hash(bytes) !== backendLicenseSha256) return false;
    await writeFile(join(directory, 'LICENSE-convex-backend.md'), bytes, { mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}
export async function retainNativeComponentNotices(
  directory,
  source = new URL('../docs/vendor-notices/native-components/', import.meta.url),
) {
  try {
    const manifest = await readFile(new URL('manifest.json', source));
    if (hash(manifest) !== componentManifestSha256) return false;
    const declared = JSON.parse(manifest);
    const scope = await readFile(new URL('PARTIAL.md', source));
    if (scope.length !== declared.disclosure.size || hash(scope) !== declared.disclosure.sha256) return false;
    const originals = await Promise.all(
      declared.originals.map(async item => {
        const bytes = await readFile(new URL(item.path, source));
        if (bytes.length !== item.size || hash(bytes) !== item.sha256)
          throw new Error('Original notice bytes differ.');
        return { path: item.path, bytes };
      }),
    );
    // Validate every original before creating the collection. Existing files are never overwritten.
    const target = join(directory, 'native-component-notices');
    await mkdir(target, { mode: 0o700 });
    for (const item of [
      { path: 'PARTIAL.md', bytes: scope },
      { path: 'manifest.json', bytes: manifest },
      ...originals,
    ]) {
      const path = join(target, item.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, item.bytes, { mode: 0o600, flag: 'wx' });
    }
    return true;
  } catch {
    return false;
  }
}
