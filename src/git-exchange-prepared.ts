// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WorkStore } from './work-store.js';
import { exportWork } from './work-backup.js';
import { manifestSchema } from './work-archive-metadata.js';
import { buildExchangeRoot } from './native-exchange-tree.js';
import { invariant } from './errors.js';
/** Git stays Git: pin its committed history bundle and complete Work, then exchange missing object/chunk IDs. */
export async function prepareGitExchange(
  store: WorkStore,
  revision: number,
  operationId: string,
  trees: boolean,
) {
  const directory = join(store.directory, `exchange-${operationId}`),
    path = join(directory, 'manifest.json');
  if (existsSync(path)) {
    const json = readFileSync(path, 'utf8'),
      manifest = manifestSchema.parse(JSON.parse(json));
    invariant(
      manifest.id === operationId && manifest.revision === revision,
      'WORK_OPERATION_CHANGED',
      'Retry exchange with its original revision and operation.',
    );
    return { directory, json, manifest };
  }
  invariant(store.revision() === revision, 'WORK_STALE', 'Work changed before exchange.');
  const exported = await exportWork(store, revision, false),
    staged = exported.result.path;
  try {
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(staged, 'manifest.json'), 'utf8')));
    invariant(manifest.revision === revision, 'WORK_STALE', 'Work changed before exchange.');
    manifest.id = operationId;
    const json = JSON.stringify(manifest);
    writeFileSync(join(staged, 'manifest.json'), json, { mode: 0o600 });
    if (trees) {
      const tree = buildExchangeRoot(Buffer.from(json), readFileSync(join(staged, 'work.json')));
      writeFileSync(join(staged, 'exchange.json'), tree.bytes, { mode: 0o600 });
      writeFileSync(join(staged, 'exchange-index.json'), JSON.stringify(tree.index), { mode: 0o600 });
    }
    store.locked(() => {
      if (!existsSync(directory)) renameSync(staged, directory);
    });
    const original = readFileSync(path, 'utf8');
    return { directory, json: original, manifest: manifestSchema.parse(JSON.parse(original)) };
  } finally {
    if (existsSync(staged)) rmSync(staged, { recursive: true, force: true });
  }
}
