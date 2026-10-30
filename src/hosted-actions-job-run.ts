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
import { invariant } from './errors.js';
import { setupActionsJob } from './hosted-actions-job-setup.js';
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
  let sourceCache: string | undefined;
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
    command = [
      process.execPath,
      '--eval',
      "console.error('SOURCE_HASH_MISMATCH: Actions setup verification failed.'); process.exitCode = 1;",
    ];
  }
  const child = spawn(command[0]!, command.slice(1), {
    cwd: directory,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...childEnv({ allow: ['CI', 'PATH'] }),
      ...(sourceCache ? { FORGE_SOURCE_CACHE_DIR: sourceCache } : {}),
      FORGE_ACTIONS_PLAN: planPath,
      FORGE_ACTIONS_SHARD: shard,
    },
  });
  let tail = Buffer.alloc(0);
  const reports = new ContractTimingReader({ secrets: [], paths: [directory, process.env.HOME ?? ''] });
  const redactor = new HostedOutputRedactor({ secrets: [], paths: [directory, process.env.HOME ?? ''] });
  const observe = (bytes: Buffer) => {
    const clean = redactor.write(bytes);
    tail = Buffer.concat([tail, clean]).subarray(-directLogBytes);
  };
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
  const exitCode = await new Promise<number>(resolve => {
    child.on('error', () => resolve(127));
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  tail = Buffer.concat([tail, redactor.write(Buffer.alloc(0), true)]).subarray(-directLogBytes);
  const log = tail.length
    ? {
        object: { sha256: digest(tail), size: tail.length },
        failureSummary: exitCode ? tail.toString('utf8').slice(-4096) : '',
      }
    : undefined;
  if (log) {
    const target = (await client.call({ kind: 'output', index, log })) as {
      url: string;
      headers: Record<string, string>;
    };
    const response = await fetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: tail,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    invariant(response.ok || response.status === 412, 'R2_VERIFY_FAILED', 'Output upload failed.');
  }
  await client.call({
    kind: 'result',
    result: {
      index,
      exitCode,
      ...(log ? { log } : {}),
      contractReports: reports.reports,
      testFiles: checkFileSummary(reports.reports),
      execution: { startedAt, endedAt: new Date().toISOString() },
    },
  });
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
