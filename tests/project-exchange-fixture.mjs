import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { digest } from '../dist/hash.js';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { prepareNativeExchange } from '../dist/native-exchange.js';
import { ownerDerivedBytes } from '../dist/owner-derived-local.js';
import { ownerDerivedPages } from '../dist/owner-derived-pages.js';
import { buildExchangeRoot } from '../dist/native-exchange-tree.js';
import { buildWorkRecords, recordBytes } from '../dist/work-exchange-records.js';
import { sourceManifestSchema, archiveChannels } from '../dist/work-archive-metadata.js';
import { validateParsedWork } from '../dist/work-metadata.js';
import { buildSeedPages, SEED_EMPTY } from '../dist/hosted-seed-protocol.js';
const names = [
  'projectCheckLogRetentionActions',
  'projectCheckLogRetention',
  'projectCheckLogCleanupStore',
  'projectCheckLogCleanup',
  'projectHostedLogCleanupStore',
  'projectObjects',
  'projectObjectCommit',
  'projectObjectDownloads',
  'projectObjectRecipes',
  'projectObjectRecipeStore',
  'projectMain',
  'projectObjectValidation',
  'projectExchange',
  'projectPublicationAttempt',
  'projectPublicationStore',
  'projectPublicationProgress',
  'projectExchangeActions',
  'projectBackups',
  'projectWork',
  'projectWorkActions',
  'projectWorkJournal',
  'projectSourceReturn',
  'projectReturnSupersede',
  'projectDiffstats',
];
export const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
export function fixture() {
  const s = state([]),
    run = s.ctx.runQuery;
  for (const table of [
    'projectCheckLogCleanups',
    'projectCheckLogCleanupPages',
    'projectCheckLogRetentions',
    'projectHostedStates',
    'projectHostedOutputStreams',
    'projectHostedCheckRuns',
    'projectHostedOutputSummaries',
  ])
    s.tables[table] ??= new Map();
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic exchange',
    currentBackup: null,
    revision: 0,
  });
  s.ctx.storage.generateUploadUrl = async () => 'https://fixture.invalid/upload';
  s.ctx.runAction =
    s.ctx.runQuery =
    s.ctx.runMutation =
      (ref, args) => {
        const [name, method] = getFunctionName(ref).split(':');
        return modules[name] ? modules[name][method]._handler(s.ctx, args) : run(ref, args);
      };
  return s;
}
export async function upload(s, bytes, projectId = 'project') {
  const pin = { sha256: digest(bytes), size: bytes.length };
  const prepared = await modules.projectObjects.prepare._handler(s.ctx, {
    projectId,
    digest: pin.sha256,
    size: pin.size,
  });
  if (!prepared.stored) {
    const storageId = await s.ctx.storage.store(new Blob([bytes], { type: prepared.contentType }));
    await modules.projectObjects.complete._handler(s.ctx, { id: prepared.id, storageId });
  }
  return pin;
}
export async function checkpoint(t, s, additionalObjects = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-publication-')),
    root = join(dir, 'owner');
  mkdirSync(root);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  initNative(root);
  return preparedCheckpoint(s, new WorkStore(root), additionalObjects);
}
export async function preparedCheckpoint(s, store, additionalObjects = 0, baselineKey, recordOptions = {}) {
  const operationId = randomUUID(),
    prepared = await prepareNativeExchange(store, store.revision(), operationId, false, baselineKey);
  for (const file of prepared.manifest.files.filter(
    file => (!recordOptions.records && recordOptions.logicalWork !== false) || file.path !== 'work.json',
  ))
    await upload(
      s,
      readFileSync(join(file.path === 'work.json' ? prepared.directory : store.directory, file.path)),
    );
  for (let i = 0; i < additionalObjects; i++) {
    const pin = await upload(s, Buffer.from(`retained content ${i}`));
    prepared.manifest.files.push({ path: `objects/${pin.sha256}`, ...pin });
  }
  const manifest = Buffer.from(JSON.stringify(prepared.manifest)),
    work = readFileSync(join(prepared.directory, 'work.json')),
    tree = buildExchangeRoot(manifest, work, recordOptions);
  for (const bytes of tree.objects.values()) await upload(s, bytes);
  const pin = await upload(s, tree.bytes);
  const derived = ownerDerivedPages(readFileSync(join(prepared.directory, 'owner-derived.json')));
  for (const page of derived.objects.values()) await upload(s, page);
  const ownerDerived = await upload(s, derived.root);
  return {
    input: {
      projectId: 'project',
      operationId,
      previous: null,
      digest: pin.sha256,
      size: pin.size,
      displayProtocol: 3,
      ownerDerived,
    },
    tree,
    manifest: prepared.manifest,
    store,
  };
}

const displayObjectContexts = new WeakSet();
/** Current archive fixtures retain their exact archive bytes and supply the same
 * local display facts as a current native CLI. Source access assertions stay unchanged. */
export async function currentOwnerDisplay(s, store, data = store.load(), projectId = 'project') {
  if (!store.native) return { displayProtocol: 3 };
  if (!displayObjectContexts.has(s.ctx)) {
    displayObjectContexts.add(s.ctx);
    s.ctx.storage.generateUploadUrl ??= async () => 'https://fixture.invalid/upload';
    for (const method of ['runQuery', 'runMutation', 'runAction']) {
      const run = s.ctx[method];
      s.ctx[method] = (ref, args) => {
        const [name, action] = getFunctionName(ref).split(':');
        return name.startsWith('projectObject') && modules[name]?.[action]
          ? modules[name][action]._handler(s.ctx, args)
          : run(ref, args);
      };
    }
  }
  const pages = ownerDerivedPages(ownerDerivedBytes(store, data));
  for (const bytes of pages.objects.values()) await upload(s, bytes, projectId);
  return { displayProtocol: 3, ownerDerived: await upload(s, pages.root, projectId) };
}

/** Drive the real paged hosted seed for a prepared record checkpoint. */
export async function seedRecordCheckpoint(s, prepared) {
  for (const name of ['projectHostedSeed', 'projectHostedSeedActions'])
    modules[name] ??= await import(moduleUrl(`../convex/${name}.ts`));
  for (const table of ['projectHostedSeeds', 'projectHostedSeedPages', 'projectHostedChannels'])
    s.tables[table] ??= new Map();
  const work = readFileSync(
    join(prepared.store.directory, `exchange-${prepared.input.operationId}`, 'work.json'),
  );
  const data = JSON.parse(work),
    catalog = buildWorkRecords(data);
  const records = new Map();
  for (const field of catalog.root.fields)
    if ('records' in field)
      for (const record of field.records) {
        const refs = records.get(record.sha256) ?? [];
        refs.push({ collection: field.name, key: record.key, format: data.schema });
        records.set(record.sha256, refs);
      }
  const entries = [];
  for (const row of s.tables.projectObjects.values()) {
    if (row.projectId !== 'project' || !row.storageId) continue;
    const bytes = Buffer.from(await (await s.ctx.storage.get(row.storageId)).arrayBuffer());
    let state = false;
    try {
      state = JSON.parse(bytes).kind === 'forge-source-state';
    } catch {}
    entries.push({
      sha256: row.digest,
      size: row.size,
      kind: state ? 'state' : 'metadata',
      ...(records.has(row.digest) ? { records: records.get(row.digest) } : {}),
    });
  }
  entries.sort((a, b) => a.sha256.localeCompare(b.sha256));
  const { pages, chain } = buildSeedPages(entries);
  const pin = sha256 => {
    const row = [...s.tables.projectObjects.values()].find(row => row.digest === sha256);
    return { sha256, size: row.size };
  };
  const moves = data.channelMoves.filter(m => m.channel === 'main' && m.status === 'accepted');
  const receipt = moves.at(-1),
    head = receipt?.head ?? data.nativeHead;
  const request = {
    schema: 1,
    operationId: prepared.input.operationId,
    revision: data.revision,
    sourceHead: prepared.manifest.head,
    format: 'native',
    head,
    main: pin(head),
    receipt: receipt ? pin(digest(recordBytes(receipt))) : null,
    receiptId: receipt?.id ?? null,
    previousHead: receipt?.previous ?? null,
    previousReceiptId: moves.at(-2)?.id ?? null,
    work: { sha256: prepared.tree.root.work.sha256, size: prepared.tree.root.work.size },
    manifest: { sha256: prepared.tree.root.manifest.sha256, size: prepared.tree.root.manifest.size },
    root: { sha256: prepared.input.digest, size: prepared.input.size },
    recovery: pin(head),
    pages: pages.length,
    objects: entries.length,
    chain,
    preview: {
      intents: data.intents.length,
      lanes: data.lanes.length,
      views: data.views.length,
      runs: data.runs.length,
      files: prepared.manifest.files.length,
      unavailable: prepared.manifest.unavailable.length,
    },
  };
  await modules.projectHostedSeed.begin._handler(s.ctx, {
    projectId: 'project',
    request: JSON.stringify(request),
  });
  let previous = SEED_EMPTY;
  for (const [index, page] of pages.entries()) {
    const progress = JSON.parse(
      await modules.projectHostedSeedActions.stage._handler(s.ctx, {
        projectId: 'project',
        operationId: request.operationId,
        index,
        body: JSON.stringify(page),
        previous,
      }),
    );
    previous = progress.chain;
  }
  return JSON.parse(
    await modules.projectHostedSeedActions.finish._handler(s.ctx, {
      projectId: 'project',
      operationId: request.operationId,
    }),
  ).backupId;
}

/** Source-return fixtures supply a fully validated checkpoint, independently of
 * publication's delta budget. No production whole-Work fallback is exercised. */
export async function commitValidatedCheckpoint(s, prepared) {
  const work = readFileSync(
    join(prepared.store.directory, `exchange-${prepared.input.operationId}`, 'work.json'),
  );
  const data = JSON.parse(work);
  validateParsedWork(data);
  const catalog = buildWorkRecords(data, { retainObjects: false });
  if (catalog?.pin.sha256 !== prepared.tree.root.records?.sha256)
    throw new Error('Fixture record catalog differs from validated Work.');
  const manifest = sourceManifestSchema.parse(prepared.manifest);
  const { input } = prepared;
  return modules.projectExchange.publish._handler(s.ctx, {
    ...input,
    owner: 'owner',
    request: digest(
      JSON.stringify([input.projectId, input.operationId, input.previous, input.digest, input.size]),
    ),
    validatedClosure: 1,
    validatedWorkRecords: 1,
    preview: {
      manifestDigest: digest(Buffer.from(JSON.stringify(manifest))),
      head: manifest.head,
      format: 'native',
      revision: data.revision,
      intents: data.intents.length,
      lanes: data.lanes.length,
      views: data.views.length,
      runs: data.runs.length,
      files: manifest.files.length,
      unavailable: manifest.unavailable.length,
      channels: archiveChannels(manifest, data),
    },
  });
}
