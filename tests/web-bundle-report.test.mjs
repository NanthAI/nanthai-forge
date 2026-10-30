// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webBundleReport } from '../scripts/web-bundle-report.mjs';

test('bundle measurement follows static closure once, including immediately loaded Hosted, and separates conditional fonts', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-web-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.vite'));
  writeFileSync(
    join(root, '.vite/manifest.json'),
    JSON.stringify({
      'index.html': {
        file: 'entry.js',
        imports: ['shared'],
        dynamicImports: ['src/Hosted.tsx'],
        css: ['entry.css'],
        assets: ['latin.woff2'],
      },
      'src/Hosted.tsx': { file: 'hosted.js', imports: ['shared'], dynamicImports: ['optional'] },
      shared: { file: 'shared.js', imports: ['index.html'] },
      optional: { file: 'unopened.js' },
    }),
  );
  for (const name of ['index.html', 'entry.js', 'entry.css', 'hosted.js', 'shared.js', 'latin.woff2'])
    writeFileSync(join(root, name), '12345');
  const report = webBundleReport(root);
  assert.equal(report.total.bytes, 25);
  assert.equal(report.assets.length, 5);
  assert.deepEqual(
    report.fonts.map(font => font.path),
    ['latin.woff2'],
  );
  assert.ok(report.total.gzipBytes > 0);
  assert.throws(() => webBundleReport(root, ['unknown']), /Missing bundle manifest entry/);
});
