// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { deploymentOptions } from './hosted-durability.mjs';
import { failure } from './lib/hosted-durability-compare.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
export function parseMaintenance(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      deployment: { type: 'string' },
      project: { type: 'string' },
      verification: { type: 'string' },
      apply: { type: 'boolean' },
    },
  });
  if (
    positionals.length !== 1 ||
    !['purge', 'sweep'].includes(positionals[0]) ||
    !values.deployment ||
    !values.project ||
    (positionals[0] === 'purge' && !values.verification) ||
    (positionals[0] === 'sweep' && values.verification)
  )
    throw failure('ARGUMENT_INVALID');
  deploymentOptions(values.deployment, {});
  return {
    operation: positionals[0],
    deployment: values.deployment,
    projectId: values.project,
    verification: values.verification,
    dryRun: !values.apply,
  };
}
export function verificationReceipt(state, command) {
  let binding;
  try {
    binding = JSON.parse(state.project);
  } catch {
    throw failure('R2_VERIFIED_PASS_REQUIRED');
  }
  const deployment = command.deployment.replace(/^(?:dev|prod|preview):/, '');
  const expected = [deployment, `https://${deployment}.convex.cloud`];
  if (
    !Array.isArray(binding) ||
    !expected.includes(binding[0]) ||
    binding[1] !== command.projectId ||
    state.schema !== 1 ||
    state.mode !== 'verify' ||
    state.complete !== true ||
    state.kind !== 4 ||
    !Array.isArray(state.failures) ||
    state.failures.length ||
    !state.operationId ||
    !Number.isSafeInteger(state.verificationRevision) ||
    !state.verifiedAt ||
    !state.safeToPurgeAfter
  )
    throw failure('R2_VERIFIED_PASS_REQUIRED');
  const { operationId, mode, complete, verificationRevision, verifiedAt, safeToPurgeAfter } = state;
  return {
    operationId,
    project: command.projectId,
    mode,
    complete,
    verificationRevision,
    verifiedAt,
    safeToPurgeAfter,
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
  const pass =
    command.operation === 'purge'
      ? verificationReceipt(JSON.parse(await readFile(command.verification, 'utf8')), command)
      : null;
  const total = {
    operation: command.operation,
    dryRun: command.dryRun,
    pages: 0,
    scanned: 0,
    eligible: 0,
    deleted: 0,
    skipped: 0,
  };
  for (const kind of command.operation === 'purge'
    ? ['objects', 'backups', 'proposals', 'archives']
    : [null]) {
    let cursor = null;
    do {
      const page = await run(command.deployment, `projectR2Maintenance:${command.operation}Page`, {
        projectId: command.projectId,
        cursor,
        dryRun: command.dryRun,
        ...(pass ? { kind, pass } : {}),
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
  }
  return total;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await executeMaintenance(parseMaintenance(process.argv.slice(2)))));
  } catch {
    console.error(
      JSON.stringify({
        error: {
          code: 'R2_MAINTENANCE_FAILED',
          message:
            'Storage maintenance failed; retry the original command. Provider output and credentials are withheld.',
        },
      }),
    );
    process.exitCode = 1;
  }
}
