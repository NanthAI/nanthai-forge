// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { coordinationClient } from './coordination-client.js';
import { deploymentUrl, readAuth, resolveAuthToken } from './auth-store.js';
import { ForgeError, invariant } from './errors.js';
import { parseGhOptions, projectGh } from './gh-cli-options.js';

/** Verifies the same current credential as hosted commands; only allowlisted identity fields leave here. */
export async function authStatus(args: string[]): Promise<unknown> {
  const options = parseGhOptions(args, 'auth', ['--hostname']),
    store = readAuth(),
    requested = options.values['--hostname'];
  invariant(
    options.positional.length <= 1 && !(requested && options.positional.length),
    'BAD_ARGUMENT',
    'Select one deployment URL or --hostname HOST.',
  );
  let selected = options.positional[0] ?? process.env.FORGE_DEPLOYMENT_URL ?? store.defaultDeployment;
  if (requested) {
    if (requested.includes('://')) selected = deploymentUrl(requested);
    else
      selected =
        [selected, ...Object.keys(store.deployments)].find(url => url && new URL(url).host === requested) ??
        `https://${requested}`;
  }
  const deployment = selected ? deploymentUrl(selected) : null,
    host = deployment ? new URL(deployment).host : null,
    saved = deployment ? store.deployments[deployment] : undefined,
    token = deployment ? resolveAuthToken(deployment) : undefined;
  if (!token) {
    process.exitCode = 1;
    return projectGh(
      {
        deployment,
        host,
        authenticated: false,
        account: null,
        source: null,
        tokenSource: null,
        hosts: {},
        identity: null,
        name: null,
        scope: null,
        expiresAt: null,
      },
      options.fields,
    );
  }
  let identity: { handle: string | null; credentialId: string | null; pick?: true };
  try {
    const result = (await coordinationClient(deployment!, token).query(
      makeFunctionReference<'query'>('deviceCredentials:status'),
      {},
    )) as { handle?: unknown; subject?: unknown; credentialId?: unknown; pick?: unknown };
    // Servers before the handle-only identity rule return `subject`; it is never printed.
    const legacy = result?.handle === undefined && typeof result?.subject === 'string';
    invariant(
      typeof result?.handle === 'string' || result?.handle === null || legacy,
      'AUTH_RESPONSE_INVALID',
      'Forge returned an invalid account identity.',
    );
    identity = {
      handle: legacy ? null : (result.handle as string | null),
      credentialId: typeof result.credentialId === 'string' ? result.credentialId : null,
      ...(result.pick === true ? { pick: true as const } : {}),
    };
  } catch {
    throw new ForgeError(
      'AUTH_UNAVAILABLE',
      'Forge authentication could not be verified. Check connectivity or run nforge login.',
    );
  }
  const environment = process.env.FORGE_AUTH_TOKEN !== undefined,
    tokenSource = environment ? 'FORGE_AUTH_TOKEN' : 'saved',
    account = identity.handle ?? 'no handle yet';
  return projectGh(
    {
      deployment,
      host,
      authenticated: true,
      account,
      source: environment ? 'environment' : 'saved',
      tokenSource,
      hosts: { [host!]: [{ host, login: account, active: true, state: 'success', tokenSource }] },
      name: !environment ? (saved?.name ?? null) : null,
      scope: !environment ? (saved?.scope ?? null) : null,
      expiresAt: !environment ? (saved?.expiresAt ?? null) : null,
      identity,
    },
    options.fields,
  );
}
