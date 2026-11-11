// SPDX-License-Identifier: Apache-2.0
import { buildComposePages } from '../../dist/hosted-compose.js';
import { buildSavePages } from '../../dist/hosted-save.js';

const at = '2026-10-28T00:00:00.000Z';
const laneId = '00000000-0000-4000-8000-000000000001';
// Shapes from convex-source-scale.test.mjs: multiQuantum4k, sequentialSourceCost,
// projectedMergeCost. Fixed identifiers make the complete inputs reproducible.
export async function seedFixture(s, { count, kind, deep = false }) {
  const original = await s.putSpec(Buffer.from(kind === 'save' ? 'baseline\n' : 'base\n'));
  const files = Array.from({ length: count }, (_, i) => ({
    path: `src/${deep ? 'nested/'.repeat(24) : ''}${String(i).padStart(6, '0')}.txt`,
    blob: original.sha256,
    mode: 'file',
  }));
  const state = (files, parents, generation) =>
    s.putSpec(
      Buffer.from(
        JSON.stringify({ schema: 1, kind: 'forge-source-state', parents, files, message: 'branch', at }),
      ),
      undefined,
      generation,
      { parents },
    );
  const base = await state(files, [], 1);
  if (kind === 'save') {
    const changed = await s.putSpec(Buffer.from('landing-0\n'));
    const pages = buildSavePages([
      {
        path: files[0].path,
        before: { blob: original.sha256, mode: 'file' },
        after: { blob: changed.sha256, mode: 'file', content: { object: changed, recipe: null } },
      },
    ]);
    for (const page of pages.pages) await s.json(page.value);
    return s.json({
      schema: 1,
      kind: 'forge-hosted-save-input',
      baseline: { object: base, recipe: null },
      pages: pages.root,
      pageCount: pages.pages.length,
      changeCount: 1,
      message: 'landing-0',
      at,
    });
  }
  const a = await s.putSpec(Buffer.from('left\n')),
    b = await s.putSpec(Buffer.from('right\n'));
  const left = await state(
    files.map((f, i) => (i === 0 ? { ...f, blob: a.sha256 } : f)),
    [base.sha256],
    2,
  );
  const right = await state(
    files.map((f, i) => (i === 1 ? { ...f, blob: b.sha256 } : f)),
    [base.sha256],
    2,
  );
  if (kind === 'sync')
    return s.json({
      schema: 1,
      kind: 'forge-hosted-sync-input',
      algorithm: 'forge-native-sync-v1',
      work: { mode: 'sync', left: { object: left, recipe: null }, right: { object: right, recipe: null } },
      message: 'merge',
      at,
    });
  const inputs = buildComposePages([
      {
        laneId,
        head: right.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: { object: right, recipe: null },
      },
    ]),
    dependencies = buildComposePages([]);
  for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
  return s.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: left.sha256, receiptId: 'main' },
    main: { object: left, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'merge',
    at,
  });
}

export const shapes = [
  { name: 'smoke', count: 10, kind: 'compose' },
  { name: '4k-compose', count: 4000, kind: 'compose', deep: true },
  { name: '12k-save', count: 12000, kind: 'save' },
  { name: '29k-save', count: 29000, kind: 'save' },
  { name: '29k-compose', count: 29000, kind: 'compose' },
  { name: '29k-sync', count: 29000, kind: 'sync' },
  { name: '58k-compose', count: 58000, kind: 'compose' },
];
