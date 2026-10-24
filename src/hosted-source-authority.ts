// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';

export const sourceAuthoritySchema = z
  .object({
    mode: z.enum(['native-owner', 'server-shadow', 'server']),
    epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type SourceAuthority = z.infer<typeof sourceAuthoritySchema>;

/** Missing fields are legacy native authority, regardless of project origin or presence. */
export function sourceAuthority(project: { sourceAuthority?: SourceAuthority }): SourceAuthority {
  return sourceAuthoritySchema.parse(project.sourceAuthority ?? { mode: 'native-owner', epoch: 0 });
}

/** Pure CAS preparation; the caller must persist this with its cutover's source/Work pins. */
export function nextSourceAuthority(
  current: SourceAuthority,
  expected: SourceAuthority,
  mode: SourceAuthority['mode'],
): SourceAuthority {
  current = sourceAuthoritySchema.parse(current);
  expected = sourceAuthoritySchema.parse(expected);
  invariant(
    current.mode === expected.mode && current.epoch === expected.epoch,
    'SOURCE_AUTHORITY_CHANGED',
    'Source authority changed from the expected mode and epoch.',
  );
  return sourceAuthoritySchema.parse({ mode, epoch: current.epoch + 1 });
}

export function requireSourceContract(authority: SourceAuthority, maxSchema = 1): void {
  invariant(
    authority.mode !== 'server' || maxSchema >= 2,
    'CLI_UPGRADE_REQUIRED',
    'Upgrade nforge to read server-owned source with source contract schema 2.',
  );
}
