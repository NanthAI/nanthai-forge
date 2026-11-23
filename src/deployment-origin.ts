// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError, invariant } from './errors.js';
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

/** Populated only by the local auth store already read for a command. No eager auth-file imports. */
export const renewableDevices = new Map<string, { deployment: string; expiresAt: number }>();
export const renewableDevice = (token: string | undefined) =>
  token && !process.env.FORGE_AUTH_TOKEN ? renewableDevices.get(token) : undefined;
