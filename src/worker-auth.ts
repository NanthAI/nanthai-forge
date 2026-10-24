// SPDX-License-Identifier: Apache-2.0
export async function workerAuthorized(
  provided: string | null,
  expected: string | undefined,
): Promise<boolean> {
  if (!provided || !expected) return false;
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    bytes.encode(`Bearer ${expected}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  // Native MAC verification avoids early-exit comparison of the secret on either runtime.
  const signature = await crypto.subtle.sign('HMAC', key, bytes.encode(`Bearer ${expected}`));
  return crypto.subtle.verify('HMAC', key, signature, bytes.encode(provided));
}
