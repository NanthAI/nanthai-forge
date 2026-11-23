// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import schema from './schema';
import { projectPurgeTables, purgeIndex, type ProjectPurgeTable } from './projectPurgeInventory';
import { invariant } from '../src/errors';

/** Ownership only: nested generation references in import/receipt records are
 * references, not ownership, and must never make those records purge candidates. */
export function storageOwners() {
  return Object.entries(schema.tables).flatMap(([table, definition]) => {
    const variants =
      definition.validator.kind === 'union' ? definition.validator.members : [definition.validator];
    const [fields, ...otherFields] = variants.map(
      variant =>
        (variant.kind === 'object' ? variant.fields : {}) as Record<
          string,
          { kind: string; tableName?: string }
        >,
    );
    return Object.entries(fields ?? {}).flatMap(([field, validator]) => {
      const parent = validator.kind === 'id' ? validator.tableName : undefined;
      if (
        !(
          (field === 'projectId' && parent === 'hostedProjects') ||
          (parent === 'projectWorkGenerations' && (field === 'generationId' || field === 'partitionId'))
        ) ||
        otherFields.some(fields => fields[field]?.kind !== 'id' || fields[field]?.tableName !== parent)
      )
        return [];
      const index = definition[' indexes']().find(item => item.fields[0] === field)?.indexDescriptor;
      invariant(index, 'BAD_ARGUMENT', `Storage owner ${table}.${field} needs an owner-first index.`);
      return [{ table, field, parent: parent!, index }];
    });
  });
}

export function storageOwner(table: string, field: string) {
  const owner = storageOwners().find(item => item.table === table && item.field === field);
  invariant(owner, 'BAD_ARGUMENT', 'Select an indexed project or Work-generation owner.');
  return owner;
}

export function projectOwnedScope(table: string, row: Record<string, unknown>) {
  if (!(table in projectPurgeTables)) return false;
  const scope = purgeIndex(table as ProjectPurgeTable).scope;
  return scope === undefined || row.scope === scope;
}
