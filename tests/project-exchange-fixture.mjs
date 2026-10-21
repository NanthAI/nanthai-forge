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
const names = [
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
  'projectExchangeActions',
  'projectBackups',
  'projectWork',
  'projectWorkActions',
  'projectWorkJournal',
  'projectSourceReturn',
  'projectDiffstats',
];
export const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
export function fixture() {
  const s = state([]),
    run = s.ctx.runQuery;
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
