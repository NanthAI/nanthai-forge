// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { coordinationClient } from './coordination-client.js';
import { AUTH_STATE_NEXT_STEP, authState, readAuth, writeAuth } from './auth-store.js';
import { appTarget, authTarget, backendTarget, folderAddress } from './app-discovery.js';
import { distributionForgeSite } from './forge-site.js';
import { shellQuote } from './shell-quote.js';
import { publicProjectLogin } from './public-project-commands.js';
import { ForgeError, invariant } from './errors.js';
import { parseGhOptions, projectGh } from './gh-cli-options.js';
import { cliBuildIdentity } from './cli-installation.js';

/** Verifies the same current credential as hosted commands; only allowlisted identity fields leave here. */
export async function authStatus(args: string[]): Promise<unknown> {
  const options = parseGhOptions(args, 'auth', ['--hostname']),
    store = readAuth(),
    requested = options.values['--hostname'];
  const cli = cliBuildIdentity();
  invariant(
    options.positional.length <= 1 && !(requested && options.positional.length),
    'BAD_ARGUMENT',
    'Select one Forge app URL or --hostname HOST.',
  );
  // The folder's service is authoritative for this read; explicit selectors still win.
  const project = !options.positional.length ? await folderAddress() : null;
  const implicit = project?.url ?? process.env.FORGE_DEPLOYMENT_URL ?? store.defaultDeployment;
  const selected =
    options.positional[0] ??
    (requested &&
      (requested.includes('://')
        ? requested
        : ([implicit, ...Object.keys(store.sites ?? {}), ...Object.keys(store.deployments)].find(
            url => url && new URL(url).host === requested,
          ) ?? `https://${requested}`)));
  const target = selected
    ? selected === project?.url
      ? backendTarget(selected, store)
      : await authTarget(selected, store)
    : implicit
      ? backendTarget(implicit, store)
      : Object.keys(store.deployments).length || process.env.FORGE_AUTH_TOKEN
        ? await appTarget(distributionForgeSite(), store)
        : { site: distributionForgeSite(), deployment: undefined };
  const { deployment, site } = target;
  const address = site ? { site } : { deployment };
  const host = new URL(site ?? deployment!).host;
  let saved = deployment ? store.deployments[deployment] : undefined;
  let state = deployment ? authState(deployment) : ({ kind: 'none' } as const);
  if (
    deployment &&
    state.kind === 'expired' &&
    saved?.deviceId &&
    store.devices?.[deployment]?.id === saved.deviceId &&
    !process.env.FORGE_AUTH_TOKEN
  ) {
    await (await import('./device-key.js')).renewDevice(deployment);
    saved = readAuth().deployments[deployment];
    state = authState(deployment);
  }
  const token = 'token' in state ? state.token : undefined;
  if (!token) {
    // An expired login answers like a missing one, with its own state (SM-C M23), instead of throwing.
    process.exitCode = 1;
    return projectGh(
      {
        ...cli,
        ...address,
        host,
        authenticated: false,
        state: state.kind,
        nextStep: AUTH_STATE_NEXT_STEP[state.kind].replace(
          'nforge login',
          deployment
            ? site
              ? publicProjectLogin(site)
              : `nforge login --deployment ${shellQuote(deployment)}`
            : 'nforge login',
        ),
        account: null,
        source: null,
        tokenSource: null,
        hosts: {},
        identity: null,
        name: null,
        scope: null,
        expiresAt: state.kind === 'expired' ? state.expiresAt : null,
      },
      options.fields,
    );
  }
  type Device = {
    id: string;
    code: string;
    name: string;
    approvedAt: number;
    expiresAt: number;
    settings: {
      source: 'write' | 'read' | 'coordination';
      projects: { kind: 'all' } | { kind: 'project'; projectId: string };
      /** Folder grant: writes only inside these folders or files. */
      paths?: string[];
    };
    /** When the folder grant ends (7 days after its last write, at most 30 days after it was given). */
    grantEndsAt?: number;
  };
  let device: Device | undefined;
  let identity: { handle: string | null; credentialId: string | null; pick?: true };
  try {
    const result = (await coordinationClient(deployment!, token).query(
      makeFunctionReference<'query'>('deviceCredentials:status'),
      {},
    )) as { handle?: unknown; subject?: unknown; credentialId?: unknown; pick?: unknown; device?: Device };
    const reported = result.device;
    if (
      reported &&
      typeof reported.id === 'string' &&
      typeof reported.code === 'string' &&
      typeof reported.name === 'string' &&
      Number.isFinite(reported.approvedAt) &&
      Number.isFinite(reported.expiresAt) &&
      reported.settings &&
      ['write', 'read', 'coordination'].includes(reported.settings.source)
    ) {
      const projects = reported.settings.projects;
      if (
        projects?.kind === 'all' ||
        (projects?.kind === 'project' && typeof projects.projectId === 'string')
      )
        device = {
          id: reported.id,
          code: reported.code,
          name: reported.name.startsWith('nforge on ') ? '' : reported.name,
          approvedAt: reported.approvedAt,
          expiresAt: reported.expiresAt,
          settings: {
            source: reported.settings.source,
            projects:
              projects.kind === 'all' ? { kind: 'all' } : { kind: 'project', projectId: projects.projectId },
            ...(Array.isArray(reported.settings.paths) &&
            reported.settings.paths.every(path => typeof path === 'string')
              ? { paths: reported.settings.paths }
              : {}),
          },
          ...(Number.isFinite(reported.grantEndsAt) ? { grantEndsAt: reported.grantEndsAt! } : {}),
        };
    }
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
  const environment = state.kind === 'envToken';
  if (!environment) hintLegacyDeviceName(deployment!);
  const tokenSource = environment ? 'FORGE_AUTH_TOKEN' : 'saved',
    account = identity.handle ?? 'no handle yet';
  return projectGh(
    {
      ...cli,
      ...address,
      host,
      authenticated: true,
      state: state.kind,
      nextStep: AUTH_STATE_NEXT_STEP[state.kind],
      account,
      source: environment ? 'environment' : 'saved',
      tokenSource,
      hosts: { [host]: [{ host, login: account, active: true, state: 'success', tokenSource }] },
      ...(device ? { device } : {}),
      name:
        !environment && !(device?.name ?? saved?.name)?.startsWith('nforge on ')
          ? (device?.name ?? saved?.name ?? null)
          : null,
      scope: !environment ? (device?.settings.source ?? saved?.scope ?? null) : null,
      expiresAt: !environment ? (saved?.expiresAt ?? null) : null,
      identity,
    },
    options.fields,
  );
}

/** Devices logged in before neutral names carry "nforge on <hostname>". They keep it until the owner
 * renames them; say how, once, on stderr so JSON output is unchanged. */
function hintLegacyDeviceName(deployment: string) {
  try {
    const store = readAuth(),
      saved = store.deployments[deployment];
    if (!saved || saved.renameHinted || !/^nforge on /.test(saved.name)) return;
    process.stderr.write(
      'This device is still named after your computer. Pick a neutral name any time: nforge auth rename NAME\n',
    );
    saved.renameHinted = true;
    writeAuth(store);
  } catch {
    /* The hint is advice only. */
  }
}
