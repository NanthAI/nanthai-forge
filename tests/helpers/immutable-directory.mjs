// SPDX-License-Identifier: Apache-2.0
import { after } from 'node:test';
import { constants, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize, deserialize } from 'node:v8';

/** Build each immutable seed once per file; every caller gets independent writable bytes. */
export function immutableDirectory(prefix, build) {
  const seeds = new Map();
  after(async () => {
    for (const seed of seeds.values()) {
      const { root } = await seed;
      rmSync(root, { recursive: true, force: true });
    }
  });
  return async (key = '') => {
    if (!seeds.has(key)) {
      const root = mkdtempSync(join(tmpdir(), `${prefix}seed-`));
      seeds.set(
        key,
        Promise.resolve().then(async () => ({ root, value: await build(root, key) })),
      );
    }
    const seed = await seeds.get(key);
    const root = mkdtempSync(join(tmpdir(), prefix));
    // Reflinks where supported, ordinary copies elsewhere; never hard-link mutable metadata.
    cpSync(seed.root, root, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    return { root, value: deserialize(serialize(seed.value)) };
  };
}

/** Synchronous setup variant for fixtures whose callers perform synchronous Work commands. */
export function immutableDirectorySync(prefix, build) {
  const seeds = new Map();
  after(() => {
    for (const seed of seeds.values()) rmSync(seed.root, { recursive: true, force: true });
  });
  return (key = '') => {
    if (!seeds.has(key)) {
      const root = mkdtempSync(join(tmpdir(), `${prefix}seed-`));
      seeds.set(key, { root, value: build(root, key) });
    }
    const seed = seeds.get(key);
    const root = mkdtempSync(join(tmpdir(), prefix));
    cpSync(seed.root, root, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    return { root, value: deserialize(serialize(seed.value)) };
  };
}
