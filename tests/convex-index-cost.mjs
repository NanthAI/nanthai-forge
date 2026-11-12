// SPDX-License-Identifier: Apache-2.0
// Custom database indexes only; system/search indexes are unchanged. Key bytes
// are a reproducible JSON payload model, not provider storage/B-tree overhead.
export const indexEntriesPerWrite = (schema, table) => schema.tables[table]?.export().indexes.length ?? 0;
export function indexStorage(schema, tables) {
  let entries = 0,
    keyBytes = 0;
  for (const [table, rows] of Object.entries(tables)) {
    const indexes = schema.tables[table]?.export().indexes ?? [];
    for (const row of rows.values())
      for (const index of indexes) {
        const values = index.fields.map(field => field.split('.').reduce((v, key) => v?.[key], row));
        // Normalize the synthetic creation clock, as the document-storage fixture does.
        const key = [...values, 0, row._id];
        entries++;
        keyBytes += Buffer.byteLength(JSON.stringify(key));
      }
  }
  return { entries, keyBytes };
}

// The controller ledger deliberately excludes provider dispatch. Measure one
// real, metadata-only Actions export claim for each check as a separate floor:
// later lease/export/dispatch updates also write the same index entry.
export async function measureIndexExportClaims(f) {
  const { moduleUrl } = await import('./convex-module.mjs');
  const actions = await import(moduleUrl('../convex/projectHostedActions.ts'));
  const pass = f.rawChecks.pass;
  f.rawChecks.pass = async run => {
    const result = JSON.parse(
      await f.tx('fixtureIndexExportClaim', actions.control, {
        projectId: f.projectId,
        runId: run.id,
        command: JSON.stringify({ kind: 'claim', owner: '00000000-0000-4000-8000-000000000001' }),
      }),
    );
    if (!result.acquired) throw Error('Fixture export claim was not acquired');
    return pass(run);
  };
}
