// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** Built first-load closure: entry plus immediately imported Hosted, never unopened screens.
 * Font subsets are reported separately because unicode-range selects them at runtime.
 * Excludes provider scripts/API responses and browser-selected icons, not measured network traffic. */
export function webBundleReport(directory, entries = ['index.html', 'src/Hosted.tsx']) {
  const manifest = JSON.parse(readFileSync(join(directory, '.vite/manifest.json'), 'utf8'));
  const seen = new Set(),
    files = new Set(['index.html']),
    fonts = new Set();
  function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing bundle manifest entry: ${key}`);
    files.add(chunk.file);
    for (const path of chunk.css ?? []) files.add(path);
    for (const path of chunk.assets ?? []) if (path.endsWith('.woff2')) fonts.add(path);
    for (const imported of chunk.imports ?? []) visit(imported);
  }
  entries.forEach(visit);
  const measure = paths =>
    paths.sort().map(path => {
      const bytes = readFileSync(join(directory, path));
      return { path, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
    });
  const assets = measure([...files]);
  const fontAssets = measure([...fonts]);
  const total = assets.reduce(
    (sum, asset) => ({ bytes: sum.bytes + asset.bytes, gzipBytes: sum.gzipBytes + asset.gzipBytes }),
    { bytes: 0, gzipBytes: 0 },
  );
  return { entries, assets, fonts: fontAssets, total };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(
    JSON.stringify(
      webBundleReport(
        process.argv[2] ?? 'hosted-web-dist',
        process.argv.length > 3 ? process.argv.slice(3) : undefined,
      ),
      null,
      2,
    ),
  );
