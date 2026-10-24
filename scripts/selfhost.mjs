// SPDX-License-Identifier: Apache-2.0
import { childEnv } from './child-env.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { retainBackendNotice, retainNativeComponentNotices } from './selfhost-notices.mjs';
export { backendLicenseSha256, retainBackendNotice } from './selfhost-notices.mjs';

export const release = 'precompiled-2026-09-28-5c7cb5b';
export const upgradeRelease = 'precompiled-2026-10-01-d2ca853';
export const releases = {
  [release]: {
    'darwin-arm64': {
      name: 'convex-local-backend-aarch64-apple-darwin.zip',
      sha256: 'c1613bb4a3ac884871184020662c865a045cde95ad781fff002a6bd25f2f2890',
    },
    'linux-x64': {
      name: 'convex-local-backend-x86_64-unknown-linux-gnu.zip',
      sha256: '5b4adbe9fc2f9985c66eb12b19dadedf2700d8796c839ddba09802196099f241',
    },
  },
  [upgradeRelease]: {
    'darwin-arm64': {
      name: 'convex-local-backend-aarch64-apple-darwin.zip',
      sha256: '39cf428d9e6adb51eba1d572ffffbc04b14786b2d72fca47636b701f65f18612',
    },
    'linux-x64': {
      name: 'convex-local-backend-x86_64-unknown-linux-gnu.zip',
      sha256: 'd0ff390d18fcfc64d9f59fa764363e412b216ac2ce2f3c2008aa96fe7a37e509',
    },
  },
};
export const archives = releases[release];
export async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
export function portNumber(value = '3220') {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1024 || Number(value) > 65534)
    throw new Error('Choose a port from 1024 to 65534; the following port serves HTTP actions.');
  return Number(value);
}
async function privateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.mode & 0o077)
    throw new Error('Instance files must be regular owner-only files.');
}
export async function readSetup(directory) {
  const path = join(directory, 'instance.json');
  await privateFile(path);
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (
    config.platform !== `${process.platform}-${process.arch}` ||
    !releases[config.release]?.[config.platform] ||
    !/^forge_[a-f0-9]{16}$/.test(config.instance) ||
    !/^[a-f0-9]{64}$/.test(config.secret) ||
    !/^[a-f0-9]{64}$/.test(config.binarySha256) ||
    portNumber(config.port) !== config.port
  )
    throw new Error('Invalid or incompatible instance configuration.');
  const binary = join(directory, 'convex-local-backend');
  await privateFile(binary);
  if ((await digest(binary)) !== config.binarySha256)
    throw new Error(
      'Backend bytes changed; preserve this instance and use the documented fresh-instance restore path.',
    );
  return config;
}
async function initialize(directory, archivePath, port, pinnedRelease) {
  const platform = `${process.platform}-${process.arch}`,
    archive = releases[pinnedRelease]?.[platform];
  if (!archive)
    throw new Error(
      'Choose a reviewed pinned release for macOS arm64 or Linux x64. Other platforms can use the official Convex self-host instructions.',
    );
  port = portNumber(port);
  if (!archivePath || (await digest(archivePath)) !== archive.sha256)
    throw new Error(
      `Pass the verified ${pinnedRelease}/${archive.name} archive. No instance was initialized.`,
    );
  // A fresh directory keeps interrupted initialization and existing databases intact.
  await mkdir(directory, { mode: 0o700 });
  execFileSync('unzip', ['-q', resolve(archivePath), 'convex-local-backend', '-d', directory], {
    stdio: 'ignore',
    env: childEnv(),
  });
  const binary = join(directory, 'convex-local-backend');
  await chmod(binary, 0o700);
  const noticeRetained = await retainBackendNotice(directory);
  const componentNoticesRetained = await retainNativeComponentNotices(directory);
  const config = {
    release: pinnedRelease,
    platform,
    instance: `forge_${randomBytes(8).toString('hex')}`,
    secret: randomBytes(32).toString('hex'),
    port,
    binarySha256: await digest(binary),
  };
  // Native key generation; never print the key or an error containing its arguments.
  const key = execFileSync(
    binary,
    ['keygen', 'admin-key', '--instance-name', config.instance, '--instance-secret', config.secret],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() },
  ).trim();
  if (!key || /[\r\n']/.test(key)) throw new Error('Backend key generation failed.');
  await writeFile(
    join(directory, 'deployment.env'),
    `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${port}\nCONVEX_SELF_HOSTED_ADMIN_KEY='${key}'\nVITE_CONVEX_URL=http://127.0.0.1:${port}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(join(directory, 'instance.json'), `${JSON.stringify(config)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    `Initialized ${directory}. Deploy with the explicit deployment.env path; credentials were not printed.`,
  );
  console.log(
    noticeRetained
      ? 'Original Convex backend root license retained in LICENSE-convex-backend.md.'
      : 'Backend root license was not copied; the exact notice remains available in docs/vendor-notices/convex-backend-LICENSE.md.',
  );
  console.log(
    componentNoticesRetained
      ? 'Partial original component notices retained in native-component-notices/; complete binary closure remains unresolved.'
      : 'Partial component notices were not copied; originals remain in docs/vendor-notices/native-components/.',
  );
}
async function start(directory, storageEnv) {
  const config = await readSetup(directory);
  let storage = {};
  if (storageEnv) {
    await privateFile(storageEnv);
    storage = parseEnv(await readFile(storageEnv, 'utf8'));
  }
  const child = spawn(
    join(directory, 'convex-local-backend'),
    [
      '--interface',
      '127.0.0.1',
      '--port',
      String(config.port),
      '--site-proxy-port',
      String(config.port + 1),
      '--convex-origin',
      `http://127.0.0.1:${config.port}`,
      '--convex-site',
      `http://127.0.0.1:${config.port + 1}`,
      '--instance-name',
      config.instance,
      '--instance-secret',
      config.secret,
      '--disable-beacon',
      ...(storageEnv ? ['--s3-storage'] : ['--local-storage', join(directory, 'files')]),
      join(directory, 'database.sqlite3'),
    ],
    {
      cwd: directory,
      stdio: 'inherit', // Native storage consumes only the explicitly selected storage-file settings.
      env: childEnv({
        extra: { ...storage, SENTRY_DSN: '' },
        allow: ['RUST_LOG', 'RUST_BACKTRACE', 'SSL_CERT_FILE', 'SSL_CERT_DIR'],
      }),
    },
  );
  const stop = signal => child.kill(signal);
  const interrupt = () => stop('SIGINT'),
    terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') done();
        else reject(new Error('Backend exited unsuccessfully. Check its private instance logs.'));
      });
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
export async function main(args) {
  const [command, directory, archivePath, port, pinnedRelease = release] = args;
  if (
    !directory ||
    !['init', 'start'].includes(command) ||
    (command === 'start' && args.length > 3) ||
    args.length > 5
  )
    throw new Error(
      'Usage: node scripts/selfhost.mjs init <new-directory> <official-archive.zip> [port] [pinned-release] | start <directory> [private-s3-env-file]',
    );
  if (command === 'init') await initialize(resolve(directory), archivePath, port, pinnedRelease);
  else await start(resolve(directory), archivePath && resolve(archivePath));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Child-process failures can carry secret command arguments; keep errors local and generic.
  main(process.argv.slice(2)).catch(() => {
    console.error(
      'Self-host command failed. Check command arguments, archive digest, fresh directory, private permissions, platform and available ports. Existing instance data was retained.',
    );
    process.exitCode = 1;
  });
}
