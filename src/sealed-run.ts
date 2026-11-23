// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { invariant } from './errors.js';
import { sealedClientForRoot } from './sealed-cli.js';
import type { SealedClient } from './sealed-client.js';
import type { RunSecretProvider } from './secret-run.js';

/** `nforge run` for one device: a verified cached read. A joining device posts its own request and waits
 * (SECRETS_WAITING); a holder device also shares Development with waiting devices on this run (design 5.1). */
export async function sealedRunFor(client: SealedClient, set: 'development' | 'checks') {
  invariant(set === 'development', 'SECRETS_NOT_SET_UP', 'Checks delivery is not connected in this slice.');
  const result = await client.read(true);
  invariant(
    result,
    'SECRETS_NOT_SET_UP',
    'Development is not set up. The owner runs nforge secret set NAME.',
  );
  result.key?.fill(0);
  return { secrets: result.secrets };
}
export const sealedRunSecrets: RunSecretProvider = async input => {
  invariant(
    input.set === 'development',
    'SECRETS_NOT_SET_UP',
    'Checks delivery is not connected in this slice.',
  );
  const client = await sealedClientForRoot(input.root);
  try {
    return await sealedRunFor(client, input.set);
  } finally {
    for (const key of [client.keys.sign, client.keys.enc, client.keys.pinKey]) key.fill(0);
  }
};
