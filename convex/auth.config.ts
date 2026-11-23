// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { AuthConfig } from 'convex/server';
import { convexAuthProvider } from '@convex-dev/auth/server';

if (
  process.env.FORGE_CLI_ISSUER &&
  (new URL(process.env.FORGE_CLI_ISSUER).origin !== process.env.FORGE_CLI_ISSUER ||
    new URL(process.env.FORGE_CLI_ISSUER).protocol !== 'https:')
)
  throw new Error('FORGE_CLI_ISSUER must be a distinct HTTPS HTTP origin without a trailing slash.');

export default {
  providers: [
    ...(process.env.CONVEX_CLOUD_URL ? [convexAuthProvider()] : []),
    ...(process.env.FORGE_CLI_ISSUER
      ? [
          {
            type: 'customJwt' as const,
            issuer: process.env.FORGE_CLI_ISSUER,
            applicationID: 'forge-cli',
            algorithm: 'RS256' as const,
            jwks: `${process.env.FORGE_CLI_ISSUER}/auth/jwks`,
          },
        ]
      : []),
  ],
} satisfies AuthConfig;
