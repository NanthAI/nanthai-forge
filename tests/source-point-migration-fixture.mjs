// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { state, projectRow } from './hosted-fixture.mjs';
import { digest } from '../dist/hash.js';
import { moduleUrl } from './convex-module.mjs';
export const find = await import(moduleUrl('../convex/projectObjectFind.ts'));
export const compact = await import(moduleUrl('../convex/projectObjectCatalogCompact.ts'));
export const commits = await import(moduleUrl('../convex/projectObjectCommit.ts'));
export const objects = await import(moduleUrl('../convex/projectObjects.ts'));
export const nonce = '00000000-0000-4000-8000-000000000001';
export function migrationFixture(count = 402) {
  const s = state([], { keysetPaging: true }),
    projectId = 'project';
  s.tables.hostedProjects.set(projectId, projectRow({ _id: projectId, sourceManifestVersion: 2 }));
  const pack = digest('pack');
  const pins = Array.from({ length: count }, (_, index) => ({
    digest: digest(`sparse-${index}`),
    size: 1024,
    pack: { digest: pack, size: count * 1024, offset: index * 1024 },
  }));
  for (const page of find.catalogPages(pins))
    s.tables.projectObjectCatalog.set(`catalog-${page.first}`, {
      _id: `catalog-${page.first}`,
      _creationTime: 1,
      projectId,
      origin: 'github-import:job',
      ...page,
    });
  const alias = {
    _id: 'original-id',
    _creationTime: 1,
    projectId,
    key: 'original-upload',
    value: pins[0].digest,
    nonce,
    size: 1024,
  };
  s.tables.projectObjectReceipts.set(alias._id, alias);
  let active, beforeDelete;
  const length = value => (value == null ? 0 : Buffer.byteLength(JSON.stringify(value)));
  const read = (table, value) => {
    if (!active) return;
    const rows = Array.isArray(value) ? value : value ? [value] : [];
    active.documents += rows.length;
    assert(active.documents <= 4096, 'Convex per-function document budget');
    active.readBytes += rows.reduce((sum, row) => sum + length(row), 0);
    assert(active.readBytes < 16 * 1024 * 1024, 'Convex per-function read bytes');
    active.reads[table] = (active.reads[table] ?? 0) + rows.length;
  };
  const queryRead = () => {
    if (active) {
      active.queries++;
      assert(active.queries <= 4096, 'Convex per-function query budget, including empty reads');
    }
  };
  const rowFor = id =>
    Object.entries(s.tables)
      .map(([table, rows]) => [table, rows.get(id)])
      .find(([, row]) => row) ?? ['unknown', null];
  const get = s.ctx.db.get;
  s.ctx.db.get = async id => {
    queryRead();
    const value = await get(id);
    read(rowFor(id)[0], value);
    return value;
  };
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    const original = query(table),
      wrapped = { ...original };
    for (const name of ['unique', 'take', 'paginate'])
      wrapped[name] = async (...args) => {
        queryRead();
        const value = await original[name](...args);
        read(table, name === 'paginate' ? value.page : value);
        return value;
      };
    for (const name of ['withIndex', 'order'])
      wrapped[name] = (...args) => {
        original[name](...args);
        return wrapped;
      };
    return wrapped;
  };
  for (const name of ['insert', 'replace', 'patch', 'delete']) {
    const original = s.ctx.db[name];
    s.ctx.db[name] = async (...args) => {
      const [oldTable, old] = name === 'insert' ? [args[0], null] : rowFor(args[0]);
      if (name === 'delete' && oldTable === 'projectObjectCatalog') beforeDelete?.(old);
      const value = await original(...args);
      if (active) {
        active.writes++;
        if (name === 'delete') active.deletedBytes += length(old);
        else active.writeBytes += length(rowFor(name === 'insert' ? value : args[0])[1]);
      }
      return value;
    };
  }
  const measurements = [];
  const run = async fn => {
    const measure = {
      queries: 0,
      documents: 0,
      reads: {},
      readBytes: 0,
      writes: 0,
      writeBytes: 0,
      deletedBytes: 0,
    };
    active = measure;
    try {
      return await s.transaction(() => fn({ ...s.ctx }));
    } finally {
      measurements.push(measure);
      active = undefined;
    }
  };
  const call = (fn, args) => run(ctx => fn._handler(ctx, args));
  const migrate = async (operationId = 'point-original') => {
    let after = null,
      result;
    const steps = [];
    do {
      const input = { projectId, actor: 'owner', operationId, points: true, after };
      const value = await call(compact.step, input);
      steps.push(measurements.at(-1));
      result = JSON.parse(value);
      after = result.after;
      if (steps.length > count + 20) throw new Error('Point migration did not converge');
    } while (!result.done);
    return { result, steps };
  };
  return {
    s,
    projectId,
    pins,
    alias,
    measurements,
    run,
    call,
    migrate,
    beforeDelete: fn => {
      beforeDelete = fn;
    },
  };
}
