// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkSecretWriteName,
  secretNameKind,
  secretNameRefusal,
  secretNameRules,
} from '../dist/secret-names.js';
import { parseSecretExample, readSecretExample } from '../dist/secret-env-example.js';
import { secretRunEnvironment } from '../dist/secret-run-environment.js';
import { secretRunOptions, secretRunRoot } from '../dist/secret-run-cli.js';
import {
  policyPreset,
  protectedMatches,
  reviewReason,
  editedPolicy,
  effectivePolicy,
} from '../dist/autonomy-policy.js';

test('T83 release name rules deny program controls, retain routing precedence and credential exemptions', () => {
  const routingExact = new Set(secretNameRules.routing.filter(name => !name.includes('*')));
  const exempt = new Set(secretNameRules.exceptions);
  for (const pattern of secretNameRules.denied) {
    const name = pattern.replaceAll('*', 'EXAMPLE');
    if (routingExact.has(name) || exempt.has(name)) continue;
    assert(['denied', 'invalid'].includes(secretNameKind(name)), name);
    assert(secretNameRefusal(name), name);
  }
  for (const pattern of secretNameRules.routing) {
    const name = pattern.replaceAll('*', 'SERVICE');
    assert.equal(secretNameKind(name), 'routing', name);
    assert.equal(secretNameRefusal(name, true), 'PERSON_REQUIRED', name);
    assert.equal(secretNameRefusal(name), null);
  }
  for (const pattern of secretNameRules.exceptions) {
    const name = pattern.replaceAll('*', 'EXAMPLE');
    assert.equal(secretNameRefusal(name, true), null, name);
  }
  for (const name of [
    'CARGO_REGISTRIES_X_INDEX',
    'CARGO_REGISTRIES_X_CREDENTIAL_PROVIDER',
    'NPM_CONFIG_PROXY',
    'FORGE_PROXY',
    'NODE_CUSTOM_CA_FILE',
  ])
    assert.equal(secretNameKind(name), 'denied', name);
  assert.equal(secretNameKind('NODE_TLS_REJECT_UNAUTHORIZED'), 'routing');
  for (const name of ['lowercase', '_BAD', 'A'.repeat(65), 'BAD\nNAME'])
    assert.equal(secretNameKind(name), 'invalid');
});

test('T83 the seven ordered name rules keep exact controls, routing and the single token exception distinct', () => {
  const cases = [
    ['exact deny', 'PATH', 'denied'],
    ['exact exception', 'NODE_AUTH_TOKEN', 'credential'],
    ['exact routing', 'PIP_INDEX_URL', 'routing'],
    ['exception pattern', 'CARGO_REGISTRIES_X_TOKEN', 'credential'],
    ['deny pattern before routing', 'NPM_CONFIG_PROXY', 'denied'],
    ['routing pattern', 'SERVICE_ENDPOINT_URL_REGION', 'routing'],
    ['plain name', 'SERVICE_TOKEN', 'credential'],
  ];
  for (const [rule, name, expected] of cases) assert.equal(secretNameKind(name), expected, rule);
  for (const name of ['CARGO_REGISTRIES_X_INDEX', 'CARGO_REGISTRIES_X_CREDENTIAL_PROVIDER'])
    assert.equal(secretNameKind(name), 'denied');
  assert.equal(secretNameKind('NODE_EXTRA_CA_CERTS'), 'routing');
  assert.equal(secretNameKind('NODE_TLS_REJECT_UNAUTHORIZED'), 'routing');
});

test('Development writes of the five publish-token exemptions print one plain name-only line; Checks and ordinary names stay quiet', () => {
  for (const pattern of secretNameRules.exceptions.filter(name => name !== 'NODE_ENV')) {
    const name = pattern.replace('*', 'X');
    const lines = [];
    checkSecretWriteName(name, { set: 'development', writeLine: line => lines.push(line) });
    assert.deepEqual(lines, [`${name}: this is a publish token; it belongs in Checks.`]);
    checkSecretWriteName(name, { set: 'checks', writeLine: line => lines.push(line) });
    assert.equal(lines.length, 1);
  }
  const lines = [];
  for (const name of ['NODE_ENV', 'SERVICE_TOKEN'])
    checkSecretWriteName(name, { set: 'development', writeLine: line => lines.push(line) });
  assert.deepEqual(lines, []);
  assert.throws(() => checkSecretWriteName('NODE_OPTIONS', { set: 'development' }), { code: 'BAD_ARGUMENT' });
  assert.throws(() => checkSecretWriteName('PIP_INDEX_URL', { set: 'development', agent: true }), {
    code: 'PERSON_REQUIRED',
  });
});

test('the default write-name boundary prints its publish-token notice on stderr only', () => {
  const printed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {checkSecretWriteName} from './dist/secret-names.js'; checkSecretWriteName('NODE_AUTH_TOKEN', {set:'development'});",
    ],
    { env: {}, encoding: 'utf8' },
  );
  assert.equal(printed.status, 0);
  assert.equal(printed.stdout, '');
  assert.equal(printed.stderr, 'NODE_AUTH_TOKEN: this is a publish token; it belongs in Checks.\n');
});

test('example parser ignores values and comments, deduplicates names and reports refusals without values', () => {
  const parsed = parseSecretExample(
    '\uFEFF# comment\r\nA\r\nB=synthetic-example\nexport C=$(never-execute)\nA=duplicate\nNODE_ENV=dev\nPATH=private-example\nbad=private-example\nD trailing-private-example\nE # comment\n',
  );
  assert.deepEqual(parsed.names, ['A', 'B', 'C', 'NODE_ENV', 'E']);
  assert.deepEqual(
    parsed.notices.map(item => item.name),
    ['A', 'PATH', 'bad', 'D'],
  );
  assert(!JSON.stringify(parsed).includes('private-example'));
  assert(!JSON.stringify(parsed).includes('never-execute'));
});

test('T97 example reader reads only an exactly spelled regular root file and discovers a containing Lane', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-secret-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readSecretExample(root).names, []);
  writeFileSync(join(root, '.ENV.example'), 'A');
  assert.deepEqual(readSecretExample(root), {
    names: [],
    notices: [{ name: '.ENV.example', reason: 'not read; use the exact name .env.example' }],
  });
  rmSync(join(root, '.ENV.example'));
  writeFileSync(join(root, 'other'), 'B=ignored');
  symlinkSync('other', join(root, '.env.example'));
  assert.throws(() => readSecretExample(root), { code: 'SECRETS_ENV_EXAMPLE_NOT_FILE' });
  rmSync(join(root, '.env.example'));
  mkdirSync(join(root, '.env.example'));
  assert.throws(() => readSecretExample(root), { code: 'SECRETS_ENV_EXAMPLE_NOT_FILE' });
  rmSync(join(root, '.env.example'), { recursive: true });
  writeFileSync(join(root, '.env.example'), 'A=ignored');
  assert.deepEqual(readSecretExample(root).names, ['A']);
  mkdirSync(join(root, '.forge'));
  writeFileSync(join(root, '.forge/hosted-lane.json'), '{}');
  mkdirSync(join(root, 'sub'));
  assert.equal(secretRunRoot(join(root, 'sub')), secretRunRoot(root));
});

test('T12 T13 T19 run drops denied and unlisted names, only narrows, and inherited values win including Windows case', () => {
  const secrets = ['API_TOKEN', 'UNLISTED', 'PATH', 'MISSING_OVERRIDE'].map(name => ({
    name,
    kind: 'env',
    value: Buffer.from('synthetic-value'),
  }));
  for (const only of [undefined, ['API_TOKEN', 'UNLISTED']]) {
    const result = secretRunEnvironment({
      source: { API_TOKEN: 'local', MISSING_OVERRIDE: '' },
      names: ['API_TOKEN', 'MISSING', 'MISSING_OVERRIDE'],
      secrets,
      only,
    });
    assert.deepEqual(result.selected, []);
    assert.equal(result.env.API_TOKEN, 'local');
    assert.deepEqual(
      result.notices.map(item => item.name),
      ['UNLISTED', 'PATH', 'MISSING'],
    );
  }
  const windows = secretRunEnvironment({
    source: { Api_Token: 'local' },
    names: ['API_TOKEN'],
    secrets: [secrets[0]],
    platform: 'win32',
  });
  assert.equal(windows.selected.length, 0);
  assert.equal(windows.notices.length, 0);
  const narrowed = secretRunEnvironment({ source: {}, names: ['API_TOKEN'], secrets, only: ['UNLISTED'] });
  assert.equal(narrowed.selected.length, 0);
});

test('T14 child environment strips Forge credentials and session material, preserving only documented runtime controls', () => {
  const source = Object.fromEntries(
    [
      'FORGE_SECRETS_KEY',
      'FORGE_AUTH_TOKEN',
      'FORGE_AGENT_TOKEN',
      'FORGE_SESSION',
      'forge_new_credential',
      'NFORGE_TOKEN',
      'CODEX_THREAD_ID',
      'CLAUDE_CODE_SESSION_ID',
      'FORGE_GIT_TIMEOUT_MS',
      'FORGE_CHECK_FULL',
      'FORGE_CHECK_SCOPED',
      'FORGE_MAX_CONCURRENT_CHECKS',
      'FORGE_CHECK_QUEUE_DIR',
      'FORGE_DISK_WARN_GB',
      'FORGE_DISK_BLOCK_GB',
      'PATH',
      'OTHER',
    ].map(name => [name, 'synthetic']),
  );
  for (const only of [undefined, ['API_TOKEN']]) {
    const { env } = secretRunEnvironment({ source, only, names: [], secrets: [] });
    assert.deepEqual(
      Object.keys(env).sort(),
      [
        'FORGE_GIT_TIMEOUT_MS',
        'FORGE_CHECK_FULL',
        'FORGE_CHECK_SCOPED',
        'FORGE_MAX_CONCURRENT_CHECKS',
        'FORGE_CHECK_QUEUE_DIR',
        'FORGE_DISK_WARN_GB',
        'FORGE_DISK_BLOCK_GB',
        'PATH',
        'OTHER',
      ].sort(),
    );
  }
});

test('T84 default protection covers root example additions, removals and case variants; the owner can opt out', () => {
  for (const preset of ['supervised', 'trusted', 'autonomous']) {
    const policy = policyPreset(preset);
    assert.deepEqual(protectedMatches(policy, ['.env.example', '.ENV.EXAMPLE', 'sub/.env.example']), [
      '.env.example',
      '.ENV.EXAMPLE',
    ]);
    assert(reviewReason(policy, { kind: 'agent', id: 'writer' }, ['.env.example']));
  }
  const policy = policyPreset('trusted');
  const off = editedPolicy(policy, {
    action: 'set-policy',
    operationId: '00000000-0000-4000-8000-000000000001',
    acceptance: { protectedPaths: [] },
  });
  assert.equal(reviewReason(off, { kind: 'agent', id: 'writer' }, ['.env.example']), null);
  assert.deepEqual(effectivePolicy({ autonomyPolicy: off }).acceptance.protectedPaths, []);
  assert.deepEqual(effectivePolicy({}).acceptance.protectedPaths, ['.env.example']);
});

test('run arguments require a command separator and never consume child flags as Forge flags', () => {
  assert.deepEqual(secretRunOptions(['--only', 'A,B', '--', 'tool', '--show']).command, ['tool', '--show']);
  for (const args of [
    [],
    ['--'],
    ['--set', 'unknown', '--', 'tool'],
    ['--only', 'bad', '--', 'tool'],
    ['--show', '--show', '--', 'tool'],
  ])
    assert.throws(() => secretRunOptions(args), { code: 'BAD_ARGUMENT' });
});
