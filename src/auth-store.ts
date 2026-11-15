// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  lstatSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { refuseRealUserState } from './test-isolation.js';
import { ownerOnly } from './file-mode.js';
import { deploymentUrl } from './deployment-origin.js';
export { deploymentUrl } from './deployment-origin.js';
export type SavedCredential = {
  token: string;
  credentialId: string;
  expiresAt: number;
  name: string;
  scope: 'cli' | 'coordination';
  /** The one-time hint about renaming an older hostname-named device was shown. */
  renameHinted?: true;
};
type Store = { defaultDeployment?: string; deployments: Record<string, SavedCredential> };
export function authFile() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'forge', 'auth.json');
}
export function readAuth(): Store {
  const file = authFile();
  if (!existsSync(file)) return { deployments: {} };
  const info = lstatSync(file);
  invariant(
    info.isFile() &&
      (process.platform === 'win32' || (ownerOnly(info.mode) && info.uid === process.getuid?.())),
    'AUTH_FILE_PERMISSIONS',
    'Forge credentials must be in a user-owned 0600 regular file.',
  );
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new ForgeError('AUTH_FILE_INVALID', 'Forge credential file is invalid.');
  }
  invariant(
    value &&
      typeof value === 'object' &&
      'deployments' in value &&
      typeof value.deployments === 'object' &&
      value.deployments !== null,
    'AUTH_FILE_INVALID',
    'Forge credential file is invalid.',
  );
  return value as Store;
}
export function writeAuth(store: Store) {
  const directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'forge');
  refuseRealUserState(directory, 'the saved Forge login');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const file = authFile(),
    temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(store) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}
export function savedCredential(deployment: string) {
  return readAuth().deployments[deploymentUrl(deployment)];
}
/** Where a deployment's credential stands (SM-C M23). An empty `FORGE_AUTH_TOKEN` is unset, so it
 * never hides a saved login. `expired` keeps the saved entry's expiry for the message. */
export type AuthState =
  | { kind: 'none' }
  | { kind: 'envToken'; token: string }
  | { kind: 'saved'; token: string; expiresAt: number }
  | { kind: 'expired'; expiresAt: number };
export const AUTH_STATE_NEXT_STEP = {
  none: 'Run nforge login.',
  envToken: 'Nothing to do: FORGE_AUTH_TOKEN is in use.',
  saved: 'Nothing to do.',
  expired: 'Forge login expired. Run nforge login.',
} satisfies Record<AuthState['kind'], string>;
export function authState(
  deployment: string,
  override: string | undefined = process.env.FORGE_AUTH_TOKEN,
): AuthState {
  const origin = deploymentUrl(deployment);
  const configured = override ? process.env.FORGE_DEPLOYMENT_URL : undefined;
  const store = configured ? ({ deployments: {} } as Store) : readAuth();
  if (override) {
    const bound = configured
      ? deploymentUrl(configured)
      : store.defaultDeployment
        ? deploymentUrl(store.defaultDeployment)
        : undefined;
    invariant(
      configured ? origin === bound : origin === bound || Object.hasOwn(store.deployments, origin),
      'AUTH_REQUIRED',
      bound
        ? `FORGE_AUTH_TOKEN is bound to ${bound}; this checkout names ${origin}.`
        : 'Bind FORGE_AUTH_TOKEN with FORGE_DEPLOYMENT_URL or run nforge login for this deployment.',
    );
    return { kind: 'envToken', token: override };
  }
  const saved = store.deployments[origin];
  if (!saved) return { kind: 'none' };
  return saved.expiresAt > Date.now()
    ? { kind: 'saved', token: saved.token, expiresAt: saved.expiresAt }
    : { kind: 'expired', expiresAt: saved.expiresAt };
}
export function resolveAuthToken(
  deployment: string,
  override: string | undefined = process.env.FORGE_AUTH_TOKEN,
) {
  const state = authState(deployment, override);
  invariant(state.kind !== 'expired', 'AUTH_EXPIRED', AUTH_STATE_NEXT_STEP.expired);
  return state.kind === 'none' ? undefined : state.token;
}
export function hasSavedAuth() {
  return Object.keys(readAuth().deployments).length > 0;
}
