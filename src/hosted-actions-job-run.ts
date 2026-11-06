// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { ContractTimingReader } from './contract-test-timings.js';
import { HostedOutputRedactor } from './hosted-output-redactor.js';
import { semanticCheckCommand } from './semantic-check-command.js';
import { digest } from './hash.js';
import { directLogBytes } from './hosted-actions-direct.js';
import { ActionsJobClient } from './hosted-actions-job-client.js';
import { checkFileSummary } from './check-file-summary.js';
import { retryActionsInfrastructure, actionsInfrastructureResponse } from './hosted-actions-retry.js';
import { invariant } from './errors.js';
import { setupActionsJob } from './hosted-actions-job-setup.js';
import { actionsInlineLogCapability } from './hosted-actions-capabilities.js';
import { poolUnits } from '../scripts/shard-pool.mjs';
import { describePoolOutcome, poolClaimsSchema, runShardPool } from './hosted-actions-pool.js';
/** Below the server's 512 KiB request window, leaving room for identity fields. */
const inlineRequestBytes = 448 * 1024;
/** Credentials remain in the fixed supervisor; the project receives a clean env.
 * Full stdout stays on Actions. Forge retains at most 64 KiB per job. */
async function executeActiveActionsJob(
  client: ActionsJobClient,
  directory: string,
  planPath: string,
  shard: string,
  commandOverride?: string[],
) {
  // Runner clock from supervisor process start; earlier workflow steps are not included.
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  // The plan artifact is a source pin, never a live execution permission.
  const run = await client.preflight();
  const recipe = JSON.parse(readFileSync(planPath, 'utf8'));
  const index = shard === 'static' ? recipe.groups.length : Number(shard);
  invariant(
    run.plan && Number.isSafeInteger(index) && index >= 0 && index < run.plan.shardCount,
    'EVIDENCE_CHANGED',
    'Select a planned shard.',
  );
  const { pin, ...pins } = recipe;
  const { checkPin } = await import('./hosted-check.js');
  const { savePin } = await import('./hosted-save.js');
  invariant(
    pin === checkPin(pins) && savePin(recipe).sha256 === run.plan.manifest.sha256,
    'EVIDENCE_CHANGED',
    'Downloaded Actions plan differs from the original.',
  );
  let command = commandOverride ?? [
    process.execPath,
    join(import.meta.dirname, '../scripts/hosted-actions-execute.mjs'),
  ];
  if (!recipe.standard && !commandOverride)
    command = semanticCheckCommand(command, run.semanticPlan, process.execPath);
  let sourceCache: string | undefined,
    setupFailed = false;
  try {
    sourceCache = await setupActionsJob(run, directory, planPath);
    invariant(
      savePin(JSON.parse(readFileSync(planPath, 'utf8'))).sha256 === run.plan.manifest.sha256,
      'EVIDENCE_CHANGED',
      'Actions setup changed the plan.',
    );
  } catch {
    // Record a failed exact check through the ordinary result callback. Never run
    // tests against changed bytes or treat a setup exit as passing evidence.
    setupFailed = true;
    command = [
      process.execPath,
      '--eval',
      "console.error('SOURCE_HASH_MISMATCH: Actions setup verification failed.'); process.exitCode = 1;",
    ];
  }
  let tail = Buffer.alloc(0);
  const reports = new ContractTimingReader({ secrets: [], paths: [directory, process.env.HOME ?? ''] });
  const redactor = new HostedOutputRedactor({ secrets: [], paths: [directory, process.env.HOME ?? ''] });
  const observe = (bytes: Buffer) => {
    const clean = redactor.write(bytes);
    tail = Buffer.concat([tail, clean]).subarray(-directLogBytes);
  };
  /** One executor process. `part` is the shard pool part: kept files, or one unit (tests only). */
  const spawnPart = (part?: string) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: directory,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...childEnv({ allow: ['CI', 'PATH'] }),
        ...(sourceCache ? { FORGE_SOURCE_CACHE_DIR: sourceCache } : {}),
        FORGE_ACTIONS_PLAN: planPath,
        FORGE_ACTIONS_SHARD: shard,
        ...(part ? { FORGE_ACTIONS_POOL_PART: part } : {}),
      },
    });
    // Decode across chunks before parsing complete machine reports.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      process.stdout.write(text);
      reports.accept(text);
      observe(Buffer.from(text));
    });
    child.stderr.on('data', (text: string) => {
      process.stderr.write(text);
      observe(Buffer.from(text));
    });
    return new Promise<number>(resolve => {
      child.on('error', () => resolve(127));
      child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
  };
  // Shard pool (scripts/shard-pool.mjs): run the kept front, then claim units from the pool.
  const units =
    recipe.pool && recipe.standard && shard !== 'static' && !setupFailed
      ? poolUnits(recipe.groups, recipe.pool)
      : null;
  let exitCode = await spawnPart(units ? 'kept' : undefined);
  let yielded: string[] | undefined;
  if (units) {
    const note = (line: string) => {
      console.log(line);
      observe(Buffer.from(`${line}\n`));
    };
    // Kept files that never started (install or build failed) mean no unit can run here either.
    if (exitCode !== 0 && !Object.keys(reports.reports).length)
      note('Shard pool: skipped; the kept files did not run, so this shard claims nothing');
    else {
      const claims = poolClaimsSchema.safeParse(client.poolClaims);
      const outcome = await runShardPool({
        units,
        home: index,
        claims: claims.success ? claims.data : null,
        request: ((url: string, init: RequestInit) => client.request(url, init)) as typeof fetch,
        run: async unit => {
          const code = await spawnPart(String(unit.unit));
          if (!exitCode) exitCode = code;
        },
      });
      note(describePoolOutcome(outcome, index, units));
      yielded = outcome.yielded.flatMap(unit => units[unit]!.files);
    }
  }
  tail = Buffer.concat([tail, redactor.write(Buffer.alloc(0), true)]).subarray(-directLogBytes);
  const log = tail.length
    ? {
        object: { sha256: digest(tail), size: tail.length },
        failureSummary: exitCode ? tail.toString('utf8').slice(-4096) : '',
      }
    : undefined;
  const result = {
    index,
    exitCode,
    ...(log ? { log } : {}),
    contractReports: reports.reports,
    testFiles: checkFileSummary(reports.reports),
    execution: { startedAt, endedAt: new Date().toISOString() },
    // Files this home shard yielded to another claimer; the server fails the check if none reports them.
    ...(yielded ? { pool: { yielded } } : {}),
  };
  // One result call stores the log too, unless it would crowd the server's metadata window.
  const logBytes =
    log &&
    client.capabilities.includes(actionsInlineLogCapability) &&
    Buffer.byteLength(JSON.stringify(result)) + Math.ceil(tail.length / 3) * 4 <= inlineRequestBytes
      ? tail.toString('base64')
      : undefined;
  if (log && logBytes === undefined) {
    const target = (await client.call({ kind: 'output', index, log })) as {
      url: string;
      headers: Record<string, string>;
    };
    await retryActionsInfrastructure(async signal => {
      const response = await actionsInfrastructureResponse(
        await client.request(target.url, {
          method: 'PUT',
          headers: target.headers,
          body: tail,
          redirect: 'error',
          signal,
        }),
      );
      invariant(response.ok || response.status === 412, 'R2_VERIFY_FAILED', 'Output upload failed.');
    });
  }
  result.execution.endedAt = new Date().toISOString();
  await client.call({ kind: 'result', result, ...(logBytes !== undefined ? { logBytes } : {}) });
  return exitCode;
}

export async function executeActionsJob(...args: Parameters<typeof executeActiveActionsJob>) {
  try {
    return await executeActiveActionsJob(...args);
  } catch (error) {
    if ((error as { code?: string })?.code !== 'CHECK_CANCELLED') throw error;
    console.log('Forge check cancelled.');
    return 0;
  }
}
