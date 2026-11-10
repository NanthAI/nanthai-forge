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

// Documents and bytes one query reads, sized as Convex stores them: every id (the fixture's `row-N`
// and the project's) as 32 characters and every number as 8 bytes, so a page's cost does not depend
// on how many rows the fixture created before it.
const documentBytes = row =>
  JSON.stringify(row, (_, value) =>
    typeof value === 'number'
      ? 'n'.repeat(6)
      : typeof value === 'string' && /^row-\d+$|^project$/.test(value)
        ? 'i'.repeat(32)
        : value,
  ).length;

export function meterReads(ctx) {
  const { get, query } = ctx.db;
  const total = { documents: 0, bytes: 0 };
  const count = rows => {
    for (const row of rows)
      if (row) {
        total.documents++;
        total.bytes += documentBytes(row);
      }
  };
  ctx.db.get = async id => {
    const row = await get(id);
    count([row]);
    return row;
  };
  ctx.db.query = table => {
    const wrap = target =>
      new Proxy(target, {
        get(object, key) {
          const value = object[key];
          if (key === 'withIndex' || key === 'order' || key === 'filter')
            return (...args) => wrap(value.apply(object, args));
          if (key === 'paginate')
            return async (...args) => {
              const page = await value.apply(object, args);
              count(page.page);
              return page;
            };
          if (key === 'take' || key === 'collect')
            return async (...args) => {
              const rows = await value.apply(object, args);
              count(rows);
              return rows;
            };
          if (key === 'unique' || key === 'first')
            return async (...args) => {
              const row = await value.apply(object, args);
              count([row]);
              return row;
            };
          if (key === Symbol.asyncIterator)
            return async function* () {
              for await (const row of object) {
                count([row]);
                yield row;
              }
            };
          return typeof value === 'function' ? value.bind(object) : value;
        },
      });
    return wrap(query(table));
  };
  return {
    /** What `read` costs, as { documents, bytes }. */
    async cost(read) {
      Object.assign(total, { documents: 0, bytes: 0 });
      await read();
      return { ...total };
    },
    restore() {
      Object.assign(ctx.db, { get, query });
    },
  };
}

// Synthetic transaction I/O, using the same document sizing as the page meter. No extra db.get is
// inserted into the measured path: fixture tables identify each written document after its write.
export function meterWorkIO(ctx, tables) {
  const reads = meterReads(ctx);
  const methods = Object.fromEntries(
    ['insert', 'patch', 'replace', 'delete'].map(name => [name, ctx.db[name]]),
  );
  let writeDocuments = 0,
    writeBytes = 0,
    migrationWrites = 0;
  for (const [name, method] of Object.entries(methods))
    ctx.db[name] = async (...args) => {
      const result = await method(...args);
      const id = name === 'insert' ? result : args[0];
      const row = Object.values(tables)
        .find(rows => rows.has(id))
        ?.get(id);
      writeDocuments++;
      if (row) {
        writeBytes += documentBytes(row);
        if (row.collection?.startsWith('_workStore')) migrationWrites++;
      }
      return result;
    };
  return {
    async cost(write) {
      writeDocuments = writeBytes = migrationWrites = 0;
      const { documents: readDocuments, bytes: readBytes } = await reads.cost(write);
      return { readDocuments, readBytes, writeDocuments, writeBytes, migrationWrites };
    },
    restore() {
      reads.restore();
      Object.assign(ctx.db, methods);
    },
  };
}
