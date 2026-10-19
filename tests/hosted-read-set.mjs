// SPDX-License-Identifier: Apache-2.0
// Conservative local model of Convex document and indexed-range dependencies.
export function trackReadSets(ctx, tables) {
  let reading = null;
  const writes = [];
  const { get, query, patch, insert, replace } = ctx.db;
  const tableFor = id => Object.entries(tables).find(([, rows]) => rows.has(id))?.[0];
  ctx.db.get = async id => {
    reading?.push(row => row._id === id);
    return get(id);
  };
  ctx.db.query = table => {
    const result = query(table),
      predicates = [];
    const withIndex = result.withIndex;
    result.withIndex = (index, build) =>
      withIndex(index, q => {
        const proxy = new Proxy(q, {
          get(target, key) {
            return (field, value) => {
              predicates.push(row =>
                key === 'eq'
                  ? row[field] === value
                  : key === 'gt'
                    ? row[field] > value
                    : key === 'gte'
                      ? row[field] >= value
                      : key === 'lt'
                        ? row[field] < value
                        : row[field] <= value,
              );
              target[key](field, value);
              return proxy;
            };
          },
        });
        build(proxy);
      });
    reading?.push(row => row.table === table && predicates.every(test => test(row)));
    return result;
  };
  ctx.db.insert = async (table, value) => {
    const id = await insert(table, value);
    writes.push({ ...value, table, _id: id });
    return id;
  };
  ctx.db.patch = async (id, value) => {
    const table = tableFor(id);
    writes.push({ ...tables[table].get(id), table });
    await patch(id, value);
    writes.push({ ...tables[table].get(id), table });
  };
  ctx.db.replace = async (id, value) => {
    const table = tableFor(id);
    writes.push({ ...tables[table].get(id), table });
    await replace(id, value);
    writes.push({ ...tables[table].get(id), table });
  };
  return {
    async subscribe(fn) {
      reading = [];
      await fn();
      const captured = reading;
      reading = null;
      return captured;
    },
    reset() {
      writes.length = 0;
    },
    invalidated(dependencies) {
      return dependencies.filter(set => set.some(test => writes.some(test))).length;
    },
  };
}
