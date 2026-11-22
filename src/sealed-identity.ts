// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import { forgeSecretId } from './sealed-format.js';
import { openSecretDevice } from './sealed-local.js';
import { SecretPins } from './sealed-pins.js';
import { readAuth } from './auth-store.js';
import { canonicalRoot } from './root-paths.js';
import { secretRunRoot } from './secret-run-cli.js';

/** The token's subject selects local keys; the server independently authenticates every request.
 * The CLI never takes a protocol-width account id from a server reply. */
export function sealedAccount(token: string): string {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    invariant(
      typeof claims.sub === 'string' &&
        claims.sub.length > 0 &&
        typeof claims.forgeCredential === 'string' &&
        typeof claims.forgeSignIn === 'string',
      'AUTH_SCOPE_DENIED',
      'Sealed secrets need a stable device sign-in from nforge login.',
    );
    return claims.sub;
  } catch {
    throw new ForgeError(
      'AUTH_SCOPE_DENIED',
      'Sealed secrets need a stable device sign-in from nforge login.',
    );
  }
}
export async function localSealedIdentity(deployment: string, token: string, root?: string) {
  const account = sealedAccount(token);
  const anchor = readAuth().deployments[deployment]?.sealedAccount;
  invariant(
    process.env.FORGE_AUTH_TOKEN === token || !anchor || anchor === account,
    'AUTH_OPERATION_CHANGED',
    'The renewed sign-in changed account identity. Existing secret trust is preserved; sign in explicitly to select an account.',
  );
  const accountId = forgeSecretId('account', account);
  const originParts = Buffer.from(deployment, 'utf8')
    .toString('base64url')
    .match(/.{1,96}/g)!;
  const directory = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'forge',
    'sealed',
    accountId.toString('hex'),
    'deployments',
    ...originParts,
  );
  const roots = root ? [root] : [];
  try {
    roots.push(secretRunRoot(process.cwd()));
  } catch (error) {
    if (!(error instanceof ForgeError) || error.code !== 'FORGE_ROOT_UNAVAILABLE') throw error;
  }
  for (const tree of roots) {
    const path = relative(canonicalRoot(tree), canonicalRoot(directory));
    invariant(
      isAbsolute(path) || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
      'SECRETS_FORMAT_REFUSED',
      'Keep the secret key store outside project and Lane trees.',
    );
  }
  const { keys, store } = await openSecretDevice(directory, accountId);
  return { account, keys, directory, pins: new SecretPins(directory, store) };
}
