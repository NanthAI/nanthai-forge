// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { authStatus } from './auth-status.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { makeFunctionReference } from 'convex/server';
import { coordinationClient } from './coordination-client.js';
import { deploymentUrl, readAuth, writeAuth, type SavedCredential } from './auth-store.js';
import { ForgeError, invariant } from './errors.js';
const help = `nforge login [DEPLOYMENT_URL] [--name NAME] [--scope cli|coordination] [--no-browser]
nforge logout [DEPLOYMENT_URL]
nforge auth status [DEPLOYMENT_URL] [--hostname HOST] [--json [fields]]
Deployment defaults to FORGE_DEPLOYMENT_URL or your most recent login. Login uses a signed-in Forge browser approval and stores a revocable 30-day credential. FORGE_AUTH_TOKEN overrides stored credentials for hosted commands.\n`;
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
    response = await fetch(`${origin}/auth/device/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ForgeError('AUTH_NETWORK', 'Device login could not reach Forge.');
  }
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
    invariant(args.shift() === 'status', 'BAD_ARGUMENT', help);
    return authStatus(args);
  }
  let selected: string | undefined,
    name = `nforge on ${hostname()}`,
    scope: 'cli' | 'coordination' = 'cli',
    browser = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--name' && args[i + 1]) name = args[++i]!;
    else if (arg === '--scope' && args[i + 1]) {
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
    `Open ${verification.href}\nCode: ${flow.user_code}\nApprove ${name} (${scope}) in Forge.\n`,
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
    return { deployment, loggedIn: true, name, scope, expiresAt: credential.expiresAt };
  }
  throw new ForgeError('AUTH_EXPIRED', 'Device code expired. Run nforge login.');
}
