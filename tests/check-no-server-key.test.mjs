// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The no-server-key guard (scripts/check-no-server-key.mjs; Item 41a0df87, slice 6): a copy of the database, a backup
// or an object-storage copy holds no value a team stored and no key that opens one. Each rule fails on the change that
// would break it, with synthetic file text only; the real tree is checked by `npm run check`.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { SERVICE_SETTINGS, serverKeyFindings } from '../scripts/check-no-server-key.mjs';

const rules = (path, text) =>
  serverKeyFindings(path, text).map(finding => finding.replace(/^[^:]+:\d+: /, ''));

test('the retired server keyring is read or set nowhere in code', () => {
  for (const path of [
    'convex/anything.ts',
    'src/anything.ts',
    'scripts/anything.mjs',
    'web/src/anything.tsx',
  ])
    assert.match(
      rules(path, 'const keys = process.env.FORGE_SECRET_KEYS;\n').join('\n'),
      /retired Secret Object keyring/,
      path,
    );
  // Tests and docs may name it (this guard is tested here, and the runbook says to delete it).
  assert.deepEqual(serverKeyFindings('tests/x.test.mjs', "'FORGE_SECRET_KEYS'"), []);
  assert.deepEqual(serverKeyFindings('docs/operations.md', 'delete FORGE_SECRET_KEYS'), []);
  const finding = serverKeyFindings('convex/x.ts', '\n\nprocess.env.FORGE_SECRET_KEYS')[0];
  assert.match(finding, /^convex\/x\.ts:3: /);
});

test('a new key-like server setting must be named as a service credential', () => {
  assert.deepEqual(rules('convex/x.ts', 'const k = process.env.FORGE_GITHUB_TOKEN_KEYRING;'), []);
  assert.match(
    rules('convex/x.ts', 'const k = process.env.TEAM_VALUE_SEALING_KEY;').join(),
    /new key-like server setting/,
  );
  assert.match(
    rules('convex/x.ts', 'const k = process.env.SOME_PASSWORD;').join(),
    /new key-like server setting/,
  );
  // A plain setting is not key-like, and a computed read is allowed only where listed.
  assert.deepEqual(rules('convex/x.ts', 'const u = process.env.FORGE_WEB_URL;'), []);
  assert.match(rules('convex/x.ts', 'const v = process.env[`A_${id}`];').join(), /computed server setting/);
  assert.deepEqual(rules('convex/projectHostedOutputApi.ts', 'const v = process.env[`A_${id}`];'), []);
  // Other folders read their own settings.
  assert.deepEqual(rules('src/x.ts', 'const k = process.env.TEAM_VALUE_SEALING_KEY;'), []);
  assert.ok(SERVICE_SETTINGS.has('FORGE_GITHUB_TOKEN_KEYRING'));
});

test('the sealed-set server modules read no setting and hold no cipher', () => {
  assert.match(
    rules('convex/sealedSecrets.ts', 'const a = process.env.FORGE_WEB_URL;').join(),
    /reads a server setting/,
  );
  assert.match(
    rules('convex/sealedSecretGate.ts', "import { createDecipheriv } from 'node:crypto';").join(),
    /holds a cipher/,
  );
  assert.deepEqual(rules('convex/sealedSecretGate.ts', 'const ok = verify(head);'), []);
});

test('only the GitHub token store seals under a server keyring', () => {
  assert.deepEqual(
    rules('convex/githubUserTokenActions.ts', "import { sealSecret } from '../src/secret-crypto';"),
    [],
  );
  assert.match(
    rules('convex/teamValues.ts', "import { sealSecret } from '../src/secret-crypto';").join(),
    /only the GitHub token store may/,
  );
});

test('no backup, export, archive or exchange module reads a sealed table', () => {
  for (const path of [
    'convex/projectBackups.ts',
    'convex/accountExport.ts',
    'convex/projectExchangeReader.ts',
  ])
    assert.match(rules(path, "ctx.db.query('sealedSecretSets')").join(), /would copy sealed records/, path);
  assert.deepEqual(rules('convex/sealedSecrets.ts', "ctx.db.query('sealedSecretSets')"), []);
});

test('the sealed tables store sealed, signed or public bytes, and no field shaped like a value or a key', async () => {
  const fields = await import(moduleUrl('../convex/sealedSecretFields.ts'));
  const names = new Set();
  const walk = validator => {
    if (validator.kind === 'object')
      for (const [name, field] of Object.entries(validator.fields)) {
        names.add(name);
        walk(field);
      }
    else if (validator.kind === 'array') walk(validator.element);
    else if (validator.kind === 'union') validator.members.forEach(walk);
  };
  const tables = fields.sealedSecretTables;
  assert.ok(Object.keys(tables).length >= 4, 'the sealed tables are the ones checked');
  for (const table of Object.values(tables)) walk(table.validator);
  assert.ok(names.has('payload') && names.has('verifier'), 'the walk reached the stored fields');
  for (const name of names)
    assert.doesNotMatch(
      name,
      /^(?:value|values|plaintext|secret|secrets|password|privateKey|secretKey|setKey|deviceKey|signKey|encKey|seed|key)$/i,
      `sealed field ${name} is shaped like a value or a key`,
    );
});
