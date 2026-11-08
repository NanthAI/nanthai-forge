// SPDX-License-Identifier: Apache-2.0
// Signed releases for updater tests. Release signatures are required, and the compiled
// CLI_RELEASE_KEYS belong to a key no test holds. In-process tests hand the updater a key made
// for this test process (`releaseCheck.trust`); processes a test spawns through the real launcher
// run a copy of dist whose cli-release-keys.js lists that key. There is no production override:
// a process only trusts the keys compiled into the build it runs.
import { generateKeyPairSync } from 'node:crypto';
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliReleaseKeyId, cliReleasePublicKey, signCliRelease } from '../dist/cli-release-trust.js';

const { privateKey } = generateKeyPairSync('ed25519');
/** PKCS#8 PEM of this test process's release key (synthetic; never leaves the test). */
export const testReleasePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicKey = cliReleasePublicKey(privateKey);
export const testReleaseKey = { id: cliReleaseKeyId(publicKey), publicKey };

/** Release numbers only go up, so no install looks like a downgrade. */
let release = Date.now();
/** Updater dependencies for an in-process test: signatures required, every State signed. */
export function signedReleases(projectId) {
  return {
    signatures: async head => [signCliRelease(testReleasePem, projectId, head, ++release)],
    releaseCheck: { trust: { keys: [testReleaseKey], required: true } },
  };
}

const root = fileURLToPath(new URL('..', import.meta.url));
let trusted = null;
/** A copy of dist (hard links where the file system allows) that trusts `testReleaseKey`, next to
 * links to the rest of the repository. Made once per test process. */
export function trustedDist() {
  if (trusted) return trusted;
  const directory = mkdtempSync(join(tmpdir(), 'forge-test-release-dist-'));
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  // Everything else (package.json, node_modules, scripts dist imports) is the repository's own.
  for (const entry of readdirSync(root))
    if (entry !== 'dist') symlinkSync(join(root, entry), join(directory, entry));
  const copy = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(join(from, entry.name), join(to, entry.name));
      else
        try {
          linkSync(join(from, entry.name), join(to, entry.name));
        } catch {
          copyFileSync(join(from, entry.name), join(to, entry.name));
        }
    }
  };
  copy(join(root, 'dist'), join(directory, 'dist'));
  const keys = join(directory, 'dist', 'cli-release-keys.js');
  rmSync(keys);
  writeFileSync(keys, `export const CLI_RELEASE_KEYS = [${JSON.stringify(testReleaseKey)}];\n`);
  trusted = {
    dist: join(directory, 'dist'),
    url: name => pathToFileURL(join(directory, 'dist', name)).href,
  };
  return trusted;
}

/** The same updater dependencies with every State signed by `testReleaseKey` (signatures stay
 * required). A test's own `source.signatures` or `releaseCheck.trust` wins. */
export function withSignedReleases(dependencies, projectId) {
  if (!dependencies?.source) return dependencies;
  const signed = signedReleases(projectId);
  return {
    ...dependencies,
    source: { signatures: signed.signatures, ...dependencies.source },
    releaseCheck: { ...signed.releaseCheck, ...dependencies.releaseCheck },
  };
}

/** Worker data for scripts/package-cli-release-worker.mjs: sign every State with this key. */
export const testReleaseSigner = () => ({ keyId: testReleaseKey.id, pem: testReleasePem });
