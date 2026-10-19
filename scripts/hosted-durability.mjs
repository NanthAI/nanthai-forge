// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { chmod, link, mkdtemp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareSnapshots, failure, readSnapshot } from './lib/hosted-durability-compare.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const help = `Usage:
  node scripts/hosted-durability.mjs export --deployment NAME --path BACKUP.zip [--dry-run]
  node scripts/hosted-durability.mjs verify --left-export BACKUP.zip --right-export RESTORED.zip
  node scripts/hosted-durability.mjs verify --left-export BACKUP.zip --right-deployment NAME
  node scripts/hosted-durability.mjs verify --left-deployment NAME --right-deployment NAME

Export deployment fallback: HOSTED_DURABILITY_DEPLOYMENT, then CONVEX_DEPLOYMENT.
Credentials stay in the process environment or existing Convex CLI login; no key flags.
Verify downloads read-only snapshots for deployment inputs, then removes its temporary copies.
Exit: 0 = exported/equal, 1 = command/input error, 2 = comparison differs.
Requires installed pinned Convex CLI and Python 3 (ZIP reader). No import/deploy subcommand.`;

export function parseCommand(args, env = process.env) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      deployment: { type: 'string' },
      path: { type: 'string' },
      'left-export': { type: 'string' },
      'right-export': { type: 'string' },
      'left-deployment': { type: 'string' },
      'right-deployment': { type: 'string' },
    },
  });
  if (values.help) return { command: 'help' };
  if (positionals.length !== 1 || !['export', 'verify'].includes(positionals[0]))
    throw failure('ARGUMENT_INVALID');
  const command = positionals[0];
  if (command === 'export') {
    if (Object.keys(values).some(k => k.startsWith('left-') || k.startsWith('right-')))
      throw failure('ARGUMENT_INVALID');
    const deployment = values.deployment ?? env.HOSTED_DURABILITY_DEPLOYMENT ?? env.CONVEX_DEPLOYMENT;
    if (!deployment || !values.path?.endsWith('.zip')) throw failure('ARGUMENT_INVALID');
    return { command, deployment, path: resolve(values.path), dryRun: values['dry-run'] ?? false };
  }
  if (values.deployment || values.path || values['dry-run']) throw failure('ARGUMENT_INVALID');
  const side = name => {
    const path = values[`${name}-export`],
      deployment = values[`${name}-deployment`];
    if ((!path && !deployment) || (path && deployment)) throw failure('ARGUMENT_INVALID');
    return path ? { path: resolve(path) } : { deployment };
  };
  return { command, left: side('left'), right: side('right') };
}

export function deploymentOptions(deployment, env = process.env) {
  const name = deployment.replace(/^(?:dev|prod|preview):/, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw failure('ARGUMENT_INVALID');
  const key = env.CONVEX_DEPLOY_KEY ?? '';
  let args = ['--deployment-name', name];
  if (key) {
    const prefix = key.split('|')[0];
    if (/^(?:project:|preview:[^:]+:)/.test(prefix)) args = ['--deployment', name];
    else {
      // The native CLI ignores named selectors with a deployment key. Bind it here.
      if (!key.includes('|') || prefix.replace(/^(?:dev|prod|preview|custom):/, '') !== name)
        throw failure('DEPLOYMENT_CREDENTIAL_MISMATCH');
      args = [];
    }
  }
  // Empty values stop dotenv from introducing a different credential or self-host target.
  return {
    args,
    env: {
      ...env,
      CI: '1',
      CONVEX_DEPLOY_KEY: key,
      CONVEX_DEPLOYMENT: name,
      CONVEX_SELF_HOSTED_URL: '',
      CONVEX_SELF_HOSTED_ADMIN_KEY: '',
    },
  };
}

// Capture neither stdout nor stderr: provider failures may contain credentials.
// Invoke the lockfile-pinned CLI directly, never npx's implicit package download.
async function convexExport(deployment, path) {
  const selection = deploymentOptions(deployment);
  const child = spawn(
    process.execPath,
    [
      join(root, 'node_modules/convex/bin/main.js'),
      'export',
      ...selection.args,
      '--include-file-storage',
      '--path',
      path,
    ],
    {
      cwd: root,
      env: selection.env,
      stdio: 'ignore',
    },
  );
  const passed = await new Promise(resolve => {
    child.once('error', () => resolve(false));
    child.once('close', code => resolve(code === 0));
  });
  if (!passed) throw failure('CONVEX_EXPORT_FAILED');
  if (!(await stat(path)).isFile()) throw failure('EXPORT_MISSING');
  await chmod(path, 0o600);
}

export async function execute(command, exportSnapshot = convexExport) {
  if (command.command === 'help') return { help };
  if (command.command === 'export') {
    if (command.dryRun)
      return { operation: 'export', dryRun: true, includeFileStorage: true, contactedDeployment: false };
    const directory = await mkdtemp(join(dirname(command.path), '.forge-export-'));
    try {
      const path = join(directory, 'snapshot.zip');
      await exportSnapshot(command.deployment, path);
      // link is atomic and refuses an occupied destination; retries never overwrite a backup.
      await link(path, command.path);
      return { operation: 'export', complete: true, includeFileStorage: true };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'forge-durability-'));
  try {
    const read = async (side, name) => {
      const path = side.path ?? join(directory, `${name}.zip`);
      if (side.deployment) await exportSnapshot(side.deployment, path);
      return readSnapshot(path);
    };
    // Sequential exports limit provider load; each is its own consistent snapshot.
    const left = await read(command.left, 'left');
    const right = await read(command.right, 'right');
    return { operation: 'verify', ...compareSnapshots(left, right) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const result = await execute(parseCommand(process.argv.slice(2)));
    console.log(result.help ?? JSON.stringify(result, null, 2));
    if (result.equal === false) process.exitCode = 2;
  } catch (error) {
    const known = new Set([
      'ARGUMENT_INVALID',
      'DEPLOYMENT_CREDENTIAL_MISMATCH',
      'CONVEX_EXPORT_FAILED',
      'EXPORT_MISSING',
      'SNAPSHOT_READ_FAILED',
      'WORK_INDEX_UNAVAILABLE',
      'WORK_INDEX_INVALID',
      'STORAGE_INCOMPLETE',
    ]);
    console.error(
      JSON.stringify({
        error: {
          code: known.has(error.code) ? error.code : 'DURABILITY_FAILED',
          message: 'Durability command failed; credentials and provider output are withheld.',
        },
      }),
    );
    process.exitCode = 1;
  }
}
