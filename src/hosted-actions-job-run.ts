// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, toolchainEnvAllow } from '../scripts/child-env.mjs';
import { ContractTimingReader } from './contract-test-timings.js';
import { HostedOutputRedactor } from './hosted-output-redactor.js';
import { semanticCheckCommand } from './semantic-check-command.js';
import { semanticTests } from './intent-semantic-conflict.js';
import { workspaceTestRunner } from './workspace-test-runner.js';
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
import { secretScanFailureCommand, type SecretScanResult } from './secret-scan.js';
import { junitDirEnv } from './junit-report.js';
import { junitDirectory, mergeJunitReports, readJunitReports } from './junit-report-files.js';
import { writeCheckPackages } from './package-graph-checkout.js';
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
  // Fixed-cost phases around the command (Issue ca8a2ca4), printed once at the end: durations only.
  const phases: Record<string, number> = {};
  let mark = performance.now();
  const lap = (phase: string) => {
    const now = performance.now();
    phases[phase] = Math.round(now - mark);
    mark = now;
  };
  // The plan artifact is a source pin, never a live execution permission.
  const run = await client.preflight();
  lap('preflightMs');
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
  let sourceCache: string | undefined,
    setupFailed = false,
    packages: ReturnType<typeof writeCheckPackages> = null;
  try {
    sourceCache = await setupActionsJob(run, directory, planPath);
    invariant(
      savePin(JSON.parse(readFileSync(planPath, 'utf8'))).sha256 === run.plan.manifest.sha256,
      'EVIDENCE_CHANGED',
      'Actions setup changed the plan.',
    );
    // A scoped configured command also gets the manifest package graph's affected packages
    // (FORGE_CHECK_PACKAGES), read from the verified workspace: no repository code, no Forge call.
    // Advisory input: an unreadable tree leaves the command without it, never fails the check.
    if (!recipe.standard && !commandOverride)
      try {
        packages = writeCheckPackages(directory, recipe.selection?.changes, {
          node: process.execPath,
          script: join(import.meta.dirname, '../scripts/check-packages-run.mjs'),
        });
      } catch {
        packages = null;
      }
    // A configured command's Intent contract union runs once: in its static job, beside its shards,
    // with the project's own test runner, read from the verified workspace.
    if (!recipe.standard && !commandOverride && shard === 'static') {
      const unionTests = semanticTests(run.semanticPlan);
      command = semanticCheckCommand(
        command,
        run.semanticPlan,
        process.execPath,
        [],
        unionTests.length ? workspaceTestRunner(directory, unionTests) : undefined,
      );
    }
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
  // A secret the plan step found fails the static job before project code runs.
  const secretScan = recipe.selection?.secretScan as
    | Pick<SecretScanResult, 'findings' | 'more' | 'selfAllowed'>
    | undefined;
  if (shard === 'static' && secretScan?.findings?.length)
    command = secretScanFailureCommand(process.execPath, secretScan);
  let tail = Buffer.alloc(0);
  const reports = new ContractTimingReader({ secrets: [], paths: [directory, process.env.HOME ?? ''] });
  const redactor = new HostedOutputRedactor({ secrets: [], paths: [directory, process.env.HOME ?? ''] });
  const observe = (bytes: Buffer) => {
    const clean = redactor.write(bytes);
    tail = Buffer.concat([tail, clean]).subarray(-directLogBytes);
  };
  // Any check may write JUnit XML here (docs/operations/github-actions-checks.md).
  const junit = junitDirectory();
  /** One executor process. `part` is the shard pool part: kept files, or one unit (tests only). */
  const spawnPart = (part?: string) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: directory,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...childEnv({ allow: ['CI', 'PATH', ...toolchainEnvAllow()] }),
        ...(sourceCache ? { FORGE_SOURCE_CACHE_DIR: sourceCache } : {}),
        FORGE_ACTIONS_PLAN: planPath,
        FORGE_ACTIONS_SHARD: shard,
        ...(part ? { FORGE_ACTIONS_POOL_PART: part } : {}),
        ...(packages ? { FORGE_CHECK_PACKAGES: packages.path } : {}),
        ...(packages?.run ? { FORGE_CHECK_PACKAGES_RUN: packages.run } : {}),
        [junitDirEnv]: junit.directory,
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
  const note = (line: string) => {
    console.log(line);
    observe(Buffer.from(`${line}\n`));
  };
  let exitCode: number;
  let yielded: string[] | undefined;
  lap('setupMs');
  try {
    exitCode = await spawnPart(units ? 'kept' : undefined);
    if (units) {
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
    // Forge's own markers win; JUnit fills in the files they did not report.
    const junitReports = readJunitReports(junit.directory, directory);
    for (const line of junitReports.notes) note(line);
    const added = mergeJunitReports(reports, junitReports.reports);
    if (added) note(`JUnit: read ${added} test file report${added === 1 ? '' : 's'}.`);
  } finally {
    junit.remove();
    packages?.remove();
  }
  lap('commandMs');
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
      const put = async () =>
        actionsInfrastructureResponse(
          await client.request(target.url, {
            method: 'PUT',
            headers: target.headers,
            body: tail,
            redirect: 'error',
            signal,
          }),
        );
      // One 403 from log storage may be transient: retry once after a short backoff.
      let response = await put();
      if (response.status === 403) {
        await new Promise(resolve => setTimeout(resolve, 300));
        response = await put();
      }
      invariant(response.ok || response.status === 412, 'R2_VERIFY_FAILED', 'Output upload failed.');
    });
  }
  result.execution.endedAt = new Date().toISOString();
  await client.call({ kind: 'result', result, ...(logBytes !== undefined ? { logBytes } : {}) });
  lap('reportMs');
  console.log(`run: phases ${JSON.stringify(phases)}`);
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
