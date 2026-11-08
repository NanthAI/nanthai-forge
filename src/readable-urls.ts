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
  'approve',
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
export type HandleProfile = { username?: string | null; githubLogin?: string | null };
/** The default handle: the username the person chose, else their GitHub login. Never derived
 * from a real name or email; with neither, the person is asked once to pick one. */
export function defaultHandle(profile: HandleProfile): string | null {
  for (const name of [profile.username, profile.githubLogin]) {
    if (!name || name.includes('@')) continue;
    const value = slug(name).slice(0, 39).replace(/-$/, '');
    if (!handleError(value)) return value;
  }
  return null;
}
/** A placeholder until the person picks: random, so it names nobody. */
export function placeholderHandle(random: string): string {
  return `user-${random.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'account'}`;
}
/** Whether a handle is the person's default (allowing the `-2` suffix a taken default receives). */
export function isDefaultHandle(handle: string, profile: HandleProfile): boolean {
  const base = defaultHandle(profile);
  if (!base) return false;
  if (handle === base) return true;
  // Mirrors uniqueUrlName(base, …, 39): a shortened base plus `-N`.
  const suffix = /-(\d+)$/.exec(handle)?.[1];
  const tail = `-${suffix}`;
  return !!suffix && handle === base.slice(0, 39 - tail.length).replace(/-$/, '') + tail;
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
