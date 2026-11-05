// SPDX-License-Identifier: Apache-2.0
/** Serialized into the read-only Convex sandbox; hashes leave it, row values do not. */
export async function benchPage(ctx, table, projectId, index, cursor) {
  let page;
  if (table === 'hostedProjects') {
    const root = await ctx.db.get(projectId);
    page = { page: root ? [root] : [], isDone: true, continueCursor: '' };
  } else {
    let q = ctx.db.query(table);
    if (index) q = q.withIndex(index, q => q.eq('projectId', projectId));
    page = await q.order('asc').paginate({ cursor, numItems: 1000, maximumBytesRead: 4_000_000 });
  }
  const rows = [];
  let scannedJsonBytes = 0;
  for (const row of page.page) {
    const json = JSON.stringify(row),
      bytes = new TextEncoder().encode(json);
    scannedJsonBytes += bytes.length;
    const owner = table === 'hostedProjects' ? row._id : row.projectId;
    if (owner !== projectId) {
      if (index) throw Error('BENCH_OWNER_CHANGED');
      continue;
    }
    if (table === 'hostedProjects' && row.removal !== 'deleted') throw Error('BENCH_PROJECT_NOT_DELETED');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    rows.push({
      id: row._id,
      ownerProjectId: owner,
      bytes: bytes.length,
      sha256: Array.from(hash)
        .map(b => b.toString(16).padStart(2, '0'))
        .join(''),
    });
  }
  return {
    rows,
    scannedDocuments: page.page.length,
    scannedJsonBytes,
    isDone: page.isDone,
    cursor: page.continueCursor,
  };
}
