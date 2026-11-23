// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Per-visitor limits (Item b6588425): the site's edge keys a visitor by a keyed hash of the client address the
 * platform reports, and forwards only that hash. The address itself is never stored, logged or forwarded.
 * IPv6 visitors are keyed by their /64 (one subscriber's usual allocation), so rotating within it buys nothing.
 * The key lives only on the edge, so the stored hashes cannot be reversed by trying addresses without it. */
// No Node-only imports: Convex's V8 functions read the header names and the hash form from here.
const octet = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const IPV4 = new RegExp(`^${octet}(?:\\.${octet}){3}$`);
const isIPv4 = (value: string) => IPV4.test(value);

/** The forwarded hash header and the site credential that makes Convex trust it. */
export const CLIENT_HEADER = 'x-forge-client';
export const SITE_DEVICE_HEADER = 'x-forge-site-device';
export const CLIENT_HASH = /^[0-9a-f]{64}$/;

function ipv6Groups(address: string): string[] | null {
  const [head = '', tail, extra] = address.split('::');
  if (extra !== undefined) return null;
  const part = (text: string) => (text ? text.split(':') : []);
  let left = part(head),
    right = part(tail ?? '');
  // An embedded IPv4 tail counts as two groups.
  const last = (tail === undefined ? left : right).at(-1);
  if (last && isIPv4(last)) {
    const [a, b, c, d] = last.split('.').map(Number) as [number, number, number, number];
    const groups = [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    if (tail === undefined) left = [...left.slice(0, -1), ...groups];
    else right = [...right.slice(0, -1), ...groups];
  }
  const fill = 8 - left.length - right.length;
  if (tail === undefined ? fill !== 0 : fill < 1) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : fill).fill('0'), ...right];
  return groups.every(group => /^[0-9a-f]{1,4}$/i.test(group))
    ? groups.map(group => group.padStart(4, '0').toLowerCase())
    : null;
}

/** The stable form an address is keyed by, or null when the platform gave no usable address. */
export function clientKey(address: string | null | undefined): string | null {
  const value = address
    ?.trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  if (!value) return null;
  if (isIPv4(value)) return `4:${value}`;
  const groups = value.includes(':') ? ipv6Groups(value) : null;
  if (!groups) return null;
  // An IPv4-mapped address is the IPv4 visitor.
  if (groups.slice(0, 5).every(group => group === '0000') && groups[5] === 'ffff') {
    const [high, low] = [parseInt(groups[6]!, 16), parseInt(groups[7]!, 16)];
    return `4:${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `6:${groups.slice(0, 4).join(':')}::/64`;
}

/** HMAC-SHA256 of the keyed form under the edge's key, as 64 hex characters; null without a key or an address. */
export async function clientHash(secret: string | undefined, address: string | null | undefined) {
  const key = clientKey(address);
  if (!secret || !key) return null;
  const hmac = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`forge-client-v1\0${key}`));
  return Array.from(new Uint8Array(mac), byte => byte.toString(16).padStart(2, '0')).join('');
}
