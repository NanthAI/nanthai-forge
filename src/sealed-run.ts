// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { sealedClientForRoot } from './sealed-cli.js';
import type { RunSecretProvider } from './secret-run.js';

export const sealedRunSecrets: RunSecretProvider = async input => {
  invariant(
    input.set === 'development',
    'SECRETS_NOT_SET_UP',
    'Checks delivery is not connected in this slice.',
  );
  const client = await sealedClientForRoot(input.root);
  try {
    const result = await client.read(true);
    invariant(
      result,
      'SECRETS_NOT_SET_UP',
      'Development is not set up. The owner runs nforge secret set NAME.',
    );
    result.key?.fill(0);
    return { secrets: result.secrets };
  } finally {
    for (const key of [client.keys.sign, client.keys.enc, client.keys.pinKey]) key.fill(0);
  }
};
