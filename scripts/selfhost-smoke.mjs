// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { ConvexHttpClient } from 'convex/browser';
import { api, internal } from '../convex/_generated/api.js';
import { decodeHostedArtifact } from '../dist/hosted-artifact.js';
import { releases, release, digest, main, portNumber } from './selfhost.mjs';
import { githubOidcIssuer, verifyGithubOidc } from './selfhost-oidc.mjs';

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
let stage = 'configuration',
  succeeded = false;
function cli(directory, args) {
  return execFileSync(
    process.execPath,
    [resolve('node_modules/convex/bin/main.js'), ...args, '--env-file', join(directory, 'deployment.env')],
    { cwd: resolve('.'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 },
  );
}
async function start(directory, s3Env) {
  const log = await open(join(root, `backend-${processes.size}-${randomUUID()}.log`), 'wx', 0o600);
  logs.push(log);
  const child = spawn(
    process.execPath,
    [resolve('scripts/selfhost.mjs'), 'start', directory, ...(s3Env ? [s3Env] : [])],
    { stdio: ['ignore', log.fd, log.fd] },
  );
  processes.set(directory, child);
  const env = parseEnv(await readFile(join(directory, 'deployment.env'), 'utf8'));
  const url = env.CONVEX_SELF_HOSTED_URL;
  assert.equal(new URL(url).hostname, '127.0.0.1');
  for (let attempt = 0; ; attempt++) {
    assert.equal(child.exitCode, null, 'Owned native backend exited before readiness.');
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
}
async function stop(directory) {
  const child = processes.get(directory);
  if (!child) return;
  if (child.exitCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
  }
  processes.delete(directory);
}
async function deploy(directory) {
  cli(directory, ['env', 'set', 'CLERK_JWT_ISSUER_DOMAIN', realOidc ? githubOidcIssuer : '']);
  cli(directory, ['env', 'set', 'GITHUB_PUBLIC_TOKEN', token]);
  cli(directory, ['env', 'set', 'FORGE_SECRET_KEYS', keys]);
  cli(directory, ['deploy', '--typecheck', 'enable', '--yes']);
}
function archiveFor(pin, platform, provided) {
  const asset = releases[pin]?.[platform];
  assert(asset, 'Choose a supported reviewed pin.');
  if (provided) return provided;
  const path = join(root, pin + '-' + asset.name);
  execFileSync(
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
    parts.push(Buffer.from(part.data));
    offset += parts.at(-1).length;
    assert(offset <= part.size);
    if (offset === part.size) break;
    assert(parts.at(-1).length > 0);
  }
  const bytes = Buffer.concat(parts),
    artifact = await decodeHostedArtifact(new Blob([bytes], { type: 'application/gzip' }));
  const path = join(root, randomUUID() + '.gz');
  await writeFile(path, bytes, { mode: 0o600 });
  const hex = Buffer.from(sha, 'base64').toString('hex');
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
  const platform = `${process.platform}-${process.arch}`;
  const archive = archiveFor(release, platform, process.env.FORGE_NATIVE_ARCHIVE);
  const targetArchive =
    targetRelease === release
      ? archive
      : archiveFor(targetRelease, platform, process.env.FORGE_NATIVE_TARGET_ARCHIVE);
  const primaryPath = join(root, 'primary'),
    restoredPath = join(root, 'restored');
  stage = 'fresh primary install';
  await main(['init', primaryPath, archive, String(port)]);
  let primary = await start(primaryPath);
  await deploy(primaryPath);
  stage = 'public acquisition';
  const id = await primary.anon.action(api.hosted.start, { url: `https://github.com/${repository}`, ref });
  let job;
  for (let attempt = 0; ; attempt++) {
    job = await primary.admin.query(internal.imports.get, { id });
    assert(job);
    assert.notEqual(job.phase, 'error', 'Owned native source acquisition failed.');
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
  stage = 'fresh restored install';
  await main(['init', restoredPath, targetArchive, String(port + 10), targetRelease]);
  let restored = await start(restoredPath, storageEnv);
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
  console.error(
    `Native self-host smoke failed during ${stage}. Private diagnostic data retained at ${root}; no credentials printed.`,
  );
  process.exitCode = 1;
} finally {
  for (const directory of processes.keys()) await stop(directory);
  for (const log of logs) await log.close();
  if (succeeded) await rm(root, { recursive: true, force: true }); // Only this invocation's freshly owned temporary instances.
}
