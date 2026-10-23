// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
const base = new URL('../dist/', import.meta.url).href;
const { initNative } = await import(base + 'native-work.js'),
  { indexRepository } = await import(base + 'index.js'),
  { Workspace } = await import(base + 'workspace.js');
const root = mkdtempSync(join(tmpdir(), 'forge-graph-cost-')),
  session = {},
  samples = [];
const source = i =>
  `${i ? `import {value${i - 1}} from './file${i - 1}.js';\n` : ''}export const value${i} = ${i ? `value${i - 1} + 1` : '1'};\n` +
  Array.from(
    { length: 12 },
    (_, n) => `export function function${i}_${n}(input: number) { return input + value${i}; }`,
  ).join('\n');
try {
  for (let i = 0; i < 250; i++) writeFileSync(join(root, `file${i}.ts`), source(i));
  initNative(root);
  let warmup = indexRepository(root, undefined, session);
  void warmup;
  for (let cycle = 0; cycle < 3; cycle++) {
    writeFileSync(join(root, 'file120.ts'), source(120) + `\nexport const round${cycle} = ${cycle};`);
    const warm = indexRepository(root, undefined, session);
    rmSync(join(root, '.forge/index.json'));
    const cold = indexRepository(root, undefined, {});
    const reuse = indexRepository(root, undefined, session);
    if (warm.pack.id !== cold.pack.id || cold.pack.id !== reuse.pack.id) throw Error('identity mismatch');
    samples.push({
      cycle,
      incremental: { elapsedMs: warm.elapsedMs, ...warm.work },
      cold: { elapsedMs: cold.elapsedMs, ...cold.work },
      unchanged: { elapsedMs: reuse.elapsedMs, ...reuse.work },
    });
  }
  rmSync(join(root, '.forge/index.json'));
  const workspace = new Workspace(root);
  const a = performance.now();
  await workspace.reindex();
  const first = performance.now() - a;
  writeFileSync(join(root, 'file120.ts'), source(120) + '\nexport const final=1;');
  const b = performance.now();
  const result = await workspace.reindex();
  const subsequent = performance.now() - b;
  await workspace.close();
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        files: 250,
        samples,
        worker: { firstWallMs: first, subsequentWallMs: subsequent, result },
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
