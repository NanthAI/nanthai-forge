// SPDX-License-Identifier: Apache-2.0
import { resolveAuthToken } from './auth-store.js';
import { ConvexHttpClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';
import { ForgeError, invariant } from './errors.js';

export interface CoordinationTransport {
  query(reference: FunctionReference<'query'>, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: FunctionReference<'mutation'>, args: Record<string, unknown>): Promise<unknown>;
}
/** Environment overrides the credential saved for this deployment. */
export function coordinationCredentials(
  deployment: string,
  token: string | undefined,
): { url: string; token: string } {
  token = resolveAuthToken(deployment, token);
  let url: URL;
  try {
    url = new URL(deployment);
  } catch {
    throw new ForgeError('BAD_ARGUMENT', 'Use a Forge Convex deployment URL.');
  }
  invariant(
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    'BAD_ARGUMENT',
    'Use HTTPS or HTTP loopback with no credentials, path, query or fragment.',
  );
  invariant(
    token && !token.startsWith('fga_'),
    'PROJECT_UNAVAILABLE',
    'Run nforge login or set FORGE_AUTH_TOKEN to an existing owner/contributor Convex JWT. Source-read grants do not grant coordination writes.',
  );
  return { url: url.origin, token };
}
export function coordinationClient(deployment: string, token: string | undefined): ConvexHttpClient {
  const credentials = coordinationCredentials(deployment, token);
  const client = new ConvexHttpClient(credentials.url, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  client.setAuth(credentials.token);
  return client;
}
export { dispatchCoordination } from './coordination-dispatch.js';
