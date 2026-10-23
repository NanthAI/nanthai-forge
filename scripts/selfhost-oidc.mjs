// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { api, internal } from '../convex/_generated/api.js';

export const githubOidcIssuer = 'https://token.actions.githubusercontent.com';
async function token(audience) {
  const request = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    endpoint = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  assert(request && endpoint, 'Real OIDC smoke requires this GitHub job’s ephemeral token endpoint.');
  const url = new URL(endpoint);
  assert(
    url.protocol === 'https:' &&
      url.hostname.endsWith('.actions.githubusercontent.com') &&
      !url.username &&
      !url.password,
    'Use GitHub’s native job token endpoint.',
  );
  url.searchParams.set('audience', audience);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${request}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, 'GitHub did not issue the ephemeral OIDC token.');
  const result = await response.json();
  assert(
    typeof result.value === 'string' && result.value.split('.').length === 3,
    'GitHub returned an invalid OIDC token.',
  );
  const claims = JSON.parse(Buffer.from(result.value.split('.')[1], 'base64url'));
  assert.equal(claims.iss, githubOidcIssuer);
  assert.equal(claims.aud, audience);
  assert(
    typeof claims.sub === 'string' && claims.sub.length && claims.exp * 1000 > Date.now(),
    'Use the original current GitHub issuer/subject principal.',
  );
  return { jwt: result.value, claims };
}
// This exercises real signed bearer verification, not setAdminAuth. Native admin is used only to inspect persisted ownership.
export async function verifyGithubOidc(clients, repository, ref, original) {
  const current = await token('convex'),
    client = new ConvexHttpClient(clients.anon.url, { logger: false });
  client.setAuth(current.jwt);
  const retained = original ?? {
    operationId: randomUUID(),
    value: 'oidc-synthetic-' + randomUUID(),
    subject: current.claims.sub,
  };
  assert.equal(
    current.claims.sub,
    retained.subject,
    'Credential refresh must retain the original GitHub issuer/subject principal.',
  );
  if (!retained.id)
    retained.id = await client.action(api.secretActions.create, {
      name: 'Real OIDC native restore QA',
      repository,
      ref,
      operationId: retained.operationId,
      value: retained.value,
    });
  const stored = await clients.admin.query(internal.secrets.created, {
    owner: retained.subject,
    operationId: retained.operationId,
  });
  assert.equal(stored.object._id, retained.id);
  assert.equal(stored.object.owner, retained.subject);
  assert(!JSON.stringify(stored).includes(retained.value));
  if (retained.stored) assert.deepEqual(stored, retained.stored);
  else retained.stored = stored;
  assert.equal((await client.query(api.secrets.details, { id: retained.id })).owned, true);
  assert.equal(
    (await client.action(api.secretActions.reveal, { id: retained.id, operationId: randomUUID() })).value,
    retained.value,
  );
  for (const caller of [clients.anon, clients.outsider, clients.admin])
    await assert.rejects(caller.query(api.secrets.details, { id: retained.id }));
  const invalid = new ConvexHttpClient(clients.anon.url, { logger: false });
  invalid.setAuth((await token('forge-negative-audience')).jwt);
  await assert.rejects(
    invalid.mutation(api.teams.create, {
      name: 'Invalid audience must not write',
      operationId: randomUUID(),
    }),
  );
  const parts = current.jwt.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...current.claims, sub: 'forge_native_smoke' })).toString(
    'base64url',
  );
  invalid.setAuth(parts.join('.'));
  await assert.rejects(
    invalid.mutation(api.teams.create, { name: 'Forged subject must not write', operationId: randomUUID() }),
  );
  // Reconcile original create after a current credential refresh; no second Secret Object or changed ownership.
  assert.equal(
    await client.action(api.secretActions.create, {
      name: 'Real OIDC native restore QA',
      repository,
      ref,
      operationId: retained.operationId,
      value: retained.value,
    }),
    retained.id,
  );
  return retained;
}
