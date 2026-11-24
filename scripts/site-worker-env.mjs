// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** The site Worker's bindings, as scripts/build-site.mjs writes them into worker.config.json (Item 8947a779).
 *
 * `PUBLIC_PAGES` is the R2 bucket the Convex snapshot writer fills (site/public-read.ts reads it, so a signed-out or
 * crawler request on an edge-cache miss never calls Convex). The bucket's name is not in the repo: the deploy workflow
 * passes it from the repository variable FORGE_PUBLIC_PAGES_BUCKET. Unset or empty leaves the binding off, and the
 * Worker keeps its Convex read, so a build without the variable still works. A set but malformed name stops the build
 * rather than deploying without the binding; the error never repeats the value (workflow logs are public). */
const secret = { type: 'secret' };
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function siteWorkerEnv(bucket = process.env.FORGE_PUBLIC_PAGES_BUCKET) {
  const name = bucket?.trim();
  if (name && !BUCKET_NAME.test(name))
    throw new Error(
      'FORGE_PUBLIC_PAGES_BUCKET is not an R2 bucket name (3-63 lowercase letters, digits and dashes).',
    );
  return {
    ASSETS: { type: 'assets' },
    // Per-address backstops before any backend call: 60 public reads and 10 sign-in starts a minute.
    PUBLIC_LIMIT: { type: 'rate-limit', namespace: '7201', simple: { limit: 60, period: 60 } },
    DEVICE_LIMIT: { type: 'rate-limit', namespace: '7202', simple: { limit: 10, period: 60 } },
    ...(name ? { PUBLIC_PAGES: { type: 'r2', name } } : {}),
    FORGE_WEB_URL: secret,
    FORGE_CONVEX_SITE_URL: secret,
    FORGE_PUBLIC_READ_SECRET: secret,
    // FORGE_PUBLIC_CODE_WORKER_URL is optional (docs/r2-storage-plan.md#dev-deployment): declare it here when the
    // public code Worker route is turned on, because every declared secret is required.
    FORGE_CLIENT_HASH_KEY: secret,
    FORGE_SITE_DEVICE_KEY: secret,
  };
}
