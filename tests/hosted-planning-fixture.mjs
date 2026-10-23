// SPDX-License-Identifier: Apache-2.0
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
import { digest } from '../dist/hash.js';
import { fixture, git } from './helpers.mjs';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { readHosted } from './hosted-read.mjs';
export const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
export const work = await import(moduleUrl('../convex/projectWork.ts'));
export const returns = await import(moduleUrl('../convex/projectSourceReturn.ts'));
const backups = await import(moduleUrl('../convex/projectBackups.ts'));
const { previewWorkArchive } = await import(moduleUrl('../web/src/work-archive.ts'));
export async function setup(t, native = true, prepare) {
  const directory = fixture(t),
    root = join(directory, 'source');
  mkdirSync(root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  if (native) initNative(root);
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Original source']);
  }
  const local = new WorkService(root);
  await prepare?.(root, local);
  const exported = (await local.dispatch({ action: 'export-work', archive: true }, local.status().revision))
    .result;
  const bytes = readFileSync(exported.archive.path),
    preview = await previewWorkArchive(new File([bytes], 'source.tar.gz'));
  const s = state([]),
    originalQuery = s.ctx.runQuery;
  s.ctx.runAction =
    s.ctx.runQuery =
    s.ctx.runMutation =
      (ref, args) => {
        const [module, name] = getFunctionName(ref).split(':');
        return (
          { projectWork: work, projectBackups: backups }[module]?.[name]?._handler(s.ctx, args) ??
          originalQuery(ref, args)
        );
      };
  const projectId = 'project',
    backupId = 'backup';
  s.tables.hostedProjects.set(projectId, {
    _id: projectId,
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic planning project',
    currentBackup: backupId,
    revision: 1,
  });
  s.tables.projectBackups.set(backupId, {
    _id: backupId,
    _creationTime: 1,
    projectId,
    operationId: randomUUID(),
    request: 'a'.repeat(64),
    nonce: randomUUID(),
    previous: null,
    digest: digest(bytes),
    size: bytes.length,
    preview,
    status: 'stored',
    storageId: 'source',
  });
  s.files.set('source', { blob: new Blob([bytes], { type: 'application/gzip' }) });
  await actions.initialize._handler(s.ctx, { projectId, backupId, operationId: randomUUID() });
  const read = async () => JSON.parse(await readHosted(s.ctx, { projectId }));
  const send = async (command, revision) =>
    actions.command._handler(s.ctx, {
      projectId,
      operationId: command.operationId ?? randomUUID(),
      revision: revision ?? (await read()).data.revision,
      command: JSON.stringify(command),
    });
  const item = (patch = {}) => ({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId: randomUUID(),
    expectedVersion: 0,
    kind: 'issue',
    title: 'Synthetic issue',
    body: '',
    status: 'open',
    intentIds: [],
    ...patch,
  });
  return { ...s, directory, root, local, exported, bytes, preview, projectId, backupId, read, send, item };
}
