// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { CatalogObject, ObjectView } from './projectObjectFind';
import { r2ObjectKey } from './r2';
import { packHeaders, packRange } from '../src/object-pack-range';
import { invariant } from '../src/errors';

/** Points and original-upload receipts use the same complete binding codec. */
export function pointObject(
  row: Doc<'projectObjectReceipts'>,
  projectId: Id<'hostedProjects'>,
  digest: string,
): CatalogObject {
  const binding = row.sourceBinding;
  invariant(
    row.projectId === projectId &&
      row.value === digest &&
      /^[a-f0-9]{64}$/.test(digest) &&
      binding &&
      Number.isSafeInteger(row.size) &&
      row.size! >= 0,
    'SOURCE_HASH_MISMATCH',
    'Stored source point binding differs from its identity.',
  );
  const base = {
    projectId,
    digest,
    size: row.size!,
    nonce: row.nonce ?? '',
    removed: false,
    sourceReferenced: true,
    ...(row.stateGeneration === undefined ? {} : { stateGeneration: row.stateGeneration }),
    ...(row.stateSize === undefined ? {} : { stateSize: row.stateSize }),
  };
  if ('r2Key' in binding) {
    invariant(
      r2ObjectKey(projectId, binding.r2Key)?.digest === (binding.pack?.digest ?? digest),
      'SOURCE_HASH_MISMATCH',
      'Stored source point has a different project key.',
    );
    if (binding.pack) packHeaders(packRange(binding), base.size);
    return { ...base, location: 'r2', r2Committed: true, ...binding };
  }
  invariant(
    /^[a-f0-9]{64}$/.test(binding.recipe.digest) &&
      Number.isSafeInteger(binding.recipe.size) &&
      binding.recipe.size >= 0,
    'SOURCE_HASH_MISMATCH',
    'Stored source point recipe differs from its pin.',
  );
  return { ...base, recipe: binding.recipe };
}
export function pointBinding(row: ObjectView): NonNullable<Doc<'projectObjectReceipts'>['sourceBinding']> {
  invariant(
    !row.removed && row.sourceReferenced && (row.recipe || (row.r2Committed && row.r2Key)),
    'SOURCE_UNAVAILABLE',
    'Publish only complete immutable source bindings.',
  );
  const sourceBinding = row.recipe
    ? { recipe: row.recipe }
    : { r2Key: row.r2Key!, ...(row.pack ? { pack: row.pack } : {}) };
  pointObject(
    {
      projectId: row.projectId,
      value: row.digest,
      size: row.size,
      sourceBinding,
    } as Doc<'projectObjectReceipts'>,
    row.projectId,
    row.digest,
  );
  return sourceBinding;
}
