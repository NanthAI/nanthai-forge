// SPDX-License-Identifier: Apache-2.0
/** Serialized into Convex's sandboxed read-only inline-query runtime. No imports,
 * network, writes, per-reference gets, or repository code evaluation. */
export async function auditPage(ctx, table, cursor, numItems = 512, idLengths = null) {
  const query = table === '_storage' ? ctx.db.system.query(table) : ctx.db.query(table);
  const result = await query.order('asc').paginate({ cursor, numItems, maximumBytesRead: 4_000_000 });
  const references = [],
    projects = [],
    groups = {};
  let jsonBytes = 0;
  const encoder = new TextEncoder();
  const bytes = value => encoder.encode(JSON.stringify(value)).byteLength;
  for (const row of result.page) {
    const size = bytes(row);
    jsonBytes += size;
    const project =
      row.projectId ??
      (table === 'hostedProjects' ? row._id : row.importId ? `import:${row.importId}` : 'unattributed');
    const group = (groups[project] ??= { documents: 0, jsonBytes: 0 });
    group.documents++;
    group.jsonBytes += size;
    if (table === 'hostedProjects')
      projects.push({ id: row._id, name: row.name, removal: row.removal ?? null, revision: row.revision });
    if (table === '_storage') continue;
    const walk = (value, path, parent) => {
      if (typeof value === 'string') {
        // Lengths come from every present _storage ID, never an assumed ID format.
        const id =
          idLengths === null || idLengths.includes(value.length)
            ? ctx.db.system.normalizeId('_storage', value)
            : null;
        if (id)
          references.push({
            storageId: id,
            table,
            document: row._id,
            project,
            field: path,
            digest: parent.digest ?? parent.sha256 ?? null,
            size: parent.size ?? null,
            r2Key: parent.r2Key ?? null,
            location: parent.location ?? null,
            committed: parent.r2Committed ?? false,
          });
        // Some legacy source outputs/cursors are JSON stored inside string fields.
        else if (/^\s*[\[{]/.test(value)) {
          let parsed;
          try {
            parsed = JSON.parse(value);
          } catch {
            return; /* ordinary text */
          }
          walk(parsed, `${path}#json`, parsed);
        }
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (key !== '_id') walk(child, path ? `${path}.${key}` : key, value);
        }
      }
    };
    walk(row, '', row);
  }
  return {
    cursor: result.continueCursor,
    isDone: result.isDone,
    documents: result.page.length,
    jsonBytes,
    groups,
    references,
    projects,
    storage: table === '_storage' ? result.page : [],
  };
}
export function pageSource(table, cursor, numItems, idLengths = null) {
  if (
    !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(table) ||
    !Number.isSafeInteger(numItems) ||
    numItems < 1 ||
    numItems > 1024
  )
    throw new Error('AUDIT_ARGUMENT_INVALID');
  return `return await (${auditPage.toString()})(ctx,${JSON.stringify(table)},${JSON.stringify(cursor)},${numItems},${JSON.stringify(idLengths)});`;
}
