// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { deploymentOptions } from './hosted-durability.mjs';
import { failure } from './lib/hosted-durability-compare.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const maintenanceMessages = {
  ARGUMENT_INVALID: 'Check the maintenance command and its arguments.',
  DEPLOYMENT_CREDENTIAL_MISMATCH: 'Use a credential for the selected deployment.',
  R2_MAINTENANCE_FAILED: 'Storage maintenance failed; retry the original command.',
};
const argumentErrors = new Set([
  'ERR_PARSE_ARGS_UNKNOWN_OPTION',
  'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
  'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
]);
export function parseMaintenance(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { deployment: { type: 'string' }, project: { type: 'string' }, apply: { type: 'boolean' } },
  });
  if (positionals.length !== 1 || positionals[0] !== 'sweep' || !values.deployment || !values.project)
    throw failure('ARGUMENT_INVALID');
  deploymentOptions(values.deployment, {});
  return {
    operation: 'sweep',
    deployment: values.deployment,
    projectId: values.project,
    dryRun: !values.apply,
  };
}
async function runInternal(deployment, name, args) {
  const selection = deploymentOptions(deployment);
  const child = spawn(
    process.execPath,
    [resolve(root, 'node_modules/convex/bin/main.js'), 'run', ...selection.args, name, JSON.stringify(args)],
    { cwd: root, env: selection.env, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let output = '';
  child.stdout.on('data', bytes => {
    output += bytes;
  });
  const ok = await new Promise(resolve => {
    child.once('error', () => resolve(false));
    child.once('close', code => resolve(code === 0));
  });
  if (!ok) throw failure('R2_MAINTENANCE_FAILED');
  try {
    return JSON.parse(output);
  } catch {
    throw failure('R2_MAINTENANCE_FAILED');
  }
}
/** Re-running starts stable project pages at null. Row markers/key rotation make unknown outcomes retry-safe. */
export async function executeMaintenance(command, run = runInternal) {
  const total = {
    operation: command.operation,
    dryRun: command.dryRun,
    pages: 0,
    scanned: 0,
    eligible: 0,
    deleted: 0,
    skipped: 0,
  };
  let cursor = null;
  do {
    const page = await run(command.deployment, 'projectR2Maintenance:sweepPage', {
      projectId: command.projectId,
      cursor,
      dryRun: command.dryRun,
    });
    total.pages++;
    for (const key of ['scanned', 'eligible', 'deleted', 'skipped']) {
      if (!Number.isSafeInteger(page[key]) || page[key] < 0) throw failure('R2_MAINTENANCE_FAILED');
      total[key] += page[key];
    }
    if (page.isDone) break;
    if (typeof page.cursor !== 'string' || page.cursor === cursor) throw failure('R2_MAINTENANCE_FAILED');
    cursor = page.cursor;
  } while (true);
  return total;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await executeMaintenance(parseMaintenance(process.argv.slice(2)))));
  } catch (error) {
    const code = argumentErrors.has(error?.code)
      ? 'ARGUMENT_INVALID'
      : Object.hasOwn(maintenanceMessages, error?.code)
        ? error.code
        : 'R2_MAINTENANCE_FAILED';
    console.error(JSON.stringify({ error: { code, message: maintenanceMessages[code] } }));
    process.exitCode = 1;
  }
}
