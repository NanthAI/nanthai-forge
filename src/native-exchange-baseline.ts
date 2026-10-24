// SPDX-License-Identifier: Apache-2.0
import { readFileSync, existsSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeManifestSchema } from './work-archive-metadata.js';
import { parseWork } from './work-unified-types.js';
import { digest } from './hash.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';
import type { ExchangeManifest } from './native-exchange.js';

// This is a local preparation hint, never publication or access authority. The
// backend still validates the selected root and its project-bound closure.
export function exchangeBaseline(store: WorkStore, key?: string) {
  if (!key || !store.native) return undefined;
  const path = join(store.directory, `exchange-baseline-${digest(key)}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (digest(record.payload) !== record.sha256) return undefined;
    const { manifest, completedRuns, objects, states, data } = JSON.parse(record.payload);
    const parsed = nativeManifestSchema.parse(manifest);
    const objectIds = new Set(
      parsed.files.filter(pin => pin.path === `objects/${pin.sha256}`).map(pin => pin.sha256),
    );
    if (!Array.isArray(states) || !states.every(id => typeof id === 'string' && objectIds.has(id)))
      return undefined;
    // Older hints omitted Work. Recover only the exact locally prepared bytes
    // named by this manifest, never the owner's current mutable snapshot.
    let baselineData = data as WorkData | undefined;
    if (!baselineData) {
      try {
        const pin = parsed.files.find(p => p.path === 'work.json');
        if (pin && /^[0-9a-f-]{36}$/i.test(parsed.id)) {
          const bytes = readFileSync(join(store.directory, `exchange-${parsed.id}`, 'work.json'));
          if (bytes.length === pin.size && digest(bytes) === pin.sha256) {
            const raw = JSON.parse(bytes.toString('utf8'));
            parseWork(raw);
            baselineData = raw;
          }
        }
      } catch {
        /* missing exact baseline means optional derivation is omitted */
      }
    }
    return {
      manifest: parsed,
      data: baselineData,
      states: new Set<string>(states),
      completedRuns: new Set<string>(completedRuns),
      objects: new Map<string, number>(objects ?? []),
    };
  } catch {
    return undefined;
  }
}
export function retainExchangeBaseline(
  store: WorkStore,
  key: string | undefined,
  manifest: ExchangeManifest,
  data: WorkData,
  objects: { sha256: string; size: number }[],
  states: string[],
) {
  if (!key || !store.native) return;
  const path = join(store.directory, `exchange-baseline-${digest(key)}.json`),
    temporary = `${path}.${randomUUID()}.tmp`;
  const payload = JSON.stringify({
    manifest,
    data,
    states,
    objects: objects.map(pin => [pin.sha256, pin.size]),
    completedRuns: data.runs.filter(run => run.endedAt).map(run => digest(JSON.stringify(run))),
  });
  try {
    writeFileSync(temporary, JSON.stringify({ payload, sha256: digest(payload) }), {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
