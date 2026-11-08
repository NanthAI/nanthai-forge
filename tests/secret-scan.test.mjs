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
import { secretAllowAlert, secretAllowMark } from '../dist/secret-allow.js';
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

test('a private key escaped inside JSON is found, with LF or CRLF escapes', () => {
  for (const newline of ['\n', '\r\n']) {
    const json = JSON.stringify({ type: 'service_account', private_key: fake.key.replaceAll('\n', newline) });
    assert.deepEqual(
      scanSecretText('credentials.json', json).map(item => item.kind),
      ['private-key'],
      JSON.stringify(newline),
    );
  }
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
  const result = scanSecretPaths(['a.txt', 'b.bin', 'c.txt', 'gone.txt'], read, { baseAllow: undefined });
  assert.deepEqual(
    result.findings.map(item => item.path),
    ['a.txt'],
  );
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.skippedFiles, 2);
  // The change's own allow file is not read unless it changed: entries count from main only (R-01).
  assert.deepEqual(reads.sort(), ['a.txt', 'b.bin', 'c.txt', 'gone.txt'].sort());
});

test('a private-audience file holding the same token has no finding; a public one does', () => {
  const read = files({ '.env': `TOKEN=${fake.github}\n`, 'config/.env': `TOKEN=${fake.github}\n` });
  const isPrivate = path => path === '.env';
  const result = scanSecretPaths(['.env', 'config/.env'], read, { isPrivate, baseAllow: undefined });
  assert.deepEqual(
    result.findings.map(item => [item.path, item.line, item.kind]),
    [['config/.env', 1, 'github-token']],
  );
  assert.equal(result.skippedFiles, 1);
  // Without the audience flag both are public, and both are found.
  assert.equal(scanSecretPaths(['.env', 'config/.env'], read, { baseAllow: undefined }).findings.length, 2);
});

test('an allow entry with a reason overrides one finding by fingerprint, scoped to its path', () => {
  const text = `TOKEN=${fake.github}\nOTHER=${fake.aws}\n`;
  const [first] = scanSecretText('src/fixture.ts', text);
  assert.equal(first.fingerprint, secretFingerprint('src/fixture.ts', 'github-token', fake.github));
  const allow = reason =>
    JSON.stringify({ allow: [{ fingerprint: first.fingerprint, path: 'src/fixture.ts', reason }] });
  // The entry is on the base (main); the change under check only touches the fixture.
  const scan = (allowText, paths = ['src/fixture.ts']) =>
    scanSecretPaths(paths, files({ 'src/fixture.ts': text, 'src/copy.ts': text }), {
      baseAllow: Buffer.from(allowText),
    });
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
  const result = scanSecretPaths(['many.txt'], files({ 'many.txt': text }), { baseAllow: undefined });
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
    scanSecretPaths(Object.keys(entries), read, { baseAllow: undefined });
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

// Issue 93e14bb0, R-01: allow entries take effect only from the base (main) State.
const allowFile = entries => JSON.stringify({ allow: entries });
const selfAllowCase = () => {
  const text = `TOKEN=${fake.github}\n`;
  const [finding] = scanSecretText('src/fixture.ts', text);
  const entry = { fingerprint: finding.fingerprint, path: 'src/fixture.ts', reason: 'Synthetic fixture.' };
  return { text, finding, entry };
};

test('R-01: a change that adds a finding and its own allow entry still fails, labelled as self-allow', () => {
  const { text, entry } = selfAllowCase();
  const change = files({ 'src/fixture.ts': text, [SECRET_SCAN_ALLOW_FILE]: allowFile([entry]) });
  const result = scanSecretPaths(['src/fixture.ts', SECRET_SCAN_ALLOW_FILE], change, {
    baseAllow: undefined,
  });
  assert.deepEqual(
    result.findings.map(item => [item.path, item.kind, item.fingerprint]),
    [['src/fixture.ts', 'github-token', entry.fingerprint]],
  );
  assert.equal(result.allowed, 0);
  assert.equal(result.selfAllowed, 1);
  assert.deepEqual(result.allowChanges, {
    entries: [{ ...entry, change: 'added', sameLanding: true }],
    more: 0,
  });
  const notice = secretScanNotice(result).join('\n');
  assert.match(notice, /1 finding\(s\) match an allow entry added in this same change/);
  assert(!notice.includes(fake.github) && !JSON.stringify(result).includes(fake.github));
});

test('R-01: the same entry already on main passes, and an allow-only change reports what it adds', () => {
  const { text, entry } = selfAllowCase();
  const onMain = scanSecretPaths(['src/fixture.ts'], files({ 'src/fixture.ts': text }), {
    baseAllow: Buffer.from(allowFile([entry])),
  });
  assert.deepEqual(onMain.findings, []);
  assert.equal(onMain.allowed, 1);
  assert.equal(onMain.allowChanges, undefined, 'no allow-file change, no allow evidence');
  // The entry lands on its own first: no finding in that change, one added entry, not a self-allow.
  const allowOnly = scanSecretPaths(
    [SECRET_SCAN_ALLOW_FILE],
    files({ [SECRET_SCAN_ALLOW_FILE]: allowFile([entry]) }),
    { baseAllow: undefined },
  );
  assert.deepEqual(allowOnly.findings, []);
  assert.deepEqual(allowOnly.allowChanges.entries, [{ ...entry, change: 'added', sameLanding: false }]);
});

test('allow changes: edited reasons, unchanged entries, bounds and a credential-looking reason', () => {
  const { entry } = selfAllowCase();
  const base = Buffer.from(allowFile([entry]));
  const diff = entries =>
    scanSecretPaths([SECRET_SCAN_ALLOW_FILE], files({ [SECRET_SCAN_ALLOW_FILE]: allowFile(entries) }), {
      baseAllow: base,
    }).allowChanges;
  assert.deepEqual(diff([entry]), { entries: [], more: 0 }, 'an unchanged entry is not a change');
  assert.deepEqual(diff([]), { entries: [], more: 0 }, 'a removal is not an addition');
  assert.deepEqual(diff([{ ...entry, reason: 'Wider reason.' }]).entries, [
    { ...entry, reason: 'Wider reason.', change: 'edited', sameLanding: false },
  ]);
  const leaky = diff([{ ...entry, path: 'src/other.ts', reason: `it is ${fake.github}` }]);
  assert.equal(leaky.entries[0].reason, '[withheld: looks like a credential]');
  assert(!JSON.stringify(leaky).includes(fake.github));
  const many = Array.from({ length: 25 }, (_, i) => ({
    ...entry,
    fingerprint: i.toString(16).padStart(16, '0'),
    reason: `r${i}`,
  }));
  const bounded = diff(many);
  assert.equal(bounded.entries.length, 20);
  assert.equal(bounded.more, 5);
});

test('the failure notice puts remove and rotate first and says an allow entry needs its own landing', () => {
  const findings = scanSecretText('config/app.env', `TOKEN=${fake.github}\n`);
  const lines = secretScanNotice({ findings, more: 0 });
  const advice = lines.filter(line => !/^secret-scan: config\//.test(line));
  assert.match(advice[0], /^secret-scan: remove the credential .* rotate it/);
  assert.match(
    advice[1],
    /only if it is not a secret.* in its own landing first.* only once they are on main/,
  );
  assert.match(
    lines.at(-1),
    /^SecretScanError: .*Remove and rotate it first; an allow entry .* needs its own landing\.$/,
  );
  assert(lines.findIndex(line => /rotate/.test(line)) < lines.findIndex(line => /allow/.test(line)));
});

test('receipt mark and owner alert: one per allow change, none without; self-allow labelled; never a value', () => {
  const { entry } = selfAllowCase();
  const input = {
    project: 'demo',
    receiptId: 'r-1',
    submissionId: 's-1',
    operationId: 'o-1',
    actor: 'an agent',
    agentRun: 'cheery-thrush',
  };
  const evidence = { entries: [{ ...entry, change: 'added', sameLanding: true }], more: 0 };
  const mark = secretAllowMark(evidence, [SECRET_SCAN_ALLOW_FILE]);
  assert.deepEqual(mark, { ...evidence, scanned: true });
  const alert = secretAllowAlert(mark, input);
  assert.match(alert.subject, /self-allow entry landed: demo/);
  assert.match(
    alert.text,
    new RegExp(`added src/fixture\\.ts fingerprint ${entry.fingerprint}: Synthetic fixture\\.`),
  );
  assert.match(alert.text, /\[SELF-ALLOW: this same landing also adds the finding it allows/);
  for (const text of [alert.subject, alert.text, JSON.stringify(mark)]) assert(!text.includes(fake.github));
  // No allow-file change: no mark, so no alert. Only removals: no mark either.
  assert.equal(secretAllowMark(undefined, ['src/a.ts']), undefined);
  assert.equal(secretAllowMark(undefined, null), undefined);
  assert.equal(secretAllowMark({ entries: [], more: 0 }, [SECRET_SCAN_ALLOW_FILE]), undefined);
  // Changed but not diffed by a Forge executor (bring-your-own check, older runner): still marked.
  const unscanned = secretAllowMark(undefined, [SECRET_SCAN_ALLOW_FILE]);
  assert.deepEqual(unscanned, { entries: [], more: 0, scanned: false });
  assert.match(secretAllowAlert(unscanned, input).text, /changed, but no Forge check diffed it/);
  // A malformed plan value is treated as unscanned, never as no change.
  assert.equal(secretAllowMark({ entries: 'x' }, [SECRET_SCAN_ALLOW_FILE]).scanned, false);
});

test('machine runner R-01: allow entries come from the base State; the self-allow fails, main passes', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { HostedCheckoutCache } = await import('../dist/hosted-checkout-cache.js');
  const { machineSecretScan } = await import('../dist/hosted-mac-execute.js');
  const objects = new Map();
  const put = text => {
    const bytes = Buffer.from(text),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    objects.set(sha256, bytes);
    return sha256;
  };
  const file = (path, text) => ({ path, blob: put(text), mode: 'file' });
  const state = files =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files,
        at: '2026-01-01T00:00:00.000Z',
        message: 'synthetic',
      }),
    );
  const requested = [];
  const transport = {
    objects: async ids =>
      ids.map(sha256 => (requested.push(sha256), { sha256, size: objects.get(sha256).length })),
    downloadToFile: async (pin, path) =>
      (await import('node:fs/promises')).writeFile(path, objects.get(pin.sha256)),
  };
  const scan = async (baseFiles, files) => {
    const root = mkdtempSync(joinPath(tmpdir(), 'forge-secret-scan-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cache = new HostedCheckoutCache(root, transport, joinPath(root, 'objects'), null);
    return machineSecretScan(cache, state(baseFiles), files, new AbortController().signal);
  };
  const { text, entry } = selfAllowCase();
  const readme = file('README.md', 'synthetic');
  const token = file('src/fixture.ts', text);
  const allow = file(SECRET_SCAN_ALLOW_FILE, allowFile([entry]));
  // The change adds the token and its own entry: the entry does not count.
  const self = await scan([readme], [readme, token, allow]);
  assert.equal(self.findings.length, 1);
  assert.equal(self.selfAllowed, 1);
  assert.equal(self.allowChanges.entries[0].sameLanding, true);
  // The same entry already on main: the token passes; only changed blobs and the base allow file are read.
  requested.length = 0;
  const onMain = await scan([readme, allow], [readme, token, allow]);
  assert.deepEqual(onMain.findings, []);
  assert.equal(onMain.allowed, 1);
  assert.equal(onMain.allowChanges, undefined);
  assert(!requested.includes(readme.blob), 'unchanged files are not fetched before the plan');
  assert(!JSON.stringify([self, onMain]).includes(fake.github));
});
