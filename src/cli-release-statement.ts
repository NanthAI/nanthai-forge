// SPDX-License-Identifier: Apache-2.0
// The exact bytes release keys sign. No imports and no Node built-ins: the CLI, the Convex store
// and the automated signer (scripts/release-sign-ci.mjs, run by Node without a build) share them.

/** One project's accepted source State and, from v2, its release number. v1 (no number) is what
 * signatures made before release numbers cover. */
export const cliReleaseStatement = (projectId: string, head: string, release?: number) =>
  release === undefined
    ? `forge-cli-release/v1\nproject ${projectId}\nstate ${head}\n`
    : `forge-cli-release/v2\nproject ${projectId}\nstate ${head}\nrelease ${release}\n`;

/** How far a signer read proof's `at` (Unix seconds) may be from the server's clock. */
export const CLI_RELEASE_READ_PROOF_SECONDS = 300;

/** A signer read proof: lets the holder of a listed release key read main's head and release
 * number for one State without a sign-in. Its own prefix, so it never verifies as a release. */
export const cliReleaseReadStatement = (projectId: string, head: string, at: number) =>
  `forge-cli-release-read/v1\nproject ${projectId}\nstate ${head}\nat ${at}\n`;
