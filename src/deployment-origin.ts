// SPDX-License-Identifier: Apache-2.0
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
