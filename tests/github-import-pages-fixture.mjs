import { getFunctionName, makeFunctionReference } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const modules = Object.fromEntries(
  await Promise.all(
    [
      'projectGithubImportInventory',
      'projectGithubImportBatch',
      'projectGithubImportPublication',
      'projectGithubImportStore',
      'projectGithubImportWorker',
      'projectGithubImport',
    ].map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))]),
  ),
);
/** The regular fixture deliberately scans Maps. This fixture models the two
 * provider indexes used per source row so the scale test exercises real handlers
 * without O(N²) fake-database overhead. No clone, source files or network. */
export function pagedFixture() {
  const s = state([]),
    baseQuery = s.ctx.db.query,
    insert = s.ctx.db.insert;
  const inventories = new Map(),
    own = new Map(),
    shared = new Map();
  let documentsRead = 0,
    documentsWritten = 0,
    maxCursorBytes = 0,
    maxPayloadBytes = 0;
  s.ctx.db.insert = async (table, row) => {
    const id = await insert(table, row);
    documentsWritten++;
    if (table === 'projectGithubImportInventory') {
      const key = `${row.jobId}:${row.part}`;
      if (!inventories.has(key)) inventories.set(key, new Map());
      inventories.get(key).set(row.key, id);
    }
    if (table === 'projectObjects') {
      own.set(`${row.projectId}:${row.digest}`, id);
      if (!shared.has(row.digest)) shared.set(row.digest, []);
      shared.get(row.digest).push(id);
    }
    return id;
  };
  const patch = s.ctx.db.patch;
  s.ctx.db.patch = async (id, values) => {
    documentsWritten++;
    if (values.cursor) maxCursorBytes = Math.max(maxCursorBytes, Buffer.byteLength(values.cursor));
    return patch(id, values);
  };
  s.ctx.db.query = table => {
    if (!['projectGithubImportInventory', 'projectObjects'].includes(table)) return baseQuery(table);
    const terms = [],
      q = {};
    for (const op of ['eq', 'gt', 'gte', 'lt', 'lte'])
      q[op] = (key, value) => {
        terms.push({ op, key, value });
        return q;
      };
    let index;
    const eq = key => terms.find(t => t.op === 'eq' && t.key === key)?.value;
    const matches = row =>
      terms.every(({ op, key, value }) =>
        op === 'eq'
          ? row[key] === value
          : op === 'gt'
            ? row[key] > value
            : op === 'gte'
              ? row[key] >= value
              : op === 'lt'
                ? row[key] < value
                : row[key] <= value,
      );
    const rows = () => {
      let ids;
      if (table === 'projectObjects')
        ids =
          index === 'by_project_and_digest'
            ? [own.get(`${eq('projectId')}:${eq('digest')}`)].filter(Boolean)
            : (shared.get(eq('digest')) ?? []);
      else {
        const group = inventories.get(`${eq('jobId')}:${eq('part')}`) ?? new Map();
        ids = eq('key') !== undefined ? [group.get(eq('key'))].filter(Boolean) : [...group.values()];
      }
      const result = ids.map(id => s.tables[table].get(id)).filter(matches);
      const field = index?.endsWith('position') ? 'position' : 'key';
      return result.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0));
    };
    const result = {
      withIndex: (name, build) => {
        index = name;
        build(q);
        return result;
      },
      unique: async () => {
        const found = rows();
        assertUnique(found);
        documentsRead += found.length;
        return structuredClone(found[0] ?? null);
      },
      take: async n => {
        const found = rows().slice(0, n);
        documentsRead += found.length;
        return structuredClone(found);
      },
    };
    result[Symbol.asyncIterator] = async function* () {
      for (const row of rows()) {
        documentsRead++;
        yield structuredClone(row);
      }
    };
    return result;
  };
  const original = s.ctx.runQuery;
  const calls = new Map();
  for (const method of ['runQuery', 'runMutation', 'runAction'])
    s.ctx[method] = async (ref, args) => {
      const name = getFunctionName(ref),
        [module, fn] = name.split(':');
      calls.set(name, (calls.get(name) ?? 0) + 1);
      maxPayloadBytes = Math.max(maxPayloadBytes, Buffer.byteLength(JSON.stringify(args)));
      return modules[module] ? modules[module][fn]._handler(s.ctx, args) : original(ref, args);
    };
  return {
    ...s,
    modules,
    calls,
    stats: () => ({ documentsRead, documentsWritten, maxCursorBytes, maxPayloadBytes }),
    worker: id =>
      s.ctx.runAction(makeFunctionReference('projectGithubImportWorker:run'), { id, actor: 'owner' }),
  };
}
function assertUnique(rows) {
  if (rows.length > 1) throw Error('Synthetic index uniqueness violated');
}
