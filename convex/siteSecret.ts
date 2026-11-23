// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Whether a request carries one of the site's service credentials. Fixed-length digest comparison; the credential
 * never enters a reply or a DB row. */
export async function sameSecret(expected: string | undefined, supplied: string | null) {
  if (!expected || !supplied) return false;
  const hash = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [want, got] = await Promise.all([hash(expected), hash(supplied)]);
  let different = 0;
  for (let i = 0; i < want.length; i++) different |= want[i]! ^ got[i]!;
  return different === 0;
}
