// SPDX-License-Identifier: Apache-2.0
/** Read-only history projection. Prefix filtering bounds the inline-query input;
 * the operator joins full digests afterwards, so prefix collisions prove nothing. */
export async function attributionPage(ctx, table, cursor, prefixes, hours) {
  const page = await ctx.db
    .query(table)
    .order('asc')
    .paginate({ cursor, numItems: 1024, maximumBytesRead: 4_000_000 });
  const matches = [],
    history = {};
  let jsonBytes = 0;
  for (const row of page.page) {
    const json = JSON.stringify(row);
    jsonBytes += new TextEncoder().encode(json).length;
    const project =
      row.projectId ??
      (table === 'hostedProjects' ? row._id : row.importId ? `import:${row.importId}` : 'unattributed');
    const hour = Math.floor(row._creationTime / 3600000);
    if (hours.includes(hour)) {
      const key = JSON.stringify([project, hour]);
      history[key] = (history[key] ?? 0) + 1;
    }
    const hashes = new Set(json.match(/\b[a-f0-9]{64}\b/g) ?? []);
    for (const hash of hashes) {
      const prefix = parseInt(hash.slice(0, 4), 16);
      if (parseInt(prefixes[Math.floor(prefix / 4)], 16) & (1 << (prefix % 4)))
        matches.push({ sha256: hash, table, document: row._id, project, createdAt: row._creationTime });
    }
  }
  return {
    cursor: page.continueCursor,
    isDone: page.isDone,
    documents: page.page.length,
    jsonBytes,
    matches,
    history,
  };
}
export function attributionFilter(files) {
  const bits = Array(16384).fill(0),
    hours = new Set();
  for (const file of files) {
    const prefix = parseInt(file.digest.slice(0, 4), 16);
    bits[Math.floor(prefix / 4)] |= 1 << (prefix % 4);
    hours.add(Math.floor(file.createdAt / 3600000));
  }
  return { prefixes: bits.map(n => n.toString(16)).join(''), hours: [...hours] };
}
export function attributionSummary(files, matches) {
  const owners = new Map();
  for (const row of matches) {
    const refs = owners.get(row.sha256) ?? [];
    refs.push(row);
    owners.set(row.sha256, refs);
  }
  const groups = {},
    projects = {},
    sizePatterns = {};
  let linked = 0,
    linkedBytes = 0;
  for (const file of files) {
    const key = `${new Date(file.createdAt).toISOString().slice(0, 10)} ${file.contentType ?? 'unknown'}`;
    const group = (groups[key] ??= { files: 0, bytes: 0, minSize: Infinity, maxSize: 0, linked: 0 });
    group.files++;
    group.bytes += file.bytes;
    group.minSize = Math.min(group.minSize, file.bytes);
    group.maxSize = Math.max(group.maxSize, file.bytes);
    const size = (sizePatterns[file.bytes] ??= { files: 0, bytes: 0 });
    size.files++;
    size.bytes += file.bytes;
    const refs = owners.get(file.digest) ?? [];
    if (refs.length) {
      linked++;
      linkedBytes += file.bytes;
      group.linked++;
    }
    for (const project of new Set(refs.map(r => r.project))) {
      const p = (projects[project] ??= { files: 0, bytes: 0, tables: {} });
      p.files++;
      p.bytes += file.bytes;
      for (const table of new Set(refs.filter(r => r.project === project).map(r => r.table)))
        p.tables[table] = (p.tables[table] ?? 0) + 1;
    }
  }
  return {
    files: files.length,
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    digestLinkedFiles: linked,
    digestLinkedBytes: linkedBytes,
    withoutDigestLink: files.length - linked,
    groups,
    projects,
    commonSizes: Object.entries(sizePatterns)
      .sort((a, b) => b[1].files - a[1].files)
      .slice(0, 20),
    interpretation:
      'Digest appearances establish retained history links, not ownership or deletion permission. Creation-time coincidence and size patterns are circumstantial. No file bodies were downloaded or deleted.',
  };
}
