import { networkFetch, networkTimeout } from './network-fetch.js';
// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { authStatus } from './auth-status.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { neutralDeviceName } from './neutral-names.js';
import { spawn } from 'node:child_process';
import { makeFunctionReference } from 'convex/server';
import { coordinationClient } from './coordination-client.js';
import { deploymentUrl, readAuth, resolveAuthToken, writeAuth, type SavedCredential } from './auth-store.js';
import { ForgeError, invariant } from './errors.js';
const help = `nforge login [DEPLOYMENT_URL] [--name NAME] [--scope cli|coordination] [--no-browser]
nforge logout [DEPLOYMENT_URL]
nforge auth rename NAME [DEPLOYMENT_URL]
nforge auth status [DEPLOYMENT_URL] [--hostname HOST] [--json [fields]]
nforge auth handle (NAME | --keep) [DEPLOYMENT_URL]
Deployment defaults to FORGE_DEPLOYMENT_URL or your most recent login. A device is named device-xxxx unless you pass --name; auth rename changes it later. Login uses a signed-in Forge browser approval and stores a revocable 30-day credential. Collaborators and agents see you by your Forge handle; \`auth handle\` picks it (or keeps the current one). FORGE_AUTH_TOKEN overrides stored credentials for hosted commands.\n`;
export function httpOrigin(deployment: string) {
  if (process.env.FORGE_HTTP_URL) return deploymentUrl(process.env.FORGE_HTTP_URL);
  const url = new URL(deployment);
  if (url.hostname.endsWith('.convex.cloud'))
    url.hostname = url.hostname.replace(/\.convex\.cloud$/, '.convex.site');
  return url.origin;
}
async function request(origin: string, operation: string, input: unknown) {
  let response: Response;
  try {
    response = await networkFetch(`${origin}/auth/device/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: networkTimeout(15_000),
    });
  } catch {
    throw new ForgeError('AUTH_NETWORK', 'Device login could not reach Forge.');
  }
  invariant(
    response.status !== 429,
    'AUTH_SLOW_DOWN',
    'Too many device logins were started on this Forge deployment. Try again in a minute.',
  );
  invariant(
    response.ok,
    'AUTH_REQUEST_FAILED',
    'Forge could not process device login. Check the deployment configuration.',
  );
  try {
    return await response.json();
  } catch {
    throw new ForgeError('AUTH_RESPONSE_INVALID', 'Forge returned an invalid login response.');
  }
}
export function openBrowser(url: string) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      env: childEnv({
        allow: [
          'DISPLAY',
          'WAYLAND_DISPLAY',
          'XAUTHORITY',
          'DBUS_SESSION_BUS_ADDRESS',
          'XDG_RUNTIME_DIR',
          'XDG_CURRENT_DESKTOP',
          'XDG_CONFIG_HOME',
          'XDG_DATA_DIRS',
          'BROWSER',
        ],
      }),
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* The printed URL remains available. */
  }
}
export async function authCli(command: string, args: string[]): Promise<unknown> {
  if (args.includes('--help')) {
    process.stdout.write(help);
    return undefined;
  }
  if (command === 'auth') {
    const sub = args.shift();
    if (sub === 'handle') return pickHandle(args);
    if (sub === 'rename') return renameDevice(args);
    invariant(sub === 'status', 'BAD_ARGUMENT', help);
    return authStatus(args);
  }
  let selected: string | undefined,
    name = neutralDeviceName(),
    named = false,
    scope: 'cli' | 'coordination' = 'cli',
    browser = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--name' && args[i + 1]) {
      name = args[++i]!;
      named = true;
    } else if (arg === '--scope' && args[i + 1]) {
      const value = args[++i];
      invariant(value === 'cli' || value === 'coordination', 'BAD_ARGUMENT', help);
      scope = value;
    } else if (arg === '--no-browser') browser = false;
    else {
      invariant(!arg.startsWith('-') && !selected, 'BAD_ARGUMENT', help);
      selected = arg;
    }
  }
  const store = readAuth();
  selected ??= process.env.FORGE_DEPLOYMENT_URL ?? store.defaultDeployment;
  invariant(selected, 'BAD_ARGUMENT', 'Provide a deployment URL or set FORGE_DEPLOYMENT_URL.');
  const deployment = deploymentUrl(selected),
    saved = store.deployments[deployment];
  if (command === 'logout') {
    if (!saved) return { deployment, loggedOut: true };
    // Logout always revokes this saved device, even when an environment override is set.
    let remoteRevoked = false;
    // The backend decides expiry; a local clock or cached expiry must not skip revocation.
    try {
      await coordinationClient(deployment, saved.token).mutation(
        makeFunctionReference<'mutation'>('deviceCredentials:revoke'),
        { credentialId: saved.credentialId, operationId: randomUUID() },
      );
      remoteRevoked = true;
    } catch {
      remoteRevoked = false;
    }
    delete store.deployments[deployment];
    if (store.defaultDeployment === deployment) delete store.defaultDeployment;
    writeAuth(store);
    return {
      deployment,
      loggedOut: true,
      remoteRevoked,
      ...(!remoteRevoked
        ? {
            message:
              'Local credential removed; remote revocation could not be verified. Account settings lists the device for revocation.',
          }
        : {}),
    };
  }
  invariant(command === 'login', 'BAD_ARGUMENT', help);
  invariant(
    name.trim().length > 0 && name.trim().length <= 80,
    'BAD_ARGUMENT',
    'Use a device name of 1 to 80 characters.',
  );
  const clientNonce = randomBytes(32).toString('hex'),
    operationId = randomUUID(),
    origin = httpOrigin(deployment);
  const input = { clientNonce, operationId, name, scope };
  let flow;
  // Retry the same operation after an unknown network outcome.
  try {
    flow = await request(origin, 'start', input);
  } catch (error) {
    if (!(error instanceof ForgeError) || error.code !== 'AUTH_NETWORK') throw error;
    flow = await request(origin, 'start', input);
  }
  invariant(
    flow &&
      typeof flow.device_code === 'string' &&
      /^[0-9a-f]{64}$/.test(flow.device_code) &&
      typeof flow.verification_uri_complete === 'string' &&
      typeof flow.user_code === 'string' &&
      Number.isFinite(flow.expires_in),
    'AUTH_RESPONSE_INVALID',
    'Forge returned an invalid login response.',
  );
  const verification = new URL(flow.verification_uri_complete);
  invariant(
    verification.protocol === 'https:' ||
      (verification.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(verification.hostname)),
    'AUTH_RESPONSE_INVALID',
    'Forge returned an invalid verification URL.',
  );
  process.stderr.write(
    `Open ${verification.href}\nCode: ${flow.user_code}\nApprove ${name} (${scope}) in Forge.\n${named ? '' : `This device is named ${name}. Rename it any time: nforge auth rename NAME\n`}`,
  );
  if (browser) openBrowser(verification.href);
  const deadline = Date.now() + flow.expires_in * 1000,
    redemptionId = randomUUID();
  let interval = 5000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, interval));
    let result;
    try {
      result = await request(origin, 'poll', { deviceCode: flow.device_code, operationId: redemptionId });
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'AUTH_NETWORK') {
        interval = Math.min(30_000, interval * 2);
        continue;
      }
      throw error;
    }
    if (result.status === 'authorization_pending') {
      interval = Math.min(30_000, interval * 2);
      continue;
    }
    if (result.status === 'slow_down') {
      interval += 5000;
      continue;
    }
    invariant(
      result.status === 'approved',
      'AUTH_LOGIN_DENIED',
      result.status === 'access_denied'
        ? 'Device login was denied.'
        : 'Device code expired or was already used. Run nforge login.',
    );
    invariant(
      typeof result.token === 'string' &&
        typeof result.credentialId === 'string' &&
        Number.isFinite(result.expiresAt),
      'AUTH_RESPONSE_INVALID',
      'Forge returned an invalid credential.',
    );
    const credential: SavedCredential = {
      token: result.token,
      credentialId: result.credentialId,
      expiresAt: result.expiresAt,
      name,
      scope,
    };
    // Reload to preserve credentials saved for other deployments during approval.
    const latest = readAuth();
    latest.deployments[deployment] = credential;
    latest.defaultDeployment = deployment;
    writeAuth(latest);
    await askForHandleOnce(deployment, credential.token);
    return { deployment, loggedIn: true, name, scope, expiresAt: credential.expiresAt };
  }
  throw new ForgeError('AUTH_EXPIRED', 'Device code expired. Run nforge login.');
}

const status = makeFunctionReference<'query', Record<string, never>, { handle: string | null; pick?: true }>(
  'deviceCredentials:status',
);
/** Accounts without a chosen handle (no username or GitHub login, or an older name-derived
 * one) are asked once, right after login; the web asks the same once. */
async function askForHandleOnce(deployment: string, token: string) {
  try {
    const account = await coordinationClient(deployment, token).query(status, {});
    if (account.pick)
      process.stderr.write(
        `Pick your Forge handle: it is how collaborators and agents see you. Run nforge auth handle NAME${account.handle ? `, or nforge auth handle --keep to keep @${account.handle}` : ''}.\n`,
      );
  } catch {
    /* Login succeeded; the prompt is advice and the web shows it too. */
  }
}
async function pickHandle(args: string[]) {
  const keep = args.includes('--keep');
  const positional = args.filter(arg => arg !== '--keep');
  invariant(
    positional.length <= (keep ? 1 : 2) && positional.every(arg => !arg.startsWith('-')),
    'BAD_ARGUMENT',
    help,
  );
  const wanted = keep ? undefined : positional.shift();
  invariant(keep || wanted, 'BAD_ARGUMENT', help);
  const store = readAuth();
  const selected = positional[0] ?? process.env.FORGE_DEPLOYMENT_URL ?? store.defaultDeployment;
  invariant(selected, 'BAD_ARGUMENT', 'Provide a deployment URL or set FORGE_DEPLOYMENT_URL.');
  const deployment = deploymentUrl(selected),
    token = resolveAuthToken(deployment);
  invariant(token, 'AUTH_REQUIRED', 'Run nforge login first.');
  const client = coordinationClient(deployment, token);
  const handle = wanted ?? (await client.query(status, {})).handle;
  invariant(handle, 'BAD_ARGUMENT', 'Pick a handle: nforge auth handle NAME.');
  // Setting the same handle again is harmless, so each run uses a fresh operation id.
  await client.mutation(makeFunctionReference<'mutation'>('urlAccounts:set'), {
    handle: handle.trim().toLowerCase(),
    operationId: randomUUID(),
  });
  return { deployment, handle: handle.trim().toLowerCase() };
}
/** Renames this saved device; the name is a label the owner sees in Account settings. */
async function renameDevice(args: string[]) {
  const positional = args.filter(arg => !arg.startsWith('-'));
  invariant(
    positional.length >= 1 && positional.length <= 2 && args.length === positional.length,
    'BAD_ARGUMENT',
    help,
  );
  const name = positional[0]!.trim();
  invariant(name.length > 0 && name.length <= 80, 'BAD_ARGUMENT', 'Use a device name of 1 to 80 characters.');
  const store = readAuth();
  const selected = positional[1] ?? process.env.FORGE_DEPLOYMENT_URL ?? store.defaultDeployment;
  invariant(selected, 'BAD_ARGUMENT', 'Provide a deployment URL or set FORGE_DEPLOYMENT_URL.');
  const deployment = deploymentUrl(selected),
    saved = store.deployments[deployment];
  invariant(saved, 'AUTH_REQUIRED', 'Run nforge login first; only a saved login device can be renamed.');
  // Renaming to the same name again is harmless, so a fresh operation id per run is safe.
  await coordinationClient(deployment, saved.token).mutation(
    makeFunctionReference<'mutation'>('deviceCredentials:rename'),
    { credentialId: saved.credentialId, name, operationId: randomUUID() },
  );
  const latest = readAuth();
  if (latest.deployments[deployment]) {
    latest.deployments[deployment].name = name;
    writeAuth(latest);
  }
  return { deployment, renamed: true, name };
}
