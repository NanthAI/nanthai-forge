// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ConvexHttpClient } from 'convex/browser';
import { api, internal } from '../convex/_generated/api.js';
import { decodeHostedArtifact } from '../dist/hosted-artifact.js';
import { releases, release, digest, main, portNumber } from './selfhost.mjs';
import { githubOidcIssuer, verifyGithubOidc } from './selfhost-oidc.mjs';
import { assertSmokeImport, deploySmoke, smokeCommand, smokeFailure } from './selfhost-smoke-support.mjs';
import { startFakeR2, fakeR2Config } from '../tests/fake-r2.mjs';

// ponytail: real native smoke runs one pinned public checkout; add more platforms only after this owner is measured.
const root = await mkdtemp(join(tmpdir(), 'forge-native-smoke-')),
  processes = new Map(),
  logs = [];
const token = process.env.GITHUB_TOKEN,
  repository = process.env.FORGE_SMOKE_REPOSITORY ?? 'sindresorhus/is-plain-obj';
const ref = process.env.FORGE_SMOKE_REF ?? '666df7c10035f7e26f27ec214fe5ae3173435f34';
const port = portNumber(process.env.FORGE_NATIVE_PORT ?? '3320'),
  owner = 'forge_native_smoke';
const targetRelease = process.env.FORGE_NATIVE_TARGET_RELEASE ?? release;
const storageEnv = process.env.FORGE_NATIVE_S3_ENV && resolve(process.env.FORGE_NATIVE_S3_ENV);
const realOidc = process.env.FORGE_NATIVE_GITHUB_OIDC === '1';
let oidc;
const issuer = 'https://native-smoke.invalid',
  paginationOpts = { cursor: null, numItems: 20 };
const keys = JSON.stringify({
  active: 'native-smoke',
  keys: { 'native-smoke': randomBytes(32).toString('base64') },
});
const secrets = [
  keys,
  ...Object.values(JSON.parse(keys).keys),
  ...Object.entries(process.env)
    .filter(([name]) => /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH/i.test(name))
    .map(([, value]) => value),
];
let stage = 'configuration',
  succeeded = false;
function cli(directory, args) {
  return smokeCommand(
    process.execPath,
    [resolve('node_modules/convex/bin/main.js'), ...args, '--env-file', join(directory, 'deployment.env')],
    { cwd: resolve('.'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 },
    `convex ${args[0]}${args[0] === 'env' ? ` ${args[1]} ${args[2]} <redacted>` : ''} --env-file <private path>`,
  );
}
async function start(directory, s3Env) {
  const backendLog = join(root, `backend-${processes.size}-${randomUUID()}.log`);
  const log = await open(backendLog, 'wx', 0o600);
  logs.push(log);
  const child = spawn(
    process.execPath,
    [resolve('scripts/selfhost.mjs'), 'start', directory, ...(s3Env ? [s3Env] : [])],
    { stdio: ['ignore', log.fd, log.fd] },
  );
  processes.set(directory, child);
  let spawnError;
  child.on('error', error => {
    spawnError = error;
  });
  try {
    const env = parseEnv(await readFile(join(directory, 'deployment.env'), 'utf8'));
    secrets.push(
      env.CONVEX_SELF_HOSTED_ADMIN_KEY,
      JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')).secret,
    );
    const url = env.CONVEX_SELF_HOSTED_URL;
    assert.equal(new URL(url).hostname, '127.0.0.1');
    for (let attempt = 0; ; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode) {
        const error = new Error('Owned native backend exited before readiness.');
        error.exitCode = child.exitCode;
        error.signal = child.signalCode;
        throw error;
      }
      try {
        if ((await fetch(url + '/version', { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch {
        /* Wait only for this new owned listener. */
      }
      assert(attempt < 100, 'Owned native backend did not become ready.');
      await new Promise(done => setTimeout(done, 100));
    }
    const anon = new ConvexHttpClient(url, { logger: false }),
      admin = new ConvexHttpClient(url, { logger: false }),
      outsider = new ConvexHttpClient(url, { logger: false });
    const identity = subject => ({ subject, issuer, tokenIdentifier: issuer + '|' + subject });
    admin.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY, identity(owner));
    outsider.setAdminAuth(env.CONVEX_SELF_HOSTED_ADMIN_KEY, identity('forge_native_outsider'));
    return { anon, admin, outsider, directory };
  } catch (error) {
    error.smokeCommand = 'node scripts/selfhost.mjs start <private instance>';
    error.stderr = await readFile(backendLog, 'utf8');
    throw error;
  }
}
async function stop(directory) {
  const child = processes.get(directory);
  if (!child) return;
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
  }
  processes.delete(directory);
}
// Self-host needs object storage like every deployment: a local S3-compatible bucket.
const bucket = await startFakeR2(fakeR2Config, { local: true });
const r2 = {
  R2_ACCOUNT_ID: fakeR2Config.accountId,
  R2_BUCKET: fakeR2Config.bucket,
  R2_ACCESS_KEY_ID: fakeR2Config.accessKeyId,
  R2_SECRET_ACCESS_KEY: fakeR2Config.secretAccessKey,
  R2_ENDPOINT: bucket.endpoint,
};
async function deploy(directory) {
  deploySmoke(args => cli(directory, args), { issuer: realOidc ? githubOidcIssuer : '', token, keys, r2 });
}
function archiveFor(pin, platform, provided) {
  const asset = releases[pin]?.[platform];
  assert(asset, 'Choose a supported reviewed pin.');
  if (provided) return provided;
  const path = join(root, pin + '-' + asset.name);
  smokeCommand(
    'curl',
    [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--output',
      path,
      `https://github.com/get-convex/convex-backend/releases/download/${pin}/${asset.name}`,
    ],
    { stdio: 'pipe', timeout: 180_000 },
    `curl pinned backend archive ${pin}/${asset.name}`,
  );
  return path;
}
async function snapshot(client, id) {
  const parts = [];
  let offset = 0,
    sha;
  while (true) {
    const part = await client.action(api.lifecycleActions.downloadPart, {
      id,
      offset,
      ...(sha ? { digest: sha } : {}),
    });
    sha ??= part.digest;
    assert.equal(part.digest, sha);
    parts.push(Buffer.from(part.direct ? await (await fetch(part.url)).arrayBuffer() : part.data));
    offset += parts.at(-1).length;
    assert(offset <= part.size);
    if (offset === part.size) break;
    assert(parts.at(-1).length > 0);
  }
  const bytes = Buffer.concat(parts),
    artifact = await decodeHostedArtifact(new Blob([bytes], { type: 'application/gzip' }));
  const path = join(root, randomUUID() + '.gz');
  await writeFile(path, bytes, { mode: 0o600 });
  const hex = /^[a-f0-9]{64}$/.test(sha) ? sha : Buffer.from(sha, 'base64').toString('hex');
  assert.equal(await digest(path), hex);
  return {
    sha: hex,
    sourceId: artifact.pack.source.id,
    analysisId: artifact.pack.id,
    content: artifact.content,
    gitHead: artifact.pack.source.gitHead,
  };
}
try {
  assert(
    token && ref && /^[a-f0-9]{40,64}$/.test(ref) && /^[\w.-]+\/[\w.-]+$/.test(repository),
    'Provide the ephemeral GitHub read token, public repository and exact commit.',
  );
  assert(port + 20 <= 65534);
  if (storageEnv) secrets.push(...Object.values(parseEnv(await readFile(storageEnv, 'utf8'))));
  const platform = `${process.platform}-${process.arch}`;
  const archive = archiveFor(release, platform, process.env.FORGE_NATIVE_ARCHIVE);
  const targetArchive =
    targetRelease === release
      ? archive
      : archiveFor(targetRelease, platform, process.env.FORGE_NATIVE_TARGET_ARCHIVE);
  const primaryPath = join(root, 'primary'),
    restoredPath = join(root, 'restored');
  stage = 'fresh primary initialization';
  await main(['init', primaryPath, archive, String(port)]);
  stage = 'fresh primary backend startup';
  let primary = await start(primaryPath);
  stage = 'fresh primary configuration and deploy';
  await deploy(primaryPath);
  stage = 'public acquisition';
  const id = await primary.anon.action(api.hosted.start, { url: `https://github.com/${repository}`, ref });
  let job;
  for (let attempt = 0; ; attempt++) {
    job = await primary.admin.query(internal.imports.get, { id });
    assertSmokeImport(job, secrets);
    if (job.phase === 'ready') break;
    assert(attempt < 300, 'Owned native import did not finish.');
    await new Promise(done => setTimeout(done, 1000));
  }
  assert.equal(job.head, ref);
  const before = await snapshot(primary.anon, id);
  assert.equal(before.gitHead, ref);
  const file = Object.keys(before.content).sort()[0];
  assert(file);
  const source = JSON.parse(
    await primary.anon.action(api.hosted.read, { id, endpoint: 'source?file=' + encodeURIComponent(file) }),
  );
  assert.equal(source.results[0].text, before.content[file].split('\n').slice(0, 80).join('\n'));
  stage = 'synthetic owner metadata';
  const team = await primary.admin.mutation(api.teams.create, {
    name: 'Native restore QA',
    operationId: randomUUID(),
  });
  const secretValue = 'native-synthetic-' + randomUUID(),
    operationId = randomUUID();
  secrets.push(secretValue);
  const secret = await primary.admin.action(api.secretActions.create, {
    name: 'Native encrypted restore QA',
    repository,
    ref,
    value: secretValue,
    operationId,
  });
  const originalSecret = await primary.admin.query(internal.secrets.created, { owner, operationId });
  assert(originalSecret);
  assert(!JSON.stringify(originalSecret).includes(secretValue));
  if (realOidc) {
    stage = 'real GitHub OIDC owner and negative verification';
    oidc = await verifyGithubOidc(primary, repository, ref);
  }
  stage = 'snapshot export';
  const backup = join(root, 'backup.zip');
  cli(primaryPath, ['export', '--include-file-storage', '--path', backup]);
  stage = 'fresh restored initialization';
  await main(['init', restoredPath, targetArchive, String(port + 10), targetRelease]);
  stage = 'fresh restored backend startup';
  let restored = await start(restoredPath, storageEnv);
  stage = 'snapshot import and restored deploy';
  cli(restoredPath, ['import', backup, '--yes']);
  await deploy(restoredPath); // Restore original table IDs before a newer schema allocates new tables.
  const verify = async clients => {
    const after = await clients.admin.query(internal.imports.get, { id });
    for (const field of [
      '_id',
      '_creationTime',
      'artifactKey',
      'head',
      'generation',
      'repository',
      'ref',
      'visibility',
      'scope',
      'owner',
      'phase',
      'analysisVersion',
    ])
      assert.deepEqual(after[field], job[field], field);
    assert.deepEqual(await snapshot(clients.anon, id), before);
    assert.deepEqual(
      JSON.parse(
        await clients.anon.action(api.hosted.read, {
          id,
          endpoint: 'source?file=' + encodeURIComponent(file),
        }),
      ),
      source,
    );
    assert.equal((await clients.admin.query(api.teams.list, { paginationOpts })).page[0].id, team);
    for (const caller of [clients.anon, clients.outsider]) {
      assert.deepEqual((await caller.query(api.teams.list, { paginationOpts })).page, []);
      await assert.rejects(caller.query(api.teams.members, { id: team, paginationOpts }));
      await assert.rejects(caller.query(api.secrets.details, { id: secret }));
    }
    assert.deepEqual(
      await clients.admin.query(internal.secrets.created, { owner, operationId }),
      originalSecret,
    );
    assert.equal(
      (await clients.admin.action(api.secretActions.reveal, { id: secret, operationId: randomUUID() })).value,
      secretValue,
    );
    if (realOidc) oidc = await verifyGithubOidc(clients, repository, ref, oidc);
  };
  stage = 'restored original data';
  await verify(restored);
  stage = 'application redeploy and process restart';
  await deploy(primaryPath);
  await stop(primaryPath);
  primary = await start(primaryPath);
  await verify(primary);
  let upgradedBackupSha256;
  if (targetRelease !== release || storageEnv) {
    stage = 'target backend redeploy and restart';
    await deploy(restoredPath);
    await stop(restoredPath);
    restored = await start(restoredPath, storageEnv);
    await verify(restored);
    stage = 'target snapshot and fresh original-pin rollback';
    const upgradedBackup = join(root, 'upgraded-backup.zip');
    cli(restoredPath, ['export', '--include-file-storage', '--path', upgradedBackup]);
    upgradedBackupSha256 = await digest(upgradedBackup);
    const rollbackPath = join(root, 'rollback');
    await main(['init', rollbackPath, archive, String(port + 20)]);
    const rollback = await start(rollbackPath);
    cli(rollbackPath, ['import', upgradedBackup, '--yes']);
    await deploy(rollbackPath);
    await verify(rollback);
  }
  console.log(
    JSON.stringify({
      result: 'passed',
      platform,
      release,
      targetRelease,
      archiveSha256: await digest(archive),
      targetArchiveSha256: await digest(targetArchive),
      backupSha256: await digest(backup),
      upgradedBackupSha256,
      sourceId: before.sourceId,
      analysisId: before.analysisId,
      artifactSha256: before.sha,
      gitHead: ref,
      files: Object.keys(before.content).length,
      originalIdsAndFiles: true,
      originalEncryptedVersion: true,
      syntheticOwnerIsolation: true,
      applicationRedeployAndRestart: true,
      freshPinUpgradeAndRollback: targetRelease !== release,
      localToS3AndLocalRestore: Boolean(storageEnv),
      realOidc: realOidc
        ? {
            issuer: githubOidcIssuer,
            audience: 'convex',
            signedOwnerAuthenticated: true,
            refreshedOwnerPreserved: true,
            wrongAudienceDenied: true,
            forgedSubjectDenied: true,
            anonymousAndSimulatedOwnersDenied: true,
          }
        : null,
    }),
  );
  succeeded = true;
} catch (error) {
  await writeFile(join(root, 'failure.log'), String(error?.stack ?? error), { mode: 0o600 });
  console.error(smokeFailure(error, { stage, secrets }));
  console.error(
    `Private diagnostic data retained at ${root}; credentials and deployment.env contents withheld.`,
  );
  process.exitCode = 1;
} finally {
  for (const directory of processes.keys()) await stop(directory);
  for (const log of logs) await log.close();
  await bucket.close();
  if (succeeded) await rm(root, { recursive: true, force: true }); // Only this invocation's freshly owned temporary instances.
}
