// SPDX-License-Identifier: Apache-2.0
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
});
export type ActionsClaims = z.infer<typeof actionsClaimsSchema>;
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
/** Fixed issuer/key URL only; an untrusted JWT never chooses a network target. */
export async function verifyActionsOidc(token: string, audience: string, request = fetch, now = Date.now()) {
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
  const response = await request(`${actionsIssuer}/.well-known/jwks`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  invariant(response.ok, 'EVIDENCE_CHANGED', 'GitHub OIDC keys unavailable.');
  const keys = (await response.json()) as { keys: (JsonWebKey & { kid?: string })[] };
  const jwk = keys.keys.find(
    key => key.kid === header.kid && key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig',
  );
  invariant(jwk, 'EVIDENCE_CHANGED', 'GitHub OIDC signing key unavailable.');
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
