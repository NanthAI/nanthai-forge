// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFile, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { earlyPurgeBackup } from './lib/r2-purge-backup.mjs';
import { dirname, resolve } from 'node:path';
import { syncDirectory } from '../dist/native-durability.js';
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
      'early-owner-approved': { type: 'string' },
      'backup-state-dir': { type: 'string' },
    },
  });
  if (
    positionals.length !== 1 ||
    !['purge', 'sweep'].includes(positionals[0]) ||
    !values.deployment ||
    !values.project ||
    (positionals[0] === 'purge' && !values.verification) ||
    (positionals[0] === 'sweep' &&
      (values.verification || values['early-owner-approved'] || values['backup-state-dir'])) ||
    (values['early-owner-approved'] !== undefined && !values['early-owner-approved'].trim()) ||
    !!values['early-owner-approved'] !== !!values['backup-state-dir']
  )
    throw failure('ARGUMENT_INVALID');
  deploymentOptions(values.deployment, {});
  return {
    operation: positionals[0],
    deployment: values.deployment,
    projectId: values.project,
    verification: values.verification,
    earlyOwnerApproved: values['early-owner-approved'],
    backupStateDirectory: values['backup-state-dir'],
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
    ...(state.fullDigest === true
      ? {
          fullDigest: true,
          count: state.count,
          digestChecks: state.digestChecks,
          kind: state.kind,
          failureCount: state.failures.length,
        }
      : {}),
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
async function journal(path, value) {
  const file = await open(path, 'a', 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  syncDirectory(dirname(resolve(path)));
}
/** Re-running starts stable project pages at null. Row markers/key rotation make unknown outcomes retry-safe. */
export async function executeMaintenance(command, run = runInternal, options = {}) {
  const pass =
    command.operation === 'purge'
      ? verificationReceipt(JSON.parse(await readFile(command.verification, 'utf8')), command)
      : null;
  if (command.earlyOwnerApproved !== undefined) {
    const now = options.now ?? Date.now(),
      at = Date.parse(pass?.verifiedAt);
    if (
      !command.earlyOwnerApproved.trim() ||
      !command.backupStateDirectory ||
      pass?.fullDigest !== true ||
      !Number.isSafeInteger(pass.count) ||
      pass.count < 0 ||
      pass.digestChecks !== pass.count ||
      !Number.isFinite(at) ||
      at > now ||
      now - at > 86400_000
    )
      throw failure('R2_EARLY_VERIFICATION_REQUIRED');
    pass.early = {
      ownerApproval: command.earlyOwnerApproved,
      backup: await earlyPurgeBackup(command, options),
    };
  }
  const total = {
    operation: command.operation,
    dryRun: command.dryRun,
    pages: 0,
    scanned: 0,
    eligible: 0,
    deleted: 0,
    skipped: 0,
    ...(pass?.early
      ? {
          operationId: randomUUID(),
          deployment: command.deployment,
          projectId: command.projectId,
          verification: pass,
          journal: command.verification + '.purge.jsonl',
        }
      : {}),
  };
  // Retain explicit approval and exact evidence before the first possible delete, including unknown replies.
  if (total.journal) await journal(total.journal, { ...total, status: 'started' });
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
      if (total.journal) await journal(total.journal, { ...total, status: 'page', kind, cursor });
      if (page.isDone) break;
      if (typeof page.cursor !== 'string' || page.cursor === cursor) throw failure('R2_MAINTENANCE_FAILED');
      cursor = page.cursor;
    } while (true);
  }
  if (total.journal) await journal(total.journal, { ...total, status: 'complete' });
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
