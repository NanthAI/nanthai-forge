// SPDX-License-Identifier: Apache-2.0
import { slug } from './project-routes.js';
/** Top-level application/server destinations cannot be account handles. */
export const reservedHandles = new Set([
  'local',
  'settings',
  'projects',
  'api',
  'new',
  'login',
  'logout',
  'import',
  'imports',
  'assets',
  'auth',
  'worker',
  'github',
  'device',
  'explore',
  'agents',
  'account',
  'contact',
  'signin',
  'signup',
]);
export function handleError(value: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])$/.test(value))
    return 'Use 2–39 lowercase letters, numbers or hyphens, without a leading or trailing hyphen.';
  return reservedHandles.has(value) ? 'This handle is reserved for Forge.' : null;
}
export function handleBase(
  profile: { username?: string | null; firstName?: string | null; lastName?: string | null },
  random: string,
): string {
  for (const name of [profile.username, [profile.firstName, profile.lastName].filter(Boolean).join(' ')]) {
    if (!name || name.includes('@')) continue;
    const value = slug(name).slice(0, 39).replace(/-$/, '');
    if (!handleError(value)) return value;
  }
  return `user-${random.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'account'}`;
}
export async function uniqueUrlName(
  base: string,
  occupied: (value: string) => Promise<boolean>,
  max = 100,
): Promise<string> {
  let candidate = base.slice(0, max).replace(/-$/, '');
  for (let suffix = 2; await occupied(candidate); suffix++) {
    const tail = `-${suffix}`;
    candidate = base.slice(0, max - tail.length).replace(/-$/, '') + tail;
  }
  return candidate;
}
