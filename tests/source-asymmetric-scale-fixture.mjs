// SPDX-License-Identifier: Apache-2.0
import { randomUUID, createHash } from 'node:crypto';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
import { at } from './convex-source-scale-fixture.mjs';

// Retain only a shared file-list string and tiny per-State descriptors. Hash
// each manifest in pieces and materialize its bytes only when R2 is read. An
// 800-State fixture must not keep 800 * 9.8 MB in the test runner's heap.
export async function asymmetricHistory(
  s,
  count,
  depth,
  reverse,
  chainLength = 1,
  generationMetadata = false,
) {
  const blob = await s.putSpec(Buffer.from('synthetic\n')),
    small = [{ path: 'root.txt', mode: 'file', blob: blob.sha256 }],
    large = Buffer.from(
      saveBytes(
        Array.from({ length: count }, (_, i) => ({
          path: `src/deep/shared/components/features/generated/synthetic/module-${String(i).padStart(6, '0')}.ts`,
          mode: 'file',
          blob: blob.sha256,
        })),
      ),
    ).toString(),
    historical = new Set(),
    generations = new Map();
  const state = async (parents, message, big = false, files = small) => {
    const fileBytes = big ? large : Buffer.from(saveBytes(files)).toString(),
      // saveBytes sorts object keys; retain that canonical encoding exactly.
      value = Buffer.from(
        saveBytes({
          at,
          files: [],
          kind: 'forge-source-state',
          message,
          parents: parents.map(pin => pin.sha256),
          schema: 1,
        }),
      ).toString(),
      split = value.indexOf('[]'),
      prefix = value.slice(0, split),
      suffix = value.slice(split + 2),
      pin = {
        sha256: createHash('sha256').update(prefix).update(fileBytes).update(suffix).digest('hex'),
        size: Buffer.byteLength(prefix) + Buffer.byteLength(fileBytes) + Buffer.byteLength(suffix),
      };
    const generation = 1 + Math.max(0, ...parents.map(parent => generations.get(parent.sha256)));
    generations.set(pin.sha256, generation);
    return s.putSpec(
      { size: pin.size, generate: () => Buffer.from(prefix + fileBytes + suffix) },
      pin,
      generationMetadata ? generation : undefined,
    );
  };
  let old;
  for (let i = 0; i < depth; i++) {
    old = await state(old ? [old] : [], `history-${i}`, true);
    historical.add(old.sha256);
  }
  const c = await state(old ? [old] : [], 'C'),
    a = await state([c], 'A', true),
    b = await state([c], 'B', true);
  let shared = a;
  const chain = [a];
  for (let i = 1; i < chainLength; i++) {
    shared = await state([shared], `Q${i}`, true);
    chain.push(shared);
  }
  const m = await state(reverse ? [b, shared] : [shared, b], 'M', false, [
      ...small,
      { path: 'main.txt', mode: 'file', blob: blob.sha256 },
    ]),
    d = await state([shared], 'D', false, [
      ...small,
      { path: 'selected.txt', mode: 'file', blob: blob.sha256 },
    ]),
    inputs = buildComposePages([
      {
        laneId: randomUUID(),
        head: d.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: { object: d, recipe: null },
      },
    ]),
    dependencies = buildComposePages([]);
  for (const p of [...inputs.pages, ...dependencies.pages]) await s.json(p.value);
  const input = await s.json({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: m.sha256, receiptId: 'main' },
    main: { object: m, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'asymmetric merge',
    at,
  });
  return {
    input,
    generations,
    historical,
    near: new Set([...chain, b, c, m, d].map(pin => pin.sha256)),
    manifestBytes: a.size,
  };
}
