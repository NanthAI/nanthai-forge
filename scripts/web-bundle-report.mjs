// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** Built first-load closure: entry plus the immediately imported app (src/app/App.tsx), never unopened screens. The default is the
 * signed-in app (app.html); pass ['index.html'] for the static public page.
 * Font subsets are reported separately because unicode-range selects them at runtime.
 * Excludes provider scripts/API responses and browser-selected icons, not measured network traffic. */
export function webBundleReport(directory, entries = ['app.html', 'src/app/App.tsx']) {
  const manifest = JSON.parse(readFileSync(join(directory, '.vite/manifest.json'), 'utf8'));
  const seen = new Set(),
    files = new Set(entries.filter(entry => entry.endsWith('.html'))),
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
