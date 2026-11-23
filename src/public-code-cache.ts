// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { safeRelative } from './safe-relative.js';
import { CODE_DIR_DEPTH } from './code-tree.js';

export const PUBLIC_CODE_TTL_MS = 30_000;
export const PUBLIC_CODE_EXPIRY = 'x-forge-code-expires';
export const PUBLIC_CODE_DELIVERY = 'x-forge-code-delivery';
export const PUBLIC_CODE_INGRESS = 'x-forge-code-ingress';
export const PUBLIC_CODE_JSON = 'application/json; charset=utf-8';
export const PUBLIC_CODE_BROWSER = 'public, max-age=0, must-revalidate';
export const PUBLIC_CODE_SHARED = 'public, durable, s-maxage=30, must-revalidate';

const address =
  /^\/public\/v1\/code\/[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}\/[a-f0-9]{64}\/(open|page)\/((?:[a-f0-9]{2}){1,1024})(?:\/(0|[1-9][0-9]{0,15}))?\.json$/;

/** Non-root opens can resolve to folders. Only the origin knows which opens contain a file. */
export function publicCodeFileAddress(pathname: string) {
  const match = address.exec(pathname);
  if (!match) return false;
  const [, kind, hex, offset] = match;
  if (kind === 'open' ? offset !== undefined : !Number.isSafeInteger(Number(offset))) return false;
  try {
    const bytes = new Uint8Array(hex!.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex!.slice(i * 2, i * 2 + 2), 16);
    const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return safeRelative(path) && path.split('/').length <= CODE_DIR_DEPTH + 1;
  } catch {
    return false;
  }
}

export function publicCodeRemaining(expiresAt: number) {
  const remaining = expiresAt - Date.now();
  return Number.isSafeInteger(expiresAt) && remaining > 0 && remaining <= PUBLIC_CODE_TTL_MS ? remaining : 0;
}

/** Derive a scoped credential so the site's existing origin key never travels on the ingress hop. */
export function publicCodeIngressKey(originKey: string) {
  return publicCodeDigest(`forge-public-code-ingress-v1\0${originKey}`);
}

export async function publicCodeDigest(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
