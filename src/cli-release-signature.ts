// SPDX-License-Identifier: Apache-2.0
// Wire format of signed CLI releases, shared by the CLI and the Convex store (no Node built-ins).
import { z } from 'zod';
export {
  CLI_RELEASE_READ_PROOF_SECONDS,
  cliReleaseReadStatement,
  cliReleaseStatement,
} from './cli-release-statement.js';

/** Rows one State may hold: room for every listed key during a rotation, nothing unbounded. */
export const CLI_RELEASE_SIGNATURES_PER_STATE = 4;
export const cliReleaseStateSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** The release number: increases with every signed release of a project (by default the main
 * State's source revision). The updater refuses a number below the highest it installed. */
export const cliReleaseNumberSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** keyId: first 16 hex of the SHA-256 of the raw 32-byte Ed25519 public key.
 * signature: the 64-byte Ed25519 signature, base64.
 * release: present on v2 signatures (it is part of the signed statement); absent on v1 ones. */
export const cliReleaseSignatureSchema = z
  .object({
    keyId: z.string().regex(/^[a-f0-9]{16}$/),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    release: cliReleaseNumberSchema.optional(),
  })
  .strict();
export type CliReleaseSignature = z.infer<typeof cliReleaseSignatureSchema>;
export const cliReleaseSignaturesSchema = z
  .object({
    head: cliReleaseStateSchema,
    signatures: z.array(cliReleaseSignatureSchema).max(CLI_RELEASE_SIGNATURES_PER_STATE),
  })
  .strict();
