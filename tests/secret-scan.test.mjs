// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanSecretPaths,
  scanSecretText,
  secretScanNotice,
  secretFingerprint,
  SECRET_SCAN_ALLOW_FILE,
  SECRET_SCAN_MAX_FINDINGS,
  changedStatePaths,
  secretScanFailureCommand,
} from '../dist/secret-scan.js';
import { spawnSync } from 'node:child_process';

// Obviously fake tokens with real shapes, assembled at run time so this file's own
// source never holds a match (a landing that touches it is not stopped).
const join = (...parts) => parts.join('');
const fake = {
  github: join('gh', 'p_', 'FORGEfake0TEST1never2REAL3token4XYZ5ab'),
  aws: join('AK', 'IA', 'FORGE0FAKE1TEST2'),
  stripe: join('sk', '_live_', 'FORGEfake0TEST1never2REAL'),
  slack: join('xo', 'xb-', '1234567890-1234567890-', 'FORGEfake0TEST1never2REALx'),
  anthropic: join('sk', '-ant-', 'api03-FORGEfake0TEST1never2REAL3token4XYZ'),
  key: join('-----BEGIN ', 'PRIVATE KEY-----\n', 'FORGEfake0TEST1never2REAL3key4body5xyzABCDEF6GHIJ7', '\n'),
  random: join('Fq7', 'Zt2Kp9Wm4Xv8Rb3Ny6Lc1Hd5Gs0Ja'),
};
const files = entries => {
  const map = new Map(Object.entries(entries).map(([path, text]) => [path, Buffer.from(text)]));
  return path => map.get(path);
};

test('known token shapes are found by path, line and kind, never by value', () => {
  const text = [
    'const a = 1;',
    `GITHUB=${fake.github}`,
    `aws ${fake.aws}`,
    `stripe: '${fake.stripe}'`,
    `slack ${fake.slack}`,
    `anthropic ${fake.anthropic}`,
    fake.key,
    `client_secret = "${fake.random}"`,
  ].join('\n');
  const found = scanSecretText('config/app.env', text);
  assert.deepEqual(
    found.map(item => [item.line, item.kind]),
    [
      [2, 'github-token'],
      [3, 'aws-access-key-id'],
      [4, 'live-secret-key'],
      [5, 'slack-token'],
      [6, 'anthropic-api-key'],
      [7, 'private-key'],
      [10, 'high-entropy-secret'],
    ],
  );
  const notice = secretScanNotice({ findings: found, more: 0 }).join('\n');
  for (const value of Object.values(fake))
    assert(!notice.includes(value.trim()), 'notice never prints a value');
  assert.match(notice, /config\/app\.env:2 github-token \(fingerprint [0-9a-f]{16}\)/);
  assert.match(notice, /^SecretScanError: committed credential found in config\/app\.env:2 /m);
});

test('placeholders, documented examples, hashes and bare headers are not findings', () => {
  const text = [
    join('gh', 'p_', 'x'.repeat(36)),
    join('AK', 'IA', 'IOSFODNN7', 'EXAMPLE'),
    `token: '${'a1b2c3d4e5f6'.repeat(6)}'`,
    `sha256 = "${'0123456789abcdef'.repeat(4)}"`,
    `apiKey = process.env.FORGE_API_KEY`,
    join('-----BEGIN ', 'RSA PRIVATE KEY-----'),
  ].join('\n');
  assert.deepEqual(scanSecretText('docs/example.md', text), []);
});

test('only changed paths are read; binary, large, deleted and link paths are skipped', () => {
  const reads = [];
  const read = path => {
    reads.push(path);
    return {
      'a.txt': Buffer.from(`token=${fake.github}`),
      'b.bin': Buffer.concat([Buffer.from([0]), Buffer.from(fake.github)]),
      'c.txt': Buffer.from(`${'x'.repeat(1024 * 1024)}${fake.github}`),
    }[path];
  };
  const result = scanSecretPaths(['a.txt', 'b.bin', 'c.txt', 'gone.txt'], read);
  assert.deepEqual(
    result.findings.map(item => item.path),
    ['a.txt'],
  );
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.skippedFiles, 2);
  assert.deepEqual(reads.sort(), [SECRET_SCAN_ALLOW_FILE, 'a.txt', 'b.bin', 'c.txt', 'gone.txt'].sort());
});

test('a private-audience file holding the same token has no finding; a public one does', () => {
  const read = files({ '.env': `TOKEN=${fake.github}\n`, 'config/.env': `TOKEN=${fake.github}\n` });
  const isPrivate = path => path === '.env';
  const result = scanSecretPaths(['.env', 'config/.env'], read, { isPrivate });
  assert.deepEqual(
    result.findings.map(item => [item.path, item.line, item.kind]),
    [['config/.env', 1, 'github-token']],
  );
  assert.equal(result.skippedFiles, 1);
  // Without the audience flag both are public, and both are found.
  assert.equal(scanSecretPaths(['.env', 'config/.env'], read).findings.length, 2);
});

test('an allow entry with a reason overrides one finding by fingerprint, scoped to its path', () => {
  const text = `TOKEN=${fake.github}\nOTHER=${fake.aws}\n`;
  const [first] = scanSecretText('src/fixture.ts', text);
  assert.equal(first.fingerprint, secretFingerprint('src/fixture.ts', 'github-token', fake.github));
  const allow = reason =>
    JSON.stringify({ allow: [{ fingerprint: first.fingerprint, path: 'src/fixture.ts', reason }] });
  const scan = (allowText, paths = ['src/fixture.ts']) =>
    scanSecretPaths(
      paths,
      files({ 'src/fixture.ts': text, 'src/copy.ts': text, [SECRET_SCAN_ALLOW_FILE]: allowText }),
    );
  const allowed = scan(allow('Synthetic fixture for a redaction test.'));
  assert.deepEqual(
    allowed.findings.map(item => item.kind),
    ['aws-access-key-id'],
  );
  assert.equal(allowed.allowed, 1);
  // No reason, no override; another path with the same value is still found.
  assert.equal(scan(allow('  ')).findings.length, 2);
  assert.equal(scan(allow('fixture'), ['src/copy.ts']).findings.length, 2);
  assert.equal(scan('not json').findings.length, 2);
});

test('findings are capped and counted', () => {
  const text = Array.from({ length: SECRET_SCAN_MAX_FINDINGS + 5 }, (_, i) =>
    join('gh', 'p_', `FORGEfake${String(i).padStart(2, '0')}TEST1never2REAL3token4XYZ`),
  ).join('\n');
  const result = scanSecretPaths(['many.txt'], files({ 'many.txt': text }));
  assert.equal(result.findings.length, SECRET_SCAN_MAX_FINDINGS);
  assert.equal(result.more, 5);
  assert.match(secretScanNotice(result).at(-1), /; \+5 more\. /);
});

test('scan time of a typical changed-path set stays well under the landing budget', t => {
  // 40 changed files of 20 KiB source each (above the dogfood median diff).
  const body = 'export const value = computeSomething(input, options);\n'.repeat(380);
  const entries = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`src/file-${i}.ts`, body]));
  const read = files(entries);
  const times = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    scanSecretPaths(Object.keys(entries), read);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95) - 1];
  t.diagnostic(JSON.stringify({ files: 40, bytes: 40 * body.length, p95Ms: Number(p95.toFixed(2)) }));
  // Generous ceiling for loaded CI machines; the measured value is reported in the diagnostic.
  assert(p95 < 1000, `p95 ${p95} ms`);
});

test('machine runner: changed paths come from the base State; an unreadable base scans every file', () => {
  const file = (path, blob, mode = 'file') => ({ path, blob, mode });
  const before = [file('a', '1'), file('b', '2'), file('c', '3')];
  const after = [file('a', '1'), file('b', '9'), file('c', '3', 'executable'), file('d', '4')];
  assert.deepEqual(changedStatePaths(before, after), ['b', 'c', 'd']);
  assert.deepEqual(changedStatePaths(null, after), ['a', 'b', 'c', 'd']);
});

test('the failure command exits non-zero and prints the notice without the value', () => {
  const findings = scanSecretText('config/app.env', `TOKEN=${fake.github}\n`);
  const [executable, ...args] = secretScanFailureCommand(process.execPath, { findings, more: 0 });
  assert(!args.join(' ').includes(fake.github));
  const child = spawnSync(executable, args, { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /SecretScanError: .*config\/app\.env:1 github-token/);
  assert(!child.stderr.includes(fake.github) && !child.stdout.includes(fake.github));
});
