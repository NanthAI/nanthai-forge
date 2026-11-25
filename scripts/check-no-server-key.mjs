// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// No-server-key guard (Item 41a0df87, slice 6; owner decision 8: "a copy of our database reveals names, never
// values"). A copy of the database, a backup or an object-storage copy holds no value a team stored and no key that
// opens one. Per file, so `npm run check` runs it over the whole tree and a preflight over the changed files:
//   1. the retired Secret Object keyring (FORGE_SECRET_KEYS) is read nowhere;
//   2. every key-like server setting in convex/ is a named service credential, so a new one must say what it is;
//   3. the sealed-set server modules read no setting and hold no cipher: they store and verify, never open;
//   4. only the GitHub token store seals under a server keyring;
//   5. no backup, export, archive or exchange module reads a sealed table.
// Findings name file, line and rule only; never the matched text.

// Each key-like setting the server reads, with its class. None opens a value a team stores: each is the server's own
// credential for a provider or for a signature it makes. Adding one that looks like a key fails until it is named.
export const SERVICE_SETTINGS = new Map([
  ['AUTH_GITHUB_CLIENT_SECRET', 'GitHub sign-in client secret'],
  ['FORGE_CLI_PRIVATE_KEY', 'signs the tokens Forge issues to devices'],
  [
    'FORGE_GITHUB_TOKEN_KEYRING',
    'seals GitHub App user tokens only (src/secret-crypto.ts); never a team value',
  ],
  ['FORGE_HOSTED_ACTIONS_CONTROLLER_KEY', 'authenticates the check controller to Forge'],
  ['FORGE_HOSTED_CHECK_KEY_ID', 'names the active check-signing key'],
  ['FORGE_PUBLIC_READ_SECRET', 'authenticates the public site to Forge'],
  ['FORGE_PUBLIC_SNAPSHOT_PURGE_TOKEN', 'authenticates the public snapshot purge worker to Forge'],
  ['FORGE_SITE_DEVICE_KEY', 'authenticates the site Worker to Forge'],
  ['GITHUB_APP_CLIENT_SECRET', 'GitHub App client secret'],
  ['GITHUB_APP_PRIVATE_KEY', 'signs GitHub App installation requests'],
  ['GITHUB_PUBLIC_TOKEN', 'read token for public GitHub data'],
  ['GITHUB_WEBHOOK_SECRET', 'verifies GitHub webhooks'],
  ['R2_SECRET_ACCESS_KEY', 'object storage access'],
]);
// Files that read a setting by a computed name, with the family of names each reads.
export const COMPUTED_SETTINGS = new Set([
  'convex/projectHostedOutputApi.ts', // FORGE_HOSTED_CHECK_KEY_<id>
  'convex/projectHostedCheckApi.ts', // FORGE_HOSTED_CHECK_KEY_<id>
  'convex/projectHostedActionsReconcile.ts', // FORGE_HOSTED_CHECK_KEY_<id>
  'convex/legacyStoragePause.ts', // a pause flag, no key
  'convex/legacyStorageServer.ts', // a pause flag, no key
  'convex/auth.ts', // required auth settings by name
]);
export const SEALER_MODULES = new Set(['convex/githubUserTokenActions.ts']);
const KEY_LIKE =
  /process\.env\.([A-Z0-9_]*(?:KEY|SECRET|SEAL|PRIVATE|PASSWORD|TOKEN|CREDENTIAL|JWT)[A-Z0-9_]*)/g;
const COPY_MODULE = /(?:backup|export|archive|exchange|snapshot|durab)/i;
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Findings for one file: `path` is posix, relative to the repository root. */
export function serverKeyFindings(path, text) {
  const out = [];
  const add = (index, rule) => out.push(`${path}:${lineOf(text, index)}: ${rule}`);
  const code = /^(?:convex|src|scripts|web\/src|site)\//.test(path) && /\.(?:ts|tsx|mjs|js)$/.test(path);
  if (!code || path === 'scripts/check-no-server-key.mjs') return out;
  for (const match of text.matchAll(/FORGE_SECRET_KEYS/g))
    add(
      match.index,
      'reads or sets the retired Secret Object keyring FORGE_SECRET_KEYS (deleted: no server key opens a team value)',
    );
  if (!path.startsWith('convex/') || path.startsWith('convex/_generated/')) return out;
  for (const match of text.matchAll(KEY_LIKE))
    if (!SERVICE_SETTINGS.has(match[1]))
      add(
        match.index,
        'is a new key-like server setting: name its class in scripts/check-no-server-key.mjs, or do not add it',
      );
  for (const match of text.matchAll(/process\.env\[/g))
    if (!COMPUTED_SETTINGS.has(path))
      add(match.index, 'reads a computed server setting: list the file with its name family');
  if (/^convex\/sealed/.test(path)) {
    for (const match of text.matchAll(/process\.env/g))
      add(match.index, 'a sealed-set module reads a server setting');
    for (const match of text.matchAll(
      /createDecipheriv|createCipheriv|openSecret|sealSecret|crypto\.subtle/g,
    ))
      add(match.index, 'a sealed-set module holds a cipher: the server stores and verifies, never opens');
  }
  for (const match of text.matchAll(/secret-crypto/g))
    if (!SEALER_MODULES.has(path))
      add(match.index, 'seals under a server keyring: only the GitHub token store may');
  if (COPY_MODULE.test(path) && /^convex\/[^/]+\.ts$/.test(path))
    for (const match of text.matchAll(/sealedSecret|sealedMachine/g))
      add(match.index, 'a backup, export or archive module would copy sealed records');
  return out;
}
