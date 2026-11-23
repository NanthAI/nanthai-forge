// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { networkFetch, networkTimeout } from './network-fetch.js';
import { z } from 'zod';
import { invariant } from './errors.js';
export const actionsIssuer = 'https://token.actions.githubusercontent.com';
export const actionsClaimsSchema = z.object({
  iss: z.literal(actionsIssuer),
  aud: z.string(),
  exp: z.number(),
  nbf: z.number(),
  iat: z.number(),
  repository: z.string(),
  workflow_ref: z.string(),
  workflow_sha: z.string().regex(/^[a-f0-9]{40}$/),
  ref: z.literal('refs/heads/main'),
  event_name: z.literal('workflow_dispatch'),
  run_id: z.string().regex(/^[1-9][0-9]*$/),
  run_attempt: z.literal('1'),
  runner_environment: z.enum(['github-hosted', 'self-hosted']),
  /** Signed by GitHub at run time; a private project needs `private` (src/runner-visibility.ts). */
  repository_visibility: z.string().optional(),
});
export function validateActionsClaims(
  value: unknown,
  expected: {
    audience: string;
    repository?: string;
    executionId?: string | null;
    workflowSha?: string;
    /** Self-hosted claims are accepted only for a run configured with non-GitHub-hosted labels. */
    selfHosted?: boolean;
  },
  now = Date.now(),
) {
  const c = actionsClaimsSchema.parse(value);
  invariant(
    c.aud === expected.audience &&
      c.exp > now / 1000 &&
      c.nbf <= now / 1000 &&
      c.iat <= now / 1000 &&
      c.workflow_ref === `${c.repository}/.github/workflows/forge-check.yml@refs/heads/main` &&
      (!expected.repository || c.repository === expected.repository) &&
      (!expected.executionId || c.run_id === expected.executionId) &&
      (!expected.workflowSha || c.workflow_sha === expected.workflowSha) &&
      (c.runner_environment === 'github-hosted' || expected.selfHosted !== false),
    'EVIDENCE_CHANGED',
    'GitHub OIDC claims differ from the dispatched workflow.',
  );
  return c;
}
type SigningJwk = JsonWebKey & { kid?: string };
type KeyCache = {
  keys: SigningJwk[];
  fetchedAt: number;
  attemptedAt: number;
  pending?: Promise<void>;
  error?: unknown;
};
// One fixed-issuer cache per transport. Injected test transports never share provider keys.
const keyCaches = new WeakMap<typeof networkFetch, KeyCache>();
async function signingJwk(kid: string, request: typeof networkFetch, now: number) {
  let cache = keyCaches.get(request);
  if (!cache) {
    cache = { keys: [], fetchedAt: -Infinity, attemptedAt: -Infinity };
    keyCaches.set(request, cache);
  }
  const matching = () =>
    cache.keys.find(key => key.kid === kid && key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig');
  if (now >= cache.fetchedAt && now - cache.fetchedAt < 600_000 && matching()) return matching()!;
  if (!cache.pending && (now < cache.attemptedAt || now - cache.attemptedAt >= 60_000)) {
    cache.attemptedAt = now;
    cache.pending = (async () => {
      const response = await request(`${actionsIssuer}/.well-known/jwks`, {
        redirect: 'error',
        signal: networkTimeout(10_000),
      });
      invariant(
        response.ok,
        response.status === 429 || response.status >= 500 ? 'RUNNER_UNAVAILABLE' : 'EVIDENCE_CHANGED',
        'GitHub OIDC keys unavailable.',
      );
      const value = (await response.json()) as { keys: SigningJwk[] };
      invariant(Array.isArray(value.keys), 'EVIDENCE_CHANGED', 'GitHub OIDC keys unavailable.');
      cache.keys = value.keys;
      cache.fetchedAt = now;
      cache.error = undefined;
    })()
      .catch(error => {
        cache.error = error;
        throw error;
      })
      .finally(() => {
        delete cache.pending;
      });
  }
  if (cache.pending) await cache.pending;
  if (cache.error) throw cache.error;
  const key = now >= cache.fetchedAt && now - cache.fetchedAt < 600_000 ? matching() : undefined;
  invariant(key, 'EVIDENCE_CHANGED', 'GitHub OIDC signing key unavailable.');
  return key;
}

/** Fixed issuer/key URL only; an untrusted JWT never chooses a network target. */
export async function verifyActionsOidc(
  token: string,
  audience: string,
  request = networkFetch,
  now = Date.now(),
) {
  invariant(token.length <= 16_384, 'EVIDENCE_CHANGED', 'Invalid GitHub OIDC token.');
  const parts = token.split('.');
  invariant(parts.length === 3, 'EVIDENCE_CHANGED', 'Invalid GitHub OIDC token.');
  const decode = (part: string) =>
    Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const header = z
    .object({ alg: z.literal('RS256'), kid: z.string() })
    .parse(JSON.parse(new TextDecoder().decode(decode(parts[0]!))));
  const claims = validateActionsClaims(
    JSON.parse(new TextDecoder().decode(decode(parts[1]!))),
    { audience },
    now,
  );
  const jwk = await signingJwk(header.kid, request, now);
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  invariant(
    await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      decode(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    ),
    'EVIDENCE_CHANGED',
    'GitHub OIDC signature is invalid.',
  );
  return claims;
}
