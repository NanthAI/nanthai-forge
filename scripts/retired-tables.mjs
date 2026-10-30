// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { deploymentOptions } from './hosted-durability.mjs';
import { failure } from './lib/hosted-durability-compare.mjs';
import { exportTables, inventory, restoreTables } from './lib/retired-tables.mjs';
import { checkApproval, definitionBlockers, purgePlan } from './lib/retired-tables-purge.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const help = `Usage (B1.9 retired Convex tables; nothing here deletes data):
  node scripts/retired-tables.mjs inventory --deployment NAME
  node scripts/retired-tables.mjs export --deployment NAME --dir NEW_PRIVATE_DIR
  node scripts/retired-tables.mjs restore --deployment SCRATCH_NAME --dir EXPORT_DIR
  node scripts/retired-tables.mjs purge --deployment NAME --dir EXPORT_DIR --deployed-at ISO [--execute --approval FILE]

Reads and imports go through the lockfile-pinned Convex CLI with the existing login or process credentials.
purge is a dry run. --execute needs an approval record that names the deployment, the export manifest digest
and two completed weekly backups after --deployed-at; the deletion step itself is not enabled in this slice.
Exit: 0 = done, 1 = failed.`;

export function parseCommand(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      deployment: { type: 'string' },
      dir: { type: 'string' },
      'deployed-at': { type: 'string' },
      execute: { type: 'boolean' },
      approval: { type: 'string' },
    },
  });
  if (values.help) return { command: 'help' };
  const [command] = positionals;
  if (positionals.length !== 1 || !['inventory', 'export', 'restore', 'purge'].includes(command))
    throw failure('ARGUMENT_INVALID');
  deploymentOptions(values.deployment ?? '', {});
  if (command !== 'inventory' && !values.dir) throw failure('ARGUMENT_INVALID');
  if (command === 'purge' && !values['deployed-at']) throw failure('ARGUMENT_INVALID');
  if (command !== 'purge' && (values.execute || values.approval || values['deployed-at']))
    throw failure('ARGUMENT_INVALID');
  if (values.execute && !values.approval) throw failure('APPROVAL_REQUIRED');
  if (values.approval && !values.execute) throw failure('ARGUMENT_INVALID');
  let deployedAt;
  if (values['deployed-at']) {
    deployedAt = new Date(values['deployed-at']);
    if (Number.isNaN(deployedAt.getTime())) throw failure('ARGUMENT_INVALID');
  }
  return {
    command,
    deployment: values.deployment.replace(/^(?:dev|prod|preview):/, ''),
    ...(values.dir ? { directory: resolve(values.dir) } : {}),
    ...(deployedAt ? { deployedAt } : {}),
    execute: values.execute ?? false,
    ...(values.approval ? { approval: resolve(values.approval) } : {}),
  };
}

// Invokes the pinned CLI directly. stderr and exit details are dropped: provider output may hold credentials.
// Row text on stdout is the data being exported, so it is captured and never logged.
export function convexRunner(deployment) {
  const selection = deploymentOptions(deployment);
  const run = (args, capture) =>
    new Promise((done, fail) => {
      const child = spawn(
        process.execPath,
        [join(root, 'node_modules/convex/bin/main.js'), ...args, ...selection.args],
        {
          cwd: root,
          env: selection.env,
          stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
        },
      );
      const chunks = [];
      child.stdout?.on('data', chunk => chunks.push(chunk));
      child.once('error', () => fail(failure('CONVEX_CLI_FAILED')));
      child.once('close', code =>
        code === 0 ? done(Buffer.concat(chunks).toString('utf8')) : fail(failure('CONVEX_CLI_FAILED')),
      );
    });
  return {
    data: (table, limit) =>
      run(['data', table, '--limit', String(limit), '--order', 'asc', '--format', 'jsonLines'], true),
    importTable: (table, path, mode) =>
      run([
        'import',
        '--table',
        table,
        '--format',
        'jsonLines',
        mode === 'replace' ? '--replace' : '--append',
        '--yes',
        path,
      ]),
  };
}

export async function execute(
  command,
  runner = command.command === 'help' ? null : convexRunner(command.deployment),
) {
  if (command.command === 'help') return { help };
  if (command.command === 'inventory') return { operation: 'inventory', ...(await inventory(runner)) };
  if (command.command === 'export') {
    const { manifestSha256, manifest } = await exportTables(runner, command.directory, {
      deployment: command.deployment,
    });
    return { operation: 'export', manifestSha256, tables: manifest.tables };
  }
  if (command.command === 'restore')
    return { operation: 'restore', ...(await restoreTables(runner, command.directory, command)) };
  const plan = await purgePlan(runner, command.directory, command);
  const blockers = await definitionBlockers(root);
  if (command.execute) {
    let record;
    try {
      record = JSON.parse(await readFile(command.approval, 'utf8'));
    } catch {
      throw failure('APPROVAL_INVALID');
    }
    checkApproval(record, plan, command);
    // A valid approval is necessary, not sufficient: this slice ships no deletion step.
    throw failure('PURGE_NOT_ENABLED');
  }
  return {
    operation: 'purge',
    dryRun: true,
    wouldDelete: false,
    deletion: 'not performed; --execute needs the approval record and a later owner-approved slice',
    ...plan,
    definitionRemovalBlockers: blockers,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const result = await execute(parseCommand(process.argv.slice(2)));
    console.log(result.help ?? JSON.stringify(result, null, 2));
  } catch (error) {
    const known =
      /^(?:ARGUMENT_INVALID|APPROVAL_[A-Z_]+|DEPLOY_TIME_REQUIRED|PURGE_NOT_ENABLED|TABLE_[A-Z_]+|EXPORT_[A-Z_]+|RESTORE_[A-Z_]+|CONVEX_CLI_FAILED|DEPLOYMENT_CREDENTIAL_MISMATCH)$/;
    console.error(
      JSON.stringify({
        error: {
          code: known.test(error.code) ? error.code : 'RETIRED_TABLES_FAILED',
          message: 'Command failed; credentials and provider output are withheld.',
        },
      }),
    );
    process.exitCode = 1;
  }
}
