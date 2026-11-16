// SPDX-License-Identifier: Apache-2.0
// The design system's behaviour layer in a real build (Item 6ebb58ab): the app plus the reference surface, which uses
// every interactive part. The build's own guard (web/vite.config.ts, forge-ds-layer) fails if a first-paint chunk
// carries the layer or the layer is over budget; this test also checks the layer only has English messages and that
// the app's first-paint JavaScript stays inside its budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAYER_GZIP_BUDGET, layerBundleReport } from '../scripts/ds-build-guard.mjs';
import { bundleSummary } from '../scripts/perf/report.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const budgets = JSON.parse(readFileSync(join(root, 'src/speed-budgets.json'), 'utf8')).budgets;
const eagerBudget = budgets.find(budget => budget.id === 'web-eager-js-gzip').max;

test('the behaviour layer loads apart from first paint, inside its budget, with English messages only', async () => {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const out = mkdtempSync(join(tmpdir(), 'forge-ds-layer-'));
  try {
    const result = await build({
      configFile: join(root, 'web/vite.config.ts'),
      root: join(root, 'web'),
      mode: 'hosted',
      logLevel: 'warn',
      build: {
        outDir: out,
        emptyOutDir: true,
        rolldownOptions: { input: { app: join(root, 'web/app.html'), ds: join(root, 'web/ds.html') } },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result).output;
    const bundle = Object.fromEntries(output.map(item => [item.fileName, item]));
    const { problems, layer } = layerBundleReport(bundle, LAYER_GZIP_BUDGET);
    assert.deepEqual(problems, []);
    assert.ok(layer, 'the reference surface pulls in the behaviour layer');
    assert.ok(layer.gzipBytes <= LAYER_GZIP_BUDGET, `${layer.gzipBytes} > ${LAYER_GZIP_BUDGET}`);
    const code = layer.files.map(file => bundle[file].code).join('\n');
    // A drag message in English is kept; the same message in German or Japanese was removed by the locale plugin.
    assert.match(code, /Press Enter to start dragging/);
    assert.doesNotMatch(code, /Eingabetaste|Ziehvorgang/);

    const summary = await bundleSummary(out);
    assert.ok(summary.eagerJsGzipBytes <= eagerBudget, `${summary.eagerJsGzipBytes} > ${eagerBudget}`);
    assert.ok(!summary.eagerFiles.some(file => layer.files.includes(file)), 'no layer chunk is eager');
    console.log(
      `behaviour layer ${layer.gzipBytes} of ${LAYER_GZIP_BUDGET} gzip bytes; app first paint ${summary.eagerJsGzipBytes} of ${eagerBudget}`,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
