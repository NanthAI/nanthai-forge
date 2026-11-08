// SPDX-License-Identifier: Apache-2.0
// Issue 9fac9a0e: a tracked file is published whatever its name; a new file's
// credential-looking name only prompts a content check. Synthetic fixtures only:
// keys and tokens are generated per run, never committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMirror, stepMirror } from '../dist/hosted-github-mirror.js';
import { scanSourcePaths } from '../dist/source-paths.js';
import { notSavedCollector, notSavedInclude } from '../dist/save-not-saved.js';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';

const privateKey = () =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKey = () =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
const certificate = () =>
  `-----BEGIN CERTIFICATE-----\n${randomBytes(96).toString('base64')}\n-----END CERTIFICATE-----\n`;
const npmToken = () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return `npm_${[...randomBytes(36)].map(byte => alphabet[byte % alphabet.length]).join('')}`;
};
/** What a repository like t3code, a TLS library or a pnpm/Vite/direnv repo tracks. */
const tracked = () => ({
  'src/a.ts': 'export const a = 1;\n',
  'tests/fixtures/key1.pem': privateKey(),
  'tests/fixtures/root-ca.pem': certificate(),
  'tests/fixtures/server.key': privateKey(),
  '.envrc': 'use flake\n',
  '.npmrc': 'auto-install-peers=true\n',
  '.env.development': 'VITE_API_URL=http://localhost:3000\n',
  '.env.example': 'API_URL=\n',
});
const credentialNames = [
  '.env.development',
  '.npmrc',
  'tests/fixtures/key1.pem',
  'tests/fixtures/root-ca.pem',
  'tests/fixtures/server.key',
];
const isCredentialName = path => credentialNames.includes(path);

async function drain(f) {
  let plan = await prepareMirror(f.seed, f.io);
  while (plan.phase !== 'done') plan = await stepMirror(structuredClone(plan), f.io);
  return plan;
}
const githubPaths = (f, plan) =>
  f.trees
    .get(plan.entry.tree)
    .map(file => file.path)
    .sort();

test('a repository tracking credential-looking fixtures mirrors to GitHub byte-identical', async () => {
  for (const verified of [true, false]) {
    const before = tracked(),
      after = {
        ...before,
        'src/a.ts': 'export const a = 2;\n',
        '.npmrc': 'strict-peer-dependencies=false\n',
      };
    const f = mirrorFixture({ verified, before, after });
    f.root.publication = 'tracked';
    const plan = await drain(f);
    assert.equal(plan.entry.tree, f.expected(), `verified=${verified}: every tracked byte reaches GitHub`);
    assert.equal(plan.entry.publication, 'tracked');
    assert.deepEqual(
      plan.pending.map(file => file.path).sort(),
      ['.npmrc', 'src/a.ts'],
      'only changed files are uploaded',
    );
  }
});

test('an older mirror that dropped tracked credential names gets them back once', async () => {
  for (const verified of [true, false]) {
    const before = tracked(),
      after = { ...before, 'src/a.ts': 'export const a = 2;\n' };
    delete after['tests/fixtures/server.key'];
    // GitHub main was written by the old name rule: no credential-looking names on it.
    const f = mirrorFixture({ verified, before, after, onGithub: path => !isCredentialName(path) });
    const plan = await drain(f);
    assert.equal(plan.entry.tree, f.expected(), `verified=${verified}`);
    assert.deepEqual(githubPaths(f, plan), Object.keys(after).sort());
    // The deleted fixture was never on GitHub, so no deletion entry names it.
    const tree = f.calls.find(call => call.path.endsWith('/trees')).body.tree;
    assert(!tree.some(entry => entry.path === 'tests/fixtures/server.key'));
    assert.equal(plan.entry.publication, 'tracked');
  }
});

test('the mirror still leaves Forge private-artifacts out', async () => {
  const f = mirrorFixture({
    before: { 'a.txt': 'a' },
    after: { 'a.txt': 'b', 'private-artifacts/perf/result.json': '{}\n', 'key1.pem': privateKey() },
  });
  const plan = await drain(f);
  assert.deepEqual(githubPaths(f, plan), ['a.txt', 'key1.pem']);
});

function tree(t, files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-tracked-names-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), value);
  }
  return root;
}

test('saves keep tracked credential-looking files whatever their bytes', t => {
  const files = { ...tracked(), '.env': `API_KEY=${randomBytes(24).toString('base64')}\n` };
  const root = tree(t, files),
    notSaved = notSavedCollector();
  const paths = scanSourcePaths(root, { retained: Object.keys(files), onExcluded: notSaved.onExcluded });
  assert.deepEqual(paths, Object.keys(files).sort());
  assert.equal(notSaved.value(), undefined);
});

test('a new file is held only when its bytes hold a credential, with a way to include it', t => {
  const root = tree(t, {
    'a.txt': 'a\n',
    // Saved: no credential in the bytes.
    'tls/root-ca.pem': certificate(),
    'tls/public.pem': publicKey(),
    '.npmrc': '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n',
    '.env.development': 'VITE_API_URL=http://localhost:3000\n',
    '.envrc': 'use flake\n',
    'internal/secrets/defaults.yaml': 'region: local\n',
    // Held by content.
    'tls/server.key': privateKey(),
    'pkg/.npmrc': `//registry.npmjs.org/:_authToken=${npmToken()}\n`,
    // Held by name: local credential files and bytes that cannot be checked as text.
    '.env.local': 'A=1\n',
    'tls/client.p12': Buffer.from([0x30, 0x82, 0x00, 0x01, 0x00, 0x02]),
    // A deliberate include of a test key; a local env file is never re-included.
    'fixtures/test.key': privateKey(),
    '.forgeignore': '!fixtures/test.key\n!.env.local\n',
    // Ignored: never read, never listed.
    '.gitignore': 'ignored.pem\n',
    'ignored.pem': privateKey(),
  });
  const notSaved = notSavedCollector();
  const paths = scanSourcePaths(root, { onExcluded: notSaved.onExcluded });
  assert.deepEqual(paths, [
    '.env.development',
    '.envrc',
    '.forgeignore',
    '.gitignore',
    '.npmrc',
    'a.txt',
    'fixtures/test.key',
    'internal/secrets/defaults.yaml',
    'tls/public.pem',
    'tls/root-ca.pem',
  ]);
  assert.deepEqual(notSaved.value(), {
    count: 4,
    paths: [
      { path: '.env.local', reason: 'sensitive-name' },
      { path: 'pkg/.npmrc', reason: 'secret-content' },
      { path: 'tls/client.p12', reason: 'sensitive-name' },
      { path: 'tls/server.key', reason: 'secret-content' },
    ],
    include: notSavedInclude,
  });
});
