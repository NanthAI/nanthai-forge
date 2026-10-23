// SPDX-License-Identifier: Apache-2.0
export async function githubWebhookAuthorized(
  body: ArrayBuffer,
  signature: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const mac = Uint8Array.from(signature.slice(7).match(/../g)!, pair => parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', key, mac, body);
}
