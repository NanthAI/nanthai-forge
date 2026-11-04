// SPDX-License-Identifier: Apache-2.0
// Explicit local measurement; not part of the ordinary test suite.
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { cleanHostedCheckout } from '../dist/hosted-checkout-files.js';
import { ignoreLayer, ignoredBy } from '../dist/source-ignore.js';
import { digest } from '../dist/hash.js';
for (const count of [3000, 29000]) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'forge-apply-scale-')));
  try {
    const bytes = Buffer.from('synthetic source\n'),
      files = [];
    fs.mkdirSync(join(root, 'src'));
    fs.mkdirSync(join(root, 'out'));
    fs.writeFileSync(join(root, '.gitignore'), '/out/\n');
    files.push({ path: '.gitignore', blob: digest('/out/\n'), mode: 'file' });
    for (let i = 0; i < count - 1; i++) {
      const path = `src/${i}.ts`;
      fs.writeFileSync(join(root, path), bytes);
      // Equally large ignored output tree must cost one stat, not N.
      fs.writeFileSync(join(root, 'out', `${i}.js`), bytes);
      files.push({ path, blob: digest(bytes), mode: 'file' });
    }
    fs.symlinkSync('../dependencies', join(root, 'node_modules'));
    const ignoreStart = performance.now();
    for (let i = 0; i < 2; i++) {
      const layers = ignoreLayer('', name => (name === '.gitignore' ? '/out/\n' : undefined));
      for (const [path, directory] of [
        ['src', true],
        ['out', true],
        ['node_modules', false],
      ])
        ignoredBy(layers, path, directory);
    }
    const ignoreEvaluationMs = performance.now() - ignoreStart;
    const lstat = fs.lstatSync;
    let stats = 0;
    fs.lstatSync = (...args) => {
      stats++;
      return lstat(...args);
    };
    syncBuiltinESMExports();
    const start = performance.now(),
      heap = process.memoryUsage().heapUsed;
    try {
      for (let i = 0; i < 2; i++) {
        const preserved = cleanHostedCheckout(root, files, 'hosted-lane.json', false, { target: files });
        if (preserved.length !== 2) throw Error('outputs were not pruned');
      }
      console.log(
        JSON.stringify({
          sourceFiles: count,
          ignoredOutputFiles: count - 1,
          passes: 2,
          ignoreEvaluationMs: +ignoreEvaluationMs.toFixed(3),
          filesStated: stats,
          wallMs: Math.round(performance.now() - start),
          heapDeltaMiB: Math.round((process.memoryUsage().heapUsed - heap) / 1048576),
          rssMiB: Math.round(process.memoryUsage().rss / 1048576),
          peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
          addedConvexCalls: 0,
          dbReads: 0,
          dbWrites: 0,
        }),
      );
    } finally {
      fs.lstatSync = lstat;
      syncBuiltinESMExports();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
