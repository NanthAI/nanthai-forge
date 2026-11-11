// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaleFixture, at } from './convex-source-scale-fixture.mjs';
import { buildSavePages } from '../dist/hosted-save.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { digest } from '../dist/hash.js';
const ref = object => ({ object, recipe: null });
export async function sourceMemoryFixture(count, phase, streaming = false) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-source-memory-'));
  const s = await scaleFixture(
    streaming ? { nodeStepUrl: new URL('./source-stream-provider.mjs', import.meta.url).href } : {},
  );
  let serial = 0;
  try {
    const original = await s.putSpec(Buffer.from('baseline\n'));
    const leftBlob = await s.putSpec(Buffer.from('left\n'));
    const rightBlob = await s.putSpec(Buffer.from('right\n'));
    const files = Array.from({ length: count }, (_, i) => ({
      path: `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.ts`,
      blob: original.sha256,
      mode: 'file',
    }));
    async function state(files, parents, message) {
      const bytes = Buffer.from(
        JSON.stringify({ schema: 1, kind: 'forge-source-state', parents, files, message, at }),
      );
      const pin = { sha256: digest(bytes), size: bytes.length },
        path = join(directory, String(++serial));
      await writeFile(path, bytes);
      return s.putSpec({ path, size: pin.size }, pin, parents.length ? 2 : 1, { parents });
    }
    const base = await state(files, [], 'base');
    const leftFiles = files.map((file, i) => (i === 0 ? { ...file, blob: leftBlob.sha256 } : file));
    const left = await state(leftFiles, [base.sha256], 'left');
    const rightFiles = files.map((file, i) =>
      i === (phase === 'conflict-sync' ? 0 : 1) ? { ...file, blob: rightBlob.sha256 } : file,
    );
    const right = await state(rightFiles, [base.sha256], 'right');
    let plan;
    if (phase === 'save') {
      const pages = buildSavePages([
        {
          path: files[0].path,
          before: { blob: original.sha256, mode: 'file' },
          after: { blob: leftBlob.sha256, mode: 'file', content: ref(leftBlob) },
        },
      ]);
      for (const page of pages.pages) await s.json(page.value);
      plan = {
        schema: 1,
        kind: 'forge-hosted-save-input',
        baseline: ref(base),
        pages: pages.root,
        pageCount: pages.pages.length,
        changeCount: 1,
        message: 'save',
        at,
      };
    } else if (phase === 'compose') {
      const inputs = buildComposePages([
        {
          laneId: '11111111-1111-4111-8111-111111111111',
          head: left.sha256,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: ref(left),
        },
      ]);
      const dependencies = buildComposePages([]);
      for (const page of [...inputs.pages, ...dependencies.pages]) await s.json(page.value);
      plan = {
        schema: 1,
        kind: 'forge-hosted-compose-input',
        base: { head: right.sha256, receiptId: 'main' },
        main: ref(right),
        inputs: inputs.manifest,
        dependencies: dependencies.manifest,
        algorithm: 'forge-native-compose-v1',
        message: 'compose',
        at,
      };
    } else {
      plan = {
        schema: 1,
        kind: 'forge-hosted-sync-input',
        algorithm: 'forge-native-sync-v1',
        work: { mode: 'sync', left: ref(left), right: ref(right) },
        message: 'sync',
        at,
      };
    }
    const input = await s.json(plan);
    return {
      s,
      input,
      stateBytes: base.size,
      async dispose() {
        s.restore();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    s.restore();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
