// SPDX-License-Identifier: Apache-2.0
// Wire format of signed CLI releases, shared by the CLI and the Convex store (no Node built-ins).
import { z } from 'zod';

/** Rows one State may hold: room for every listed key during a rotation, nothing unbounded. */
export const CLI_RELEASE_SIGNATURES_PER_STATE = 4;
export const cliReleaseStateSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** keyId: first 16 hex of the SHA-256 of the raw 32-byte Ed25519 public key.
 * signature: the 64-byte Ed25519 signature, base64. */
export const cliReleaseSignatureSchema = z
  .object({
    keyId: z.string().regex(/^[a-f0-9]{16}$/),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
export type CliReleaseSignature = z.infer<typeof cliReleaseSignatureSchema>;
export const cliReleaseSignaturesSchema = z
  .object({
    head: cliReleaseStateSchema,
    signatures: z.array(cliReleaseSignatureSchema).max(CLI_RELEASE_SIGNATURES_PER_STATE),
  })
  .strict();
/** The exact bytes a release key signs: one project's accepted source State. */
export const cliReleaseStatement = (projectId: string, head: string) =>
  `forge-cli-release/v1\nproject ${projectId}\nstate ${head}\n`;
