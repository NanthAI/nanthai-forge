// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupRepos } from '../bench-landing-github.mjs';
import { isMainModule } from '../main-module.mjs';
import { driveForge } from './forge-protocol.mjs';
import { launcherInstallation } from './cli-install.mjs';
import { convexMeter } from './meter.mjs';
import { cliReplies } from './receipts.mjs';
import {
  completedBenchMinutes,
  readBenchJobs,
  sampleOrg,
  stopSustainedActions,
  stopSustainedForge,
  watchSustained,
} from './sustained-capacity.mjs';
import { collectSustained } from './sustained-evidence.mjs';
import { releaseSustained, sustainedPlan } from './sustained-plan.mjs';
import { scoreSustained } from './sustained-score.mjs';
import { readSustainedPins, runCommand, setupSustained } from './sustained-setup.mjs';

const minute = 60_000;
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const saveJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });

async function runArm(config, setup, plan, arm) {
  if (!Number.isFinite(config.priorMinutes) || config.priorMinutes < 0 || config.priorMinutes > 4000)
    throw Error('Enter the runner minutes already used by the approved benchmark');
  const { checkout, repo, projectId } = setup;
  if (repo !== config.repo) throw Error('Scratch setup receipt belongs to another runner repository');
  const scratch = config.scratch;
  const rawTrace = join(scratch, 'trace.ndjson');
  const traceEvent = event => appendFileSync(rawTrace, JSON.stringify(event) + '\n', { mode: 0o600 });
  const installation = launcherInstallation(readFileSync(config.cli, 'utf8'));
  if (!installation) throw Error('Use the dedicated Forge CLI launcher to pin its selected build');
  const entry = realpathSync(join(installation, 'current', 'dist', 'cli-entry.js'));
  const runCli = (args, options) => runCommand(process.execPath, [entry, ...args], options);
  const cliVersion = (await runCli(['--version'])).stdout.trim();
  const pins = await readSustainedPins(config);
  traceEvent({
    event: 'version-pins',
    ...pins,
    cliVersion,
    controlCommit: config.controlCommit,
    repo,
    projectId,
  });
  const activeCalls = new Set();
  const controller = new AbortController();
  const monitor = new AbortController();
  let cancelling;
  let verifiedScratch = false;
  function abort(reason) {
    if (cancelling) return cancelling;
    controller.abort(Error(reason));
    traceEvent({ event: 'abort', reason, atMs: Date.now() });
    cancelling = verifiedScratch
      ? Promise.all([stopSustainedActions(repo, traceEvent), stopForge()])
      : Promise.resolve();
    return cancelling;
  }
  const cli = async (root, action, body, flags = []) => {
    const result = await runCli(['agent', root, action, '--detail', ...flags, JSON.stringify(body)], {
      allowFail: true,
      timeoutMs: 55_000,
    });
    const reply = cliReplies(result.stdout + '\n' + result.stderr).findLast(
      value => value.error || value.result,
    );
    if (!reply) throw Error(`No structured ${action} response`);
    return reply;
  };
  const read = async (action, body) => {
    const reply = await cli(checkout, action, body);
    if (reply.error) throw Error(`${action}: ${reply.error.code}`);
    return reply.result;
  };
  async function stopForge() {
    // The project is a dedicated synthetic scratch. Read its queue after all launched
    // client calls settle, including calls that did not return a submission ID.
    await Promise.allSettled([...activeCalls]);
    await stopSustainedForge({
      read,
      emit: traceEvent,
      cancel: (submissionId, operationId) =>
        runCli(['x', checkout, 'cancel', JSON.stringify({ submissionId, operationId })], {
          allowFail: true,
          timeoutMs: 12_000,
        }),
    });
  }
  const readLog = async runId =>
    (await runCli(['agent', checkout, 'log', JSON.stringify({ runId, tail: 65_536 })])).stdout;
  const checkCapacity = async () => {
    for (;;) {
      controller.signal.throwIfAborted();
      const org = await sampleOrg();
      traceEvent({ event: 'org-runner-window', ...org });
      if (org.activeJobs <= 20) return;
      await delay(30_000, undefined, { signal: controller.signal });
    }
  };
  const prepare = async task => {
    const result = await read('start', {
      operationId: randomUUID(),
      outcome: 'Sustained benchmark ' + task.id,
      model: 'unknown',
    });
    for (const edit of task.edits) {
      const path = join(result.path, edit.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, edit.text);
    }
    return { root: result.path, laneId: result.lane.laneId };
  };
  const submit = async (task, lane, signal) => {
    const ids = new Set();
    let failed = false;
    try {
      const landed = await driveForge({
        ...lane,
        message: 'Sustained benchmark ' + task.id,
        call: async command => {
          signal.throwIfAborted();
          const { root, action, body, flags = [] } = command;
          if (action === 'wait' && !flags.includes('--budget')) flags.push('--budget', '40');
          if (!['wait', 'observe', 'status', 'queue'].includes(action)) body.operationId ??= randomUUID();
          const atMs = Date.now();
          let reply;
          for (let retry = 0; ; retry++) {
            try {
              const pending = cli(root, action, body, flags);
              activeCalls.add(pending);
              try {
                reply = await pending;
              } finally {
                activeCalls.delete(pending);
              }
              break;
            } catch (error) {
              signal.throwIfAborted();
              if (retry) throw error;
            }
          }
          const rows = [
            reply.result?.submission,
            ...(reply.result?.submissions ?? []).map(row => row.submission),
          ];
          for (const row of rows.filter(Boolean)) {
            if (row.id) ids.add(row.id);
            failed ||= (row.observation?.state ?? row.phase) === 'terminal-failed';
          }
          failed ||= reply.error?.code === 'CHECK_FAILED';
          traceEvent({ event: 'forge', taskId: task.id, action, operationId: body.operationId, atMs, reply });
          return reply;
        },
      });
      return {
        outcome: 'accepted',
        laneId: lane.laneId,
        submissionIds: [...ids],
        acceptance: landed.submission.acceptance,
      };
    } catch (error) {
      return {
        outcome: failed ? 'terminal-failed' : 'error',
        laneId: lane.laneId,
        submissionIds: [...ids],
        ...(failed ? {} : { error: String(error.message ?? error) }),
      };
    }
  };
  await checkCapacity();
  const metering = convexMeter({
    deployment: new URL(config.deployment).hostname.split('.')[0],
    projectId,
    name: repo.split('/')[1],
    cwd: process.cwd(),
  });
  let monitoring;
  const interrupted = () => {
    void abort('Bench driver interrupted').catch(() => {});
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    await metering.ready(() => read('policy', {}));
    const ready = Promise.withResolvers();
    monitoring = watchSustained({
      repo,
      priorMinutes: config.priorMinutes,
      runnerHead: pins.runnerHead,
      signal: monitor.signal,
      abort,
      emit: traceEvent,
      ready: ready.resolve,
    });
    await Promise.race([ready.promise, monitoring]);
    controller.signal.throwIfAborted();
    const settings = await read('check-settings', {});
    const policy = await read('policy', {});
    if (
      settings.actions?.mode !== 'app-direct' ||
      settings.actions.repository !== repo ||
      !settings.definitions.some(definition => definition.name === 'sustained') ||
      JSON.stringify(settings.definitions) !== JSON.stringify(setup.settings.definitions) ||
      JSON.stringify(policy.acceptance) !== JSON.stringify(setup.policy.acceptance)
    )
      throw Error('Scratch check, runner or acceptance policy moved after setup');
    verifiedScratch = true;
    traceEvent({ event: 'policy-pin', acceptance: policy.acceptance, actions: settings.actions });
    let baseHead = settings.mainAudit?.head;
    if (!settings.mainAudit?.lastGreen || settings.mainAudit.lastGreen.head !== settings.mainAudit.head) {
      const warmup = { id: 'warmup', edits: [{ path: 'bench-ci/warmup.txt', text: 'green\n' }] };
      const baseline = await submit(warmup, await prepare(warmup), controller.signal);
      const ready = await read('check-settings', {});
      traceEvent({ event: 'base-qualified', baseline, mainAudit: ready.mainAudit });
      if (
        baseline.outcome !== 'accepted' ||
        !ready.mainAudit?.lastGreen ||
        ready.mainAudit.lastGreen.head !== ready.mainAudit.head ||
        ready.mainAudit.landing.effective !== setup.policy.acceptance.landingMode
      )
        throw Error('Bench main did not reach the pinned green policy');
      baseHead = ready.mainAudit.head;
    }
    const release = await releaseSustained(
      plan,
      { prepare, submit },
      {
        signal: controller.signal,
        emit: traceEvent,
        beforeRelease: checkCapacity,
      },
    );
    release.baseHead = baseHead;
    // The queue can finish its submissions before an already-dispatched audit settles.
    const drainDeadline = Date.now() + 60 * minute;
    let runs = await readBenchJobs(repo);
    while (!controller.signal.aborted && runs.some(run => run.status !== 'completed')) {
      if (Date.now() >= drainDeadline) {
        await abort('Bench provider drain exceeded an hour');
        break;
      }
      await delay(30_000);
      runs = await readBenchJobs(repo);
    }
    if (cancelling) {
      await cancelling;
      runs = await readBenchJobs(repo);
    }
    const observedThroughMs = Date.now();
    const trace = await collectSustained({
      config,
      setup,
      plan,
      release,
      observedThroughMs,
      arm,
      traceEvent,
      read,
      readLog,
    });
    trace.aborted = controller.signal.aborted;
    trace.drained = runs.every(run => run.status === 'completed');
    trace.totalRunnerMinutes = completedBenchMinutes(runs, observedThroughMs);
    try {
      trace.pinsStable =
        JSON.stringify(pins) === JSON.stringify(await readSustainedPins(config)) &&
        runs.every(run => run.head === pins.runnerHead);
    } catch (error) {
      trace.pinsStable = false;
      traceEvent({ event: 'pins-unverified', reason: error.message });
    }
    const score = scoreSustained(plan, trace);
    saveJson(join(scratch, 'observations.json'), trace);
    saveJson(join(scratch, 'score.json'), score);
    console.log(
      JSON.stringify({
        score: join(scratch, 'score.json'),
        rawTrace,
        runnerMinutes: trace.totalRunnerMinutes,
      }),
    );
  } catch (error) {
    await abort(error.message);
    throw error;
  } finally {
    monitor.abort();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    try {
      if (cancelling) await cancelling;
      await monitoring;
    } finally {
      saveJson(join(scratch, 'meter.json'), metering.stop());
    }
  }
}

if (isMainModule(import.meta.url)) {
  const [action, file] = process.argv.slice(2);
  if (!file || !['setup', 'run', 'score', 'cleanup'].includes(action))
    throw Error('Usage: sustained-run.mjs setup|run|score|cleanup CONFIG.json');
  const config = readJson(file);
  config.scratch = resolve(config.scratch ?? dirname(file));
  const plan = sustainedPlan({ smoke: config.smoke === true });
  const { arm } = config;
  if (action === 'cleanup') await cleanupRepos(runCommand, config.manifest);
  if (action === 'setup') {
    mkdirSync(config.scratch, { recursive: true, mode: 0o700 });
    const setup = await setupSustained({ config, root: join(config.scratch, 'seed'), plan, arm });
    saveJson(join(config.scratch, 'setup.json'), setup);
  }
  if (action === 'run') await runArm(config, readJson(join(config.scratch, 'setup.json')), plan, arm);
  if (action === 'score') {
    const trace = readJson(join(config.scratch, 'observations.json'));
    saveJson(join(config.scratch, 'score.json'), scoreSustained(plan, trace));
  }
}
