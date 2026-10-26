// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { CUTOVER_UPGRADE } from './cutover-version.js';

export const sourceAuthoritySchema = z
  .object({
    mode: z.enum(['native-owner', 'server-shadow', 'server']),
    epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type SourceAuthority = z.infer<typeof sourceAuthoritySchema>;

/** Missing fields are legacy native authority, regardless of project origin or presence. */
export function sourceAuthority(project: { sourceAuthority?: SourceAuthority | undefined }): SourceAuthority {
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
  invariant(authority.mode !== 'server' || maxSchema >= 2, 'CLI_UPGRADE_REQUIRED', CUTOVER_UPGRADE);
}

/** Shared in-transaction fence. Legacy callers are pinned to native-owner epoch 0. */
export function requireSourceAuthority(
  project: { sourceAuthority?: SourceAuthority | undefined; sourceCutover?: unknown },
  expected: SourceAuthority = { mode: 'native-owner', epoch: 0 },
): SourceAuthority {
  const current = sourceAuthority(project);
  expected = sourceAuthoritySchema.parse(expected);
  invariant(
    !project.sourceCutover || current.mode !== 'server' || expected.mode !== 'native-owner',
    'CLI_UPGRADE_REQUIRED',
    CUTOVER_UPGRADE,
  );
  if (current.mode !== expected.mode || current.epoch !== expected.epoch)
    throw new SourceAuthorityStaleError(current);
  return current;
}

export class SourceAuthorityStaleError extends ForgeError {
  constructor(readonly authority: SourceAuthority) {
    super(
      'SOURCE_AUTHORITY_STALE',
      `Source authority is ${authority.mode} at epoch ${authority.epoch}. Refresh the authority pin and use its writer; retain the original operation to reconcile its outcome.${authority.mode === 'server' ? ` ${CUTOVER_UPGRADE}` : ''}`,
    );
  }
}
