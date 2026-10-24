// SPDX-License-Identifier: Apache-2.0
import type { AuthConfig } from 'convex/server';

if (
  process.env.FORGE_CLI_ISSUER &&
  (new URL(process.env.FORGE_CLI_ISSUER).origin !== process.env.FORGE_CLI_ISSUER ||
    new URL(process.env.FORGE_CLI_ISSUER).protocol !== 'https:' ||
    process.env.FORGE_CLI_ISSUER === process.env.CLERK_JWT_ISSUER_DOMAIN)
)
  throw new Error('FORGE_CLI_ISSUER must be a distinct HTTPS HTTP origin without a trailing slash.');

export default {
  providers: [
    ...(process.env.CLERK_JWT_ISSUER_DOMAIN
      ? [{ domain: process.env.CLERK_JWT_ISSUER_DOMAIN, applicationID: 'convex' }]
      : []),
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
