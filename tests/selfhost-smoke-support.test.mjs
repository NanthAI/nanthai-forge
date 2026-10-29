// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  assertSmokeImport,
  deploySmoke,
  sanitizeSmokeText,
  smokeCommand,
  smokeFailure,
} from '../scripts/selfhost-smoke-support.mjs';

const authCode = ts.transpileModule(readFileSync('convex/auth.config.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
function auth(variables) {
  const exports = {};
  runInNewContext(authCode, {
    exports,
    URL,
    process: {
      env: new Proxy(variables, {
        get(target, name) {
          if (!(name in target))
            throw Error(
              `Environment variable ${name} is used in auth config file but its value was not set.`,
            );
          return target[name];
        },
      }),
    },
  });
  return JSON.parse(JSON.stringify(exports.default));
}

test('fresh native auth reproduces the unset optional issuer failure; smoke defines it before deploy', () => {
  assert.throws(
    () => auth({ CLERK_JWT_ISSUER_DOMAIN: 'https://token.actions.githubusercontent.com' }),
    /FORGE_CLI_ISSUER.*not set/,
  );
  for (const issuer of ['', 'https://token.actions.githubusercontent.com']) {
    const variables = {},
      commands = [];
    deploySmoke(
      args => {
        commands.push(args);
        if (args[0] === 'env') variables[args[2]] = args[3];
        else
          assert.deepEqual(
            auth(variables).providers,
            issuer ? [{ domain: issuer, applicationID: 'convex' }] : [],
          );
      },
      { issuer, token: 'synthetic-token', keys: 'synthetic-keyring' },
    );
    assert.equal(variables.FORGE_CLI_ISSUER, '');
    assert.equal(variables.FORGE_BLOBS, 'convex');
    assert.equal(variables.GITHUB_PUBLIC_TOKEN, 'synthetic-token');
    assert.equal(variables.FORGE_SECRET_KEYS, 'synthetic-keyring');
    assert.deepEqual(commands.at(-1), ['deploy', '--typecheck', 'enable', '--yes']);
  }
});

test('import failures expose the job reason through redacted smoke diagnostics', () => {
  for (const phase of ['queued', 'fetching', 'indexing', 'ready']) assertSmokeImport({ phase });
  let failure;
  try {
    assertSmokeImport(
      { phase: 'error', error: 'R2_NOT_CONFIGURED: missing R2_BUCKET; opaque-private-value' },
      ['opaque-private-value'],
    );
  } catch (error) {
    failure = error;
  }
  const output = smokeFailure(failure, { stage: 'public acquisition' });
  assert.match(output, /ERR_ASSERTION/);
  assert.match(output, /Owned native source acquisition failed: R2_NOT_CONFIGURED: missing R2_BUCKET/);
  assert.doesNotMatch(output + failure.stack, /opaque-private-value/);
  assert.throws(() => assertSmokeImport({ phase: 'error' }), /No import error was recorded/);
  assert.throws(() => assertSmokeImport(null), /import is unavailable/);
});

test('diagnostics redact known opaque secrets, dotenv, JWTs, keyrings, authorization, URLs and terminal controls', () => {
  const secret = 'opaque synthetic credential';
  const input = [
    '\x1b[31mUseful error: missing FORGE_CLI_ISSUER\x1b[0m',
    `raw ${secret}`,
    'CONVEX_SELF_HOSTED_ADMIN_KEY=unrecognized-value',
    'export UNFAMILIAR_VALUE=private-content',
    'Authorization: Bearer unknown-bearer',
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJxYSJ9.signature',
    'token="unknown quoted credential" admin_key=unknown-admin',
    'https://user:private-password@example.test/path?credential=private-query',
    'ghp_unknowncredential ' + 'a'.repeat(64),
    '-----BEGIN PRIVATE KEY-----\nprivate pem data\n-----END PRIVATE KEY-----',
  ].join('\n');
  const output = sanitizeSmokeText(input, [secret]);
  assert.match(output, /Useful error: missing FORGE_CLI_ISSUER/);
  assert.doesNotMatch(
    output,
    /opaque|unrecognized-value|private-content|unknown-bearer|eyJ|unknown quoted|unknown-admin|private-password|private-query|unknowncredential|a{64}|private pem|\x1b/,
  );
});

test('real failed child publishes label, status and stderr tail but never argv, stdout or error.message', () => {
  let failure;
  try {
    smokeCommand(
      process.execPath,
      [
        '-e',
        "console.log('private stdout'); console.error('missing FORGE_CLI_ISSUER'); console.error(process.argv[1]); process.exit(7)",
        'private-argument',
      ],
      { encoding: 'utf8', stdio: 'pipe' },
      'convex env set EXAMPLE <redacted>',
    );
  } catch (error) {
    failure = error;
  }
  const output = smokeFailure(failure, {
    stage: 'fresh primary configuration and deploy',
    secrets: ['private-argument'],
  });
  assert.match(output, /fresh primary configuration and deploy/);
  assert.match(output, /convex env set EXAMPLE <redacted>; exit code: 7/);
  assert.match(output, /missing FORGE_CLI_ISSUER/);
  assert.doesNotMatch(output, /private-argument|private stdout|console\.log|Command failed/);
});

test('redaction happens before bounded tails and truncation', () => {
  const secret = 'q'.repeat(1200);
  const output = smokeFailure(
    { status: 1, smokeCommand: 'fixture', stderr: 'old\n'.repeat(20) + 'prefix ' + secret + '\nlast reason' },
    { stage: 'fixture', secrets: [secret] },
  );
  assert.match(output, /prefix \[redacted\]\n  last reason/);
  assert.equal(output.split('\n').length, 15);
  assert.doesNotMatch(output, /q{5}/);
});

test('signals, spawn failures and ordinary assertions retain actionable metadata without raw child messages', () => {
  const killed = smokeFailure(
    { status: null, signal: 'SIGTERM', smokeCommand: 'fixture', message: 'raw private argv' },
    { stage: 'backend startup' },
  );
  assert.match(killed, /signal: SIGTERM/);
  assert.doesNotMatch(killed, /raw private argv/);
  const missing = smokeFailure(
    { code: 'ENOENT', spawnargs: ['private argv'], message: 'private argv' },
    { stage: 'backend startup', command: 'native backend' },
  );
  assert.match(missing, /native backend; exit code: unavailable; code: ENOENT/);
  assert.doesNotMatch(missing, /private argv/);
  assert.match(smokeFailure(Error('digest mismatch'), { stage: 'initialization' }), /digest mismatch/);
});
