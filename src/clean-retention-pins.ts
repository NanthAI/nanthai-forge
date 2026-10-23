// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allRecords } from './agent-lifecycle.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun, WorkView } from './work-types.js';

/** Reference discovery examines values, never executes source or provider code. */
export function references(value: unknown, found: Set<string>) {
  if (typeof value === 'string') {
    found.add(value);
    // A file pin protects those exact bytes, not every copy belonging to its run.
    if (!/(?:^|\/)check-[0-9a-f-]{36}\//i.test(value))
      for (const id of value.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? []) found.add(id);
  } else if (Array.isArray(value)) for (const child of value) references(child, found);
  else if (value && typeof value === 'object')
    for (const child of Object.values(value)) references(child, found);
}
export function retentionPins(store: WorkStore, runs: CheckRun[]) {
  const refs = new Set<string>(),
    baselines = new Set<string>(),
    views = allRecords<WorkView>(store, 'views');
  // Acceptances and open Lanes need evidence, not disposable execution trees.
  // Only explicit releases/exports retain exact historical check-file bytes.
  // A release's acceptance pins source State, not every check on that View or
  // its dependencies. Only its explicitly selected build runs pin run copies.
  for (const release of allRecords<{ buildRuns?: { id: string }[] }>(store, 'releases'))
    for (const run of release.buildRuns ?? []) refs.add(run.id);
  // Pending exchanges/exports and baseline hints are outside portable Work. Keep
  // their selected IDs and check-file references, including opaque extension data.
  for (const name of readdirSync(store.directory)) {
    if (!/^(?:.*export.*|.*release.*|exchange-.*|hosted-binding)\.json$/.test(name)) continue;
    const path = join(store.directory, name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return { refs, baselines, unknown: true };
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (name.startsWith('exchange-baseline-')) {
        // Modern hints carry their own Work bytes; only old hints depend on staging.
        const payload = JSON.parse(value.payload);
        if (!payload.data) baselines.add(payload.manifest.id);
      } else if (name === 'hosted-binding.json') {
        // Presence/agentSync are self-contained advisory payloads, not leases on
        // check files. Only pending source operations depend on staging bytes.
        references(
          [value.push, value.pendingPushes, value.pulls, value.hosting?.ready ? undefined : value.hosting],
          refs,
        );
      } else if (!['owner-derived-cache.json', 'init.json'].includes(name)) references(value, refs);
    } catch {
      return { refs, baselines, unknown: true };
    }
  }
  // Close transitive View dependencies regardless of record insertion order.
  let previousSize: number;
  do {
    previousSize = refs.size;
    for (const view of views)
      if (refs.has(view.id)) {
        refs.add(view.id);
        references(view, refs);
      }
  } while (refs.size !== previousSize);
  for (const run of runs) if (refs.has(run.viewId)) refs.add(run.id);
  return { refs, baselines, unknown: false };
}
