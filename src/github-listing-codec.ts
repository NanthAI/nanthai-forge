// SPDX-License-Identifier: Apache-2.0
import type { GithubListing } from './github-archive-source.js';

const modes = new Set(['100644', '100755', '120000', '160000']);
const gitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** The file table of one commit tree, as the object an archive import job keeps in R2
 * so only its first listing costs GitHub requests. Plain JSON: it parses straight into
 * the entries the importer uses, with no second copy of every row. */
export function encodeListing(tree: string, listing: GithubListing) {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      tree,
      totalBytes: listing.totalBytes,
      submodules: listing.submodules,
      files: listing.files,
    }),
  );
}
/** Null when the bytes are not the table for `tree`: the caller lists again, never trusts them. */
export function decodeListing(bytes: Buffer, tree: string): GithubListing | null {
  let value: Partial<{ schema: unknown; tree: unknown } & GithubListing>;
  try {
    value = JSON.parse(bytes.toString());
  } catch {
    return null;
  }
  if (
    value?.schema !== 1 ||
    value.tree !== tree ||
    !Array.isArray(value.files) ||
    !Number.isSafeInteger(value.totalBytes) ||
    !Number.isSafeInteger(value.submodules)
  )
    return null;
  for (const file of value.files)
    if (
      typeof file?.path !== 'string' ||
      !gitId.test(file.sha) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !modes.has(file.mode)
    )
      return null;
  return value as GithubListing;
}
