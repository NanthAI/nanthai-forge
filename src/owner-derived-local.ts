// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, writeFileSync, renameSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './hash.js';
import { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';
import {
  computeOwnerDerived,
  OwnerDerivedCapacity,
  ownerDerivedSchema,
  OWNER_DERIVED_MAX_BYTES,
  type OwnerDerivedBaseline,
} from './owner-derived.js';
/** Disposable, bounded delta cache. Dry runs may redirect it outside the owner. */
export function ownerDerivedBytes(
  store: WorkStore,
  data: WorkData,
  baseline?: OwnerDerivedBaseline,
  cacheDirectory = store.directory,
) {
  const path = join(cacheDirectory, 'owner-derived-cache.json');
  let previous;
  try {
    if (statSync(path).size <= OWNER_DERIVED_MAX_BYTES) {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (record.schema === 2 && digest(JSON.stringify(record.derived)) === record.sha256)
        previous = ownerDerivedSchema.parse(record.derived);
    }
  } catch {
    /* cold cache; legacy full-history caches are not read */
  }
  // Missing exact baseline metadata means supply full facts; the server selects
  // the replacements against its authoritative generation.
  let result;
  try {
    result = computeOwnerDerived(
      data,
      new NativeSource(store.root),
      previous,
      baseline?.data ? baseline : undefined,
    );
  } catch (error) {
    if (!(error instanceof OwnerDerivedCapacity)) throw error;
  }
  const bytes = result ? Buffer.from(JSON.stringify(result)) : undefined;
  const bounded = bytes && bytes.length <= OWNER_DERIVED_MAX_BYTES ? bytes : undefined;
  const cache = JSON.stringify({
    schema: 2,
    derived: bounded ? result : null,
    sha256: digest(bounded ?? 'null'),
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, Buffer.byteLength(cache) <= OWNER_DERIVED_MAX_BYTES ? cache : '{"schema":2}', {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, path);
  } catch {
    // The cache is disposable; a persistence failure must not discard computed rows.
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* disposable cache cleanup */
    }
  }
  return bounded;
}
export function preparedOwnerDerived(directory: string) {
  const path = join(directory, 'owner-derived.json');
  return existsSync(path) && statSync(path).size <= OWNER_DERIVED_MAX_BYTES ? readFileSync(path) : undefined;
}
