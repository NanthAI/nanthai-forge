// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The stored base checkpoint fixture of Item b6588425 lines 2d and 2e: a hosted project whose Work was written by
// hosted commands, then checkpointed as an exchange root with a record catalog the backup selects.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { setup } from './hosted-planning-fixture.mjs';
import { upload, modules as exchangeModules } from './project-exchange-fixture.mjs';
import { defaultR2Objects } from './default-r2.mjs';
import { buildExchangeRoot } from '../dist/native-exchange-tree.js';
import { jsonChunks } from '../dist/json-chunks.js';
import { buildObjectRecipe } from '../dist/object-chunks.js';
import { digest } from '../dist/hash.js';

export const SECRET = 'quokka-base-purge-fixture';
export const OTHER = 'wallaby-base-purge-fixture';
export const code = error => error.data?.code ?? error.code;
export const names = [
  'abuseReports',
  'projectCommentPurge',
  'projectCommentPurgeArchive',
  'projectCommentPurgeArchiveStore',
  'projectCommentPurgeBaseStore',
  'projectPlanningPurgeSegmentRun',
  'projectPlanningPurgeSegments',
  'projectJournalRead',
  'projectWorkIndex',
  'projectWorkIndexActions',
  'projectSavePurgeStore',
  'projectObjectRecipeStore',
];
export const modules = {
  ...exchangeModules,
  ...Object.fromEntries(
    await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
  ),
};
export const workLoad = await import(moduleUrl('../convex/projectWorkLoad.ts'));
export const { exchangeObjectReader } = await import(moduleUrl('../convex/projectExchangeReader.ts'));
export const { readHosted } = await import('./hosted-read.mjs');

/** Every stored byte (R2 and Convex file storage) that holds the words. */
export const storedWords = (s, words = SECRET) =>
  [...defaultR2Objects.entries()]
    .filter(([key, bytes]) => key.includes(`/${s.projectId}/`) && Buffer.from(bytes).includes(words))
    .map(([key]) => key);
export const tableWords = (s, words = SECRET) =>
  Object.entries(s.tables).flatMap(([table, rows]) =>
    [...rows.values()]
      .filter(row => JSON.stringify(row).includes(words))
      .map(row => `${table}:${row.collection ?? row.kind ?? ''}:${row.key ?? row.operationId ?? row._id}`),
  );

/** A hosted project whose Item, kept comment and reported comment were written by hosted commands, then
 * checkpointed: the stored base is an exchange root with a record catalog (packed) over that Work, the Work index is
 * rebuilt from it, and the comment's journal rows are gone (`rows: false`) or kept at or before the base. */
export async function based(
  t,
  { rows = false, decision = false, imported = false, recipe = false, prepare, legacy = false } = {},
) {
  // Every fixture names its project 'project' in the process's one bucket: start from an empty one.
  for (const key of [...defaultR2Objects.keys()])
    if (key.includes('/p/project/')) defaultR2Objects.delete(key);
  const s = await setup(t);
  const run = s.ctx.runQuery;
  for (const method of ['runQuery', 'runMutation', 'runAction'])
    s.ctx[method] = (ref, args) => {
      const [name, action] = getFunctionName(ref).split(':');
      return modules[name]?.[action] ? modules[name][action]._handler(s.ctx, args) : run(ref, args);
    };
  s.ctx.storage.generateUploadUrl = async () => 'https://fixture.invalid/upload';
  const item = s.item({ title: 'Kept title', body: 'Kept body' });
  await s.send(item);
  const comment = (text, extra = {}) => ({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: item.itemId,
    authorLabel: 'agent',
    text,
    ...extra,
  });
  const kept = comment('Kept comment'),
    reported = comment(`Spam ${SECRET}`, decision ? { decision: true } : {}),
    other = comment(`More spam ${OTHER}`);
  for (const command of [kept, reported, other]) await s.send(command);
  // More Work in the base (a second Item, say), written before the checkpoint.
  await prepare?.(s);
  // A Work above the largest chunk (1 MiB), so its recipe has several chunks.
  if (recipe)
    for (let i = 0; i < (recipe === true ? 3 : recipe); i++)
      await s.send(s.item({ title: `Filler ${i}`, body: randomBytes(160 * 1024).toString('hex') }));
  // The checkpoint: the hosted Work as portable bytes, its manifest naming them, the exchange root over both.
  const { data } = await workLoad.load(s.ctx, s.projectId, 'owner');
  // A comment written before hosted Work (imported with the base) has a comment record and no event.
  if (imported) data.hostedEvents = data.hostedEvents.filter(event => event.id !== reported.operationId);
  // A base converted to Intents keeps the pre-conversion planning records inline (legacyIntentMerge).
  if (legacy)
    data.legacyIntentMerge = {
      intents: typeof legacy === 'function' ? legacy(item.itemId) : [],
      planningItems: data.planningItems.map(row => ({ ...row, body: `${row.body} legacy` })),
      planningComments: structuredClone(data.planningComments),
      fields: {},
    };
  const work = Buffer.from([...jsonChunks(data, 2)].join(''));
  const manifest = JSON.parse(s.exported.json);
  for (const file of manifest.files)
    if (file.path !== 'work.json')
      await upload(s, readFileSync(join(s.exported.path, file.path)), s.projectId);
  manifest.revision = data.revision;
  manifest.files = manifest.files.map(file =>
    file.path === 'work.json' ? { ...file, sha256: digest(work), size: work.length } : file,
  );
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const tree = buildExchangeRoot(manifestBytes, work, { records: true });
  for (const bytes of tree.objects.values()) await upload(s, bytes, s.projectId);
  // A seed keeps its whole work.json too: whole, or above 1 MiB in chunks behind a recipe.
  if (recipe) {
    const built = buildObjectRecipe(work);
    for (const bytes of built.objects.values()) await upload(s, bytes, s.projectId);
    const recipePin = await upload(s, built.bytes, s.projectId);
    await modules.projectObjectRecipeStore.bind._handler(s.ctx, {
      projectId: s.projectId,
      actor: 'owner',
      digest: digest(work),
      size: work.length,
      recipeDigest: recipePin.sha256,
      recipeSize: recipePin.size,
    });
  } else await upload(s, work, s.projectId);
  const root = await upload(s, tree.bytes, s.projectId);
  const backup = s.tables.projectBackups.get(s.backupId);
  Object.assign(backup, {
    transport: 'objects',
    objectManifest: { digest: root.sha256, size: root.size },
    digest: root.sha256,
    size: root.size,
    preview: { ...backup.preview, manifestDigest: digest(manifestBytes), revision: data.revision },
  });
  delete backup.storageId;
  s.files.delete('source');
  const project = s.tables.hostedProjects.get(s.projectId);
  project.work.initialRevision = data.revision;
  if (!rows)
    for (const table of ['projectWorkEvents', 'projectHostedRecordBodies'])
      for (const [id, row] of s.tables[table] ?? [])
        if (row.projectId === s.projectId && row.revision <= data.revision) s.tables[table].delete(id);
  await modules.projectWorkIndexActions.ensure._handler(s.ctx, { projectId: s.projectId, rebuild: true });
  if (imported)
    for (const [id, row] of s.tables.projectWorkRecords)
      if (row.collection === 'events' && row.key === reported.operationId)
        s.tables.projectWorkRecords.delete(id);
  // With the rows kept the journal is unchanged and the rebuild keeps its generation: it starts at the base now.
  for (const generation of s.tables.projectWorkGenerations.values())
    generation.initialRevision = data.revision;
  s.tables.abuseReports ??= new Map();
  s.tables.boardAudit ??= new Map();
  const report = (id, target) => {
    s.tables.abuseReports.set(id, {
      _id: id,
      _creationTime: 1,
      operationId: randomUUID(),
      reporter: 'reporter',
      kind: 'comment',
      projectId: s.projectId,
      itemId: item.itemId,
      targetId: target.operationId,
      subject: 'owner',
      excerpt: 'Spam',
      reason: 'Spam',
      status: 'open',
      at: 1,
    });
    return { reportId: id, action: 'purge', reason: 'Spam', operationId: randomUUID() };
  };
  const review = report('report-1', reported),
    otherReview = report('report-2', other);
  return { s, itemId: item.itemId, kept, reported, other, review, otherReview, root, tree, data };
}
