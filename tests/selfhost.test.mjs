// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  main,
  digest,
  readSetup,
  portNumber,
  release,
  upgradeRelease,
  retainBackendNotice,
  backendLicenseSha256,
} from '../scripts/selfhost.mjs';

test('self-host launch preserves existing data and refuses corrupt or exposed instance credentials before execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-selfhost-'));
  try {
    assert.equal(portNumber('65534'), 65534);
    for (const value of ['3220x', '1', '65535', 'NaN']) assert.throws(() => portNumber(value));
    const archive = join(root, 'bad.zip'),
      directory = join(root, 'instance');
    await writeFile(archive, 'wrong archive');
    await mkdir(directory);
    await writeFile(join(directory, 'database.sqlite3'), 'existing data');
    await assert.rejects(main(['init', directory, archive]), /verified/);
    await assert.rejects(main(['init', directory, archive, '3220', upgradeRelease]), /verified/);
    await assert.rejects(main(['init', directory, archive, '3220', 'unreviewed-release']));
    assert.equal(await readFile(join(directory, 'database.sqlite3'), 'utf8'), 'existing data');
    const binary = join(directory, 'convex-local-backend'),
      configPath = join(directory, 'instance.json');
    await writeFile(binary, 'do not execute', { mode: 0o700 });
    const config = {
      release,
      platform: `${process.platform}-${process.arch}`,
      instance: `forge_${'a'.repeat(16)}`,
      secret: 'b'.repeat(64),
      port: 3220,
      binarySha256: await digest(binary),
    };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    assert.equal((await readSetup(directory)).instance, config.instance);
    await writeFile(configPath, JSON.stringify({ ...config, release: upgradeRelease }));
    assert.equal((await readSetup(directory)).release, upgradeRelease);
    await writeFile(configPath, JSON.stringify({ ...config, release: 'unreviewed-release' }));
    await assert.rejects(readSetup(directory), /incompatible/);
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(binary, 'changed binary');
    await assert.rejects(readSetup(directory), /bytes changed/);
    await chmod(configPath, 0o644);
    await assert.rejects(readSetup(directory), /owner-only/);
    await rm(configPath);
    await symlink(archive, configPath);
    await assert.rejects(readSetup(directory), /regular/);
    let failure;
    try {
      execFileSync(process.execPath, ['scripts/selfhost.mjs', 'start', directory], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure.status, 1);
    assert.ok(!failure.stderr.includes(config.secret));
    assert.equal(await readFile(join(directory, 'database.sqlite3'), 'utf8'), 'existing data');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('optional private S3 launch uses native storage and preserves the local default and original instance', async t => {
  const previousSecret = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'fake-test-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousSecret;
  });
  const directory = await mkdtemp(join(tmpdir(), 'forge-selfhost-s3-'));
  try {
    // The extensionless mock must not inherit the check owner's ESM package scope.
    await writeFile(join(directory, 'package.json'), '{"type":"commonjs"}');
    const binary = join(directory, 'convex-local-backend'),
      capture = join(directory, 'capture.json'),
      storageEnv = join(directory, 's3.env');
    await writeFile(
      binary,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync('capture.json', JSON.stringify({args:process.argv.slice(2),region:process.env.AWS_REGION,key:process.env.AWS_SECRET_ACCESS_KEY,sentry:process.env.SENTRY_DSN,leaked:process.env.OPENAI_API_KEY!==undefined}),{mode:0o600});\n`,
      { mode: 0o700 },
    );
    const config = {
      release,
      platform: `${process.platform}-${process.arch}`,
      instance: `forge_${'a'.repeat(16)}`,
      secret: 'b'.repeat(64),
      port: 3220,
      binarySha256: await digest(binary),
    };
    const configPath = join(directory, 'instance.json'),
      database = join(directory, 'database.sqlite3');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(database, 'original database', { mode: 0o600 });
    await main(['start', directory]);
    const local = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(local.leaked, false);
    assert(local.args.includes('--local-storage'));
    assert(!local.args.includes('--s3-storage'));
    await writeFile(
      storageEnv,
      'AWS_REGION=qa-region\nAWS_SECRET_ACCESS_KEY="synthetic quoted key"\nSENTRY_DSN=ignored\n',
      { mode: 0o600 },
    );
    const envDigest = await digest(storageEnv),
      configDigest = await digest(configPath),
      dbDigest = await digest(database);
    await main(['start', directory, storageEnv]);
    const s3 = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(s3.leaked, false);
    assert(s3.args.includes('--s3-storage'));
    assert(!s3.args.includes('--local-storage'));
    assert.equal(s3.region, 'qa-region');
    assert.equal(s3.key, 'synthetic quoted key');
    assert.equal(s3.sentry, '');
    assert.equal(s3.args.at(-1), database);
    assert.equal(s3.args[s3.args.indexOf('--instance-name') + 1], config.instance);
    await main(['start', directory, storageEnv]);
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), s3);
    await chmod(storageEnv, 0o644);
    await assert.rejects(main(['start', directory, storageEnv]), /owner-only/);
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), s3);
    await chmod(storageEnv, 0o600);
    await rm(storageEnv);
    await symlink(configPath, storageEnv);
    await assert.rejects(main(['start', directory, storageEnv]), /regular/);
    await rm(storageEnv);
    await writeFile(
      storageEnv,
      'AWS_REGION=qa-region\nAWS_SECRET_ACCESS_KEY="synthetic quoted key"\nSENTRY_DSN=ignored\n',
      { mode: 0o600 },
    );
    assert.equal(await digest(storageEnv), envDigest);
    assert.equal(await digest(configPath), configDigest);
    assert.equal(await digest(database), dbDigest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native backend original root-license notice retains exact release bytes without gating existing installation or replacing retained notices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-selfhost-notice-'));
  try {
    const original = await readFile(
      new URL('../docs/vendor-notices/convex-backend-LICENSE.md', import.meta.url),
    );
    assert.equal(original.length, 3861);
    assert.equal(
      await digest(new URL('../docs/vendor-notices/convex-backend-LICENSE.md', import.meta.url)),
      backendLicenseSha256,
    );
    assert.equal(await retainBackendNotice(directory), true);
    const saved = join(directory, 'LICENSE-convex-backend.md');
    assert.deepEqual(await readFile(saved), original);
    assert.equal(await retainBackendNotice(directory), false, 'Existing notice bytes are preserved');
    assert.deepEqual(await readFile(saved), original);
    assert.equal(
      await retainBackendNotice(directory, join(directory, 'missing')),
      false,
      'Missing notice is reported without introducing an install/start gate',
    );
    const wrong = join(directory, 'wrong');
    await writeFile(wrong, 'different terms');
    assert.equal(await retainBackendNotice(directory, wrong), false);
    assert.deepEqual(await readFile(saved), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
