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
export type SavedCredential = {
  token: string;
  credentialId: string;
  expiresAt: number;
  name: string;
  scope: 'cli' | 'coordination';
};
type Store = { defaultDeployment?: string; deployments: Record<string, SavedCredential> };
export function authFile() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'forge', 'auth.json');
}
export function deploymentUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ForgeError('BAD_ARGUMENT', 'Use a Forge deployment origin.');
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
    'Use a Forge deployment origin over HTTPS or HTTP loopback.',
  );
  return url.origin;
}
export function readAuth(): Store {
  const file = authFile();
  if (!existsSync(file)) return { deployments: {} };
  const info = lstatSync(file);
  invariant(
    info.isFile() &&
      (process.platform === 'win32' || ((info.mode & 0o077) === 0 && info.uid === process.getuid?.())),
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
export function resolveAuthToken(
  deployment: string,
  override: string | undefined = process.env.FORGE_AUTH_TOKEN,
) {
  if (override !== undefined) return override;
  const saved = savedCredential(deployment);
  invariant(!saved || saved.expiresAt > Date.now(), 'AUTH_EXPIRED', 'Forge login expired. Run nforge login.');
  return saved?.token;
}
export function hasSavedAuth() {
  return Object.keys(readAuth().deployments).length > 0;
}
