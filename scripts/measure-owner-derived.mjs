// SPDX-License-Identifier: Apache-2.0
// Offline: read the retained pending push and its exact local hosted baseline.
// All cache output goes to scratch; no owner metadata or hosted service is changed.
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore } from '../dist/work-store.js';
import { exchangeBaseline } from '../dist/native-exchange-baseline.js';
import { ownerDerivedBytes } from '../dist/owner-derived-local.js';
const store = new WorkStore(process.argv[2]);
const { push } = JSON.parse(readFileSync(join(store.directory, 'hosted-binding.json')));
if (!push?.returnSource) throw Error('Select an owner with a retained source-return push.');
const key = JSON.stringify([push.deployment, push.projectId, push.returnSource.expectedBackupId]);
const baseline = exchangeBaseline(store, key);
if (!baseline?.data) throw Error('Exact local hosted baseline unavailable; no network read attempted.');
const directory = mkdtempSync(join(tmpdir(), 'forge-derived-dry-'));
const prepared = join(store.directory, `exchange-${push.operationId}`);
const size = path => {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
};
try {
  const data = process.argv.includes('--current')
    ? store.load()
    : JSON.parse(readFileSync(join(prepared, 'work.json')));
  const bytes = ownerDerivedBytes(store, data, baseline, directory);
  const derived = bytes ? JSON.parse(bytes) : undefined;
  console.log(
    JSON.stringify({
      revision: data.revision,
      baselineRevision: baseline.data.revision,
      sidecarBefore: size(join(prepared, 'owner-derived.json')),
      sidecarAfter: bytes?.length ?? 0,
      cacheBefore: size(join(store.directory, 'owner-derived-cache.json')),
      cacheAfter: size(join(directory, 'owner-derived-cache.json')),
      rows: derived
        ? Object.fromEntries(
            ['parents', 'ancestry', 'stats', 'views', 'trees'].map(k => [k, derived[k].length]),
          )
        : null,
      omitted: !bytes,
      ownerUnchanged: true,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
