// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { childEnv, toolchainEnvAllow } from '../scripts/child-env.mjs';
import { ContractTimingReader, unstoredReportsNote } from './contract-test-timings.js';
import { HostedOutputRedactor } from './hosted-output-redactor.js';
import { semanticCheckCommand } from './semantic-check-command.js';
import { semanticTests } from './intent-semantic-conflict.js';
import { workspaceTestRunner } from './workspace-test-runner.js';
import { digest } from './hash.js';
import {
  resultEnvelopeBody,
  readResultSlot,
  uploadResultSlot,
  notifyPackedResultBatch,
} from './hosted-actions-result-batch.js';
import { directLogBytes, directResultSchema } from './hosted-actions-direct.js';
import { ActionsJobClient } from './hosted-actions-job-client.js';
import { checkFileSummary } from './check-file-summary.js';
import {
  retryActionsInfrastructure,
  actionsInfrastructureResponse,
  actionsDeliveryDeadlineMs,
  actionsDeliveryPolicy,
} from './hosted-actions-retry.js';
import { invariant } from './errors.js';
import { setupActionsJob } from './hosted-actions-job-setup.js';
import { actionsInlineLogCapability } from './hosted-actions-capabilities.js';
import { poolUnits } from '../scripts/shard-pool.mjs';
import { describePoolOutcome, poolClaimsSchema, runShardPool } from './hosted-actions-pool.js';
import { secretScanFailureCommand, type SecretScanResult } from './secret-scan.js';
import { junitDirEnv } from './junit-report.js';
import { junitDirectory, mergeJunitReports, readJunitReports } from './junit-report-files.js';
import { writeCheckPackages } from './package-graph-checkout.js';
/** A failing command that names the pinned plan refusal's code and message. */
export function planErrorCommand(executable: string, error: { code: string; message: string }) {
  return [
    executable,
    '--eval',
    `console.error(${JSON.stringify(`${error.code}: ${error.message}`)}); process.exitCode = 1;`,
  ];
}
import {
  candidateAccessNotes,
  candidateIsolation,
  homePaths,
  sharedIsolationRefusal,
  toolchainReadable,
  toolchainState,
  type CandidateIsolation,
} from './candidate-user.js';
import { cachePaths } from './actions-toolchains.js';
const unrequested: CandidateIsolation = {
  mode: 'shared',
  reason: 'the supervisor did not request a Candidate user',
};
let isolation: CandidateIsolation = unrequested,
  requested = false;
/** Called once by the fixed supervisor entry (scripts/hosted-actions-job.mjs) before it runs a
 * shard; embedding callers and tests keep the runner user. Once requested, a shared result fails
 * the check unless the owner's runner configuration allows it (sharedIsolationRefusal). `null`
 * restores the embedding default. */
export function isolateCandidates(value: CandidateIsolation | null = candidateIsolation()) {
  isolation = value ?? unrequested;
  requested = value !== null;
  return isolation;
}
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
  // Nothing after this point reads the runner's job tokens from the environment (Issue 3b67363d).
  client.holdRunnerTokens();
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
  // A plan refusal the Candidate decided fails every job at once with its code; no setup or project code runs.
  const planError = recipe.selection?.planError as { code: string; message: string } | undefined;
  // No Candidate user and no owner opt-in: the check fails here, before any source or project code.
  const refused = requested ? sharedIsolationRefusal(isolation, run.configuration) : undefined;
  try {
    sourceCache = planError || refused ? undefined : await setupActionsJob(run, directory, planPath);
    invariant(
      savePin(JSON.parse(readFileSync(planPath, 'utf8'))).sha256 === run.plan.manifest.sha256,
      'EVIDENCE_CHANGED',
      'Actions setup changed the plan.',
    );
    // A scoped configured command also gets the manifest package graph's affected packages
    // (FORGE_CHECK_PACKAGES), read from the verified workspace: no repository code, no Forge call.
    // Advisory input: an unreadable tree leaves the command without it, never fails the check.
    if (!recipe.standard && !commandOverride && !refused)
      try {
        packages = writeCheckPackages(
          directory,
          recipe.selection?.changes,
          {
            node: process.execPath,
            script: join(import.meta.dirname, '../scripts/check-packages-run.mjs'),
          },
          run.check,
          // The job's temp folder, beside the plan: handed to the Candidate user read-only below.
          resolve(dirname(planPath)),
        );
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
  if (planError) {
    setupFailed = true;
    command = planErrorCommand(process.execPath, planError);
  }
  if (refused) {
    setupFailed = true;
    command = [
      process.execPath,
      '--eval',
      `console.error(${JSON.stringify(refused)}); process.exitCode = 1;`,
    ];
  }
  let tail = Buffer.alloc(0);
  const reports = new ContractTimingReader({ secrets: [], paths: [directory, process.env.HOME ?? ''] });
  const redactor = new HostedOutputRedactor({ secrets: [], paths: [directory, process.env.HOME ?? ''] });
  const observe = (bytes: Buffer) => {
    const clean = redactor.write(bytes);
    tail = Buffer.concat([tail, clean]).subarray(-directLogBytes);
  };
  // Any check may write JUnit XML here (docs/operations/github-actions-checks.md).
  const junit = junitDirectory();
  // Candidate children run as their own unprivileged user where the runner allows it (Linux with
  // passwordless sudo, Issue 432164bf); elsewhere only with the owner's opt-in (Issue 3b67363d).
  const placement =
    isolation.mode === 'user'
      ? `Candidate user: project code runs as ${isolation.user}, without the runner's credentials, environment or sudo.`
      : refused
        ? `Candidate user: unavailable (${isolation.reason}); project code does not run.`
        : `Candidate user: project code runs as the runner user (${isolation.reason}${requested ? "; the owner's runner configuration allows shared mode" : ''}).`;
  console.log(placement);
  observe(Buffer.from(`${placement}\n`));
  const home = process.env.HOME ?? '';
  const paths = {
    // The Candidate's own: its checkout, its report folder and the dependency caches restored for it.
    writable: [
      directory,
      junit.directory,
      ...(recipe.actions?.cache ? homePaths(cachePaths(recipe.actions.cache), home) : []),
      // Forge's own suite installs from the npm download cache restored with the control install.
      ...(recipe.standard && home ? [join(home, '.npm')] : []),
    ],
    readable: [
      resolve(import.meta.dirname, '..'),
      planPath,
      join(dirname(planPath), 'forge-actions-state.json'),
      ...(sourceCache ? [sourceCache] : []),
      // The packages list and runner: the Candidate reads and runs them, never changes them.
      ...(packages ? [packages.folder] : []),
      ...toolchainReadable(process.env, home),
    ],
    // What the declared toolchains write into their own installs: private copies (src/ecosystems.ts).
    ...toolchainState(
      process.env,
      ((recipe.actions?.toolchains ?? []) as { tool: string }[]).map(t => t.tool),
      home,
    ),
  };
  const access =
    isolation.mode === 'user'
      ? candidateAccessNotes({
          user: isolation.user,
          env: process.env,
          paths,
          inputs: packages ? [packages.folder] : [],
        })
      : undefined;
  /** One executor process. `part` is the shard pool part: kept files, or one unit (tests only). */
  const spawnPart = (part?: string) => {
    const env: Record<string, string> = {
      ...(childEnv({ allow: ['CI', 'PATH', ...toolchainEnvAllow()] }) as Record<string, string>),
      ...(sourceCache ? { FORGE_SOURCE_CACHE_DIR: sourceCache } : {}),
      FORGE_ACTIONS_PLAN: planPath,
      FORGE_ACTIONS_SHARD: shard,
      ...(part ? { FORGE_ACTIONS_POOL_PART: part } : {}),
      ...(packages ? { FORGE_CHECK_PACKAGES: packages.path } : {}),
      ...(packages?.run ? { FORGE_CHECK_PACKAGES_RUN: packages.run } : {}),
      [junitDirEnv]: junit.directory,
    };
    const argv = isolation.mode === 'user' ? isolation.command(command, env, directory, paths) : command;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: directory,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    // Decode across chunks before parsing complete machine reports.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      process.stdout.write(text);
      reports.accept(text);
      access?.accept(text);
      observe(Buffer.from(text));
    });
    child.stderr.on('data', (text: string) => {
      process.stderr.write(text);
      access?.accept(text);
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
  if (shard === 'static')
    for (const line of (recipe.selection?.notes as string[] | undefined) ?? []) note(line);
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
    // A path the Candidate user could not write or see is named, not only the tool's own error.
    if (exitCode) for (const line of access?.notes() ?? []) note(line);
    // Forge's own markers win; JUnit fills in the files they did not report.
    const junitReports = readJunitReports(junit.directory, directory);
    for (const line of junitReports.notes) note(line);
    const added = mergeJunitReports(reports, junitReports.reports);
    if (added) note(`JUnit: read ${added} test file report${added === 1 ? '' : 's'}.`);
    // A failed report under a name Forge cannot store still fails this shard (Issue 7a0ccbef).
    const unstored = unstoredReportsNote(reports);
    if (unstored) {
      note(unstored.line);
      if (unstored.failed && !exitCode) exitCode = 1;
    }
  } finally {
    if (isolation.mode === 'user') isolation.remove(junit.directory);
    else junit.remove();
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
    isolation: isolation.mode,
    // Files this home shard yielded to another claimer; the server fails the check if none reports them.
    ...(yielded ? { pool: { yielded } } : {}),
  };
  // New servers give the fixed supervisor a private immutable inbox in the plan bundle.
  // Candidate code never sees its capabilities. Upload contains the log and reports together.
  if (client.resultBatch) {
    result.execution.endedAt = new Date().toISOString();
    const targets = client.resultBatch;
    let body: string;
    let selected: ReturnType<typeof directResultSchema.parse> = result;
    try {
      // Preserve the existing deterministic-validation fallback: malformed report names fail
      // the shard once with its log, rather than repeatedly reporting runner-unavailable.
      directResultSchema.parse(selected);
    } catch {
      exitCode ||= 1;
      selected = {
        index,
        exitCode,
        execution: result.execution,
        isolation: result.isolation,
        ...(log
          ? {
              log: {
                ...log,
                failureSummary:
                  `Forge refused this shard's test reports as invalid. Read the shard log.\n${log.failureSummary}`.slice(
                    0,
                    4096,
                  ),
              },
            }
          : {}),
      };
    }
    const encodedLog = log ? tail.toString('base64') : undefined;
    const request = async (url: string, init?: RequestInit) =>
      actionsInfrastructureResponse(await client.request(url, init));
    if ('packed' in targets) {
      body = resultEnvelopeBody({
        result: selected,
        packed: true,
        ...(encodedLog ? { logBytes: encodedLog } : {}),
      });
      await retryActionsInfrastructure(
        signal => uploadResultSlot(targets.slots[index]!, body, request, signal),
        60_000,
        actionsDeliveryDeadlineMs,
        actionsDeliveryPolicy,
      );
      await notifyPackedResultBatch(
        targets,
        index,
        (url, init) => retryActionsInfrastructure(signal => request(url, { ...init, signal })),
        () => client.call({ kind: 'results' }),
      );
      lap('reportMs');
      console.log(`run: phases ${JSON.stringify(phases)}`);
      return exitCode;
    }
    try {
      body = resultEnvelopeBody({ result: selected, ...(encodedLog ? { logBytes: encodedLog } : {}) });
    } catch (error) {
      if (!encodedLog || (error as { code?: string }).code !== 'BAD_ARGUMENT') throw error;
      // A large report page keeps the original window by putting its log in a separate slot.
      body = resultEnvelopeBody({ result: selected });
      await retryActionsInfrastructure(
        signal => uploadResultSlot(targets.slots[index]!.log, encodedLog, request, signal),
        60_000,
        actionsDeliveryDeadlineMs,
        actionsDeliveryPolicy,
      );
    }
    await retryActionsInfrastructure(
      signal => uploadResultSlot(targets.slots[index]!, body, request, signal),
      60_000,
      actionsDeliveryDeadlineMs,
      actionsDeliveryPolicy,
    );
    // One bounded LIST per completed shard, no per-shard Convex call. A create-only coordinator
    // slot elects one caller; the signed workflow completion recovers a lost coordinator.
    const ready = await retryActionsInfrastructure(async signal => {
      const response = await request(targets.list, { signal, redirect: 'error' });
      invariant(response.ok, 'R2_VERIFY_FAILED', 'Read result inbox membership.');
      const text = await readResultSlot(response);
      const keys = [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map(match => decodeURIComponent(match[1]!));
      return targets.slots.every((_, i) => keys.some(key => key.endsWith(`/${i}`)));
    });
    if (ready) {
      const response = await retryActionsInfrastructure(signal =>
        request(targets.coordinator.put.url, {
          method: 'PUT',
          headers: targets.coordinator.put.headers,
          body: 'collect',
          signal,
          redirect: 'error',
        }),
      );
      invariant(response.ok || response.status === 412, 'R2_VERIFY_FAILED', 'Elect the result collector.');
      await response.body?.cancel();
      if (response.ok) await client.call({ kind: 'results' });
    }
    lap('reportMs');
    console.log(`run: phases ${JSON.stringify(phases)}`);
    return exitCode;
  }
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
  try {
    await client.call({ kind: 'result', result, ...(logBytes !== undefined ? { logBytes } : {}) });
  } catch (error) {
    if ((error as { refusal?: unknown })?.refusal !== 'validation') throw error;
    // Forge refused this result as invalid: a deterministic report problem, not a missing runner.
    // Exiting would settle the check runner-unavailable and re-run the same failure (Issue
    // 7a0ccbef). Resend once with only the exit status and log; it fails closed and names why.
    const refused = `Forge refused this shard's test reports as invalid, so the shard fails with its log. Next: read the log; if every test passed, report the refusal.`;
    console.log(refused);
    exitCode ||= 1;
    await client.call({
      kind: 'result',
      result: {
        index,
        exitCode,
        ...(log
          ? { log: { ...log, failureSummary: `${refused}\n${log.failureSummary}`.slice(0, 4096) } }
          : {}),
        execution: result.execution,
      },
      ...(logBytes !== undefined ? { logBytes } : {}),
    });
  }
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
