// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { setup, client } from './r2-harness.mjs';
import { digest } from '../dist/hash.js';
import { buildObjectRecipe } from '../dist/object-chunks.js';
import { moduleUrl } from './convex-module.mjs';
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const controls = Object.fromEntries(
  await Promise.all(
    [
      'urlProjects',
      'projectHostedAgent',
      'projectHostedChannels',
      'projectHostedStart',
      'projectHostedLanes',
      'projectHostedOverlaps',
    ].map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))]),
  ),
);
export async function rootFixture(t, count = 3, totalBytes = 1024, recipeCount = 1) {
  const h = await setup(t),
    exchange = client(h.s);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-hosted-root-')));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'project'),
    calls = [];
  const put = bytes => {
    const sha256 = digest(bytes),
      key = `v1/p/project/o/${sha256}`;
    h.fake.objects.set(h.fake.key(key), bytes);
    h.s.tables.projectObjects.set(sha256, {
      _id: sha256,
      projectId: 'project',
      digest: sha256,
      size: bytes.length,
      r2Key: key,
      location: 'r2',
      r2Committed: true,
      removed: false,
      nonce: 'synthetic',
    });
    return sha256;
  };
  const files = [];
  const largeSize =
    recipeCount === 1 ? 4 * 1024 * 1024 : Math.floor((totalBytes - (count - recipeCount) * 32) / recipeCount);
  for (let i = 0; i < recipeCount; i++) {
    const large = Buffer.alloc(largeSize, 0x61 + i);
    const logical = digest(large),
      built = buildObjectRecipe(large);
    for (const bytes of built.objects.values()) put(bytes);
    const recipe = put(built.bytes);
    h.s.tables.projectObjects.set(logical, {
      _id: logical,
      projectId: 'project',
      digest: logical,
      size: large.length,
      removed: false,
      nonce: 'synthetic',
      recipe: { digest: recipe, size: built.bytes.length },
    });
    files.push({ path: i === 0 ? 'large.bin' : `large-${i}.bin`, blob: logical, mode: 'file' });
  }
  for (let i = recipeCount; i < count; i++) {
    const bytes = Buffer.alloc(
      Math.max(16, Math.floor((totalBytes - largeSize * recipeCount) / (count - recipeCount))),
      0x62,
    );
    bytes.write(String(i));
    files.push({ path: `src/file-${String(i).padStart(5, '0')}.txt`, blob: put(bytes), mode: 'file' });
  }
  const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files,
        message: 'Synthetic root fixture',
        at: '2026-01-01T00:00:00.000Z',
      }),
    ),
    head = put(bytes);
  const main = {
    schema: 2,
    projectId: 'project',
    snapshotId: 'snapshot',
    sourceRevision: 0,
    channel: 'main',
    head,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: randomUUID(), kind: 'server', previousHead: null, previousReceiptId: null },
  };
  for (const table of Object.keys(schema.tables)) h.s.tables[table] ??= new Map();
  Object.assign(h.s.tables.hostedProjects.get('project'), {
    sourceAuthority: main.authority,
    slug: 'project',
    visibility: 'private',
  });
  h.s.tables.forgeAccounts.set('account', { _id: 'account', owner: 'owner', handle: 'alice' });
  h.s.tables.accountHandles.set('handle', { _id: 'handle', owner: 'owner', handle: 'alice' });
  h.s.tables.projectSlugs.set('slug', { _id: 'slug', owner: 'owner', slug: 'project', projectId: 'project' });
  h.s.tables.projectHostedChannels.set('main', {
    _id: 'main',
    projectId: 'project',
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify(main),
  });
  const baseQuery = exchange.client.query,
    baseMutation = exchange.client.mutation;
  let allowed = true,
    documentsRead = 0,
    documentsWritten = 0;
  const get = h.s.ctx.db.get,
    query = h.s.ctx.db.query;
  h.s.ctx.db.get = (...args) => {
    documentsRead++;
    return get(...args);
  };
  h.s.ctx.db.query = table => {
    if (table === 'projectObjects')
      return {
        withIndex(name, select) {
          assert.equal(name, 'by_project_and_digest');
          const values = new Map();
          const q = {
            eq: (field, value) => {
              values.set(field, value);
              return q;
            },
          };
          select(q);
          return {
            unique: async () => {
              documentsRead++;
              const row = h.s.tables.projectObjects.get(values.get('digest'));
              return row?.projectId === values.get('projectId') ? structuredClone(row) : null;
            },
          };
        },
      };
    const q = query(table),
      unique = q.unique;
    q.unique = (...input) => {
      documentsRead++;
      return unique.apply(q, input);
    };
    return q;
  };
  for (const name of ['insert', 'patch', 'replace', 'delete']) {
    const original = h.s.ctx.db[name];
    if (original)
      h.s.ctx.db[name] = (...args) => {
        documentsWritten++;
        return original(...args);
      };
  }
  const invoke = async (kind, ref, args) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    if (!allowed) throw Object.assign(Error('Current access revoked'), { code: 'PROJECT_UNAVAILABLE' });
    const [module, method] = name.split(':');
    if (controls[module]?.[method]) return controls[module][method]._handler(h.s.ctx, args);
    return (kind === 'query' ? baseQuery : baseMutation)(ref, args);
  };
  exchange.client.query = (ref, args) => invoke('query', ref, args);
  exchange.client.mutation = (ref, args) => invoke('mutation', ref, args);
  return {
    ...h,
    root,
    main,
    files,
    sourceBytes: files.reduce((sum, file) => sum + h.s.tables.projectObjects.get(file.blob).size, 0),
    exchange,
    calls,
    address: { url: 'https://fixture.convex.cloud', projectId: 'project' },
    revoke: () => {
      allowed = false;
    },
    documents: () => ({ read: documentsRead, written: documentsWritten }),
  };
}
