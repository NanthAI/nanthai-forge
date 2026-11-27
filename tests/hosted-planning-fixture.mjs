// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
import { digest } from '../dist/hash.js';
import { hostedRecordIndex, hostedRecordValue } from '../dist/hosted-records.js';
import { workStoreRecord } from '../dist/work-store-records.js';
import { fixture, git } from './helpers.mjs';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { readHosted } from './hosted-read.mjs';
import { establishedAccount } from './account-tier-fixture.mjs';
export const actions = await import(moduleUrl('../convex/projectWorkActions.ts'));
export const work = await import(moduleUrl('../convex/projectWork.ts'));
const projectIntentLandingNotes = await import(moduleUrl('../convex/projectIntentLandingNotes.ts'));
const backups = await import(moduleUrl('../convex/projectBackups.ts'));
const projectHostedSeedWorkStore = await import(moduleUrl('../convex/projectHostedSeedWorkStore.ts'));
const { previewWorkArchive } = await import(moduleUrl('../web/src/work-archive.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const { advancePlanningTimes } = await import(moduleUrl('../convex/projectPlanningTimes.ts'));

/** Seed retained history from before Issue heads required planning-time proofs. */
export async function seedHistoricalIssueVersion(s, item, pin) {
  const encoded = hostedRecordValue(workStoreRecord('planningVersions', item));
  const identity = { projectId: s.projectId, kind: 'issue', key: item.id };
  const indexed = { ...hostedRecordIndex(encoded.record), version: item.version };
  const previous = await records.recordHead(s.ctx, s.projectId, 'issue', item.id);
  const bodyId = await s.ctx.db.insert('projectHostedRecordBodies', {
    projectId: s.projectId,
    value: encoded.value,
  });
  const recordId = await s.ctx.db.insert('projectHostedRecords', {
    ...identity,
    ...indexed,
    bodyId,
    digest: encoded.ref.digest,
    bytes: encoded.ref.bytes,
  });
  if (previous && previous.version > item.version) {
    if (previous.planningTimes) await s.ctx.db.patch(previous._id, { planningTimes: undefined });
    return 'copied';
  }
  const planningTimes = pin ?? advancePlanningTimes(item, previous ?? undefined);
  const row = {
    ...identity,
    ...indexed,
    recordId,
    value: JSON.stringify(item),
    ...(planningTimes ? { planningTimes } : {}),
  };
  if (previous) await s.ctx.db.replace(previous._id, row);
  else await s.ctx.db.insert('projectHostedRecordHeads', row);
  return 'copied';
}

/** Add a Lane-owned pin to live Work, as a hosted start does after the Item or Intent exists. */
export async function pinIntent(ctx, input) {
  const head = await records.recordHead(ctx, input.projectId, 'intent', input.record.id);
  return records.writeHostedRecord(ctx, {
    ...input,
    expectedVersion: head?.version ?? null,
    record: { ...input.record, version: (head?.version ?? -1) + 1 },
  });
}

export async function setup(t, native = true, prepare, prepareIndex = true) {
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
  // A long-standing owner: planning volume here is an Established account's, not a new sign-up's.
  establishedAccount(s.tables, 'owner', ['planning', 'start']);
  s.ctx.runAction =
    s.ctx.runQuery =
    s.ctx.runMutation =
      (ref, args) => {
        const [module, name] = getFunctionName(ref).split(':');
        return (
          {
            projectWork: work,
            projectBackups: backups,
            projectIntentLandingNotes,
            projectHostedSeedWorkStore,
          }[module]?.[name]?._handler(s.ctx, args) ?? originalQuery(ref, args)
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
    location: 'r2',
    r2Committed: true,
    r2Key: `v1/p/${projectId}/o/${digest(bytes)}`,
  });
  {
    // The base archive is an R2 object, written like any upload to whichever bucket the test installed.
    const { presignPut, r2Config } = await import(moduleUrl('../convex/r2.ts'));
    const target = await presignPut(r2Config(), `v1/p/${projectId}/o/${digest(bytes)}`, {
      digest: digest(bytes),
      size: bytes.length,
    });
    const put = await fetch(target.url, { method: 'PUT', headers: target.headers, body: bytes });
    if (!put.ok && put.status !== 412) throw new Error(`base archive upload failed: ${put.status}`);
  }
  await actions.initialize._handler(s.ctx, { projectId, backupId, operationId: randomUUID() });
  if (prepareIndex) {
    const { ensure } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
    await ensure._handler(s.ctx, { projectId, rebuild: true });
  }
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
