// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { ForgeError } from './errors.js';
import { stopProcessTree } from './local-process.js';
import { durableReplace } from './native-durability.js';
import { cliBuildCommit } from './cli-installation.js';
import { landedOperations } from './landed-operations.js';
import { deliverStallAlert, STALL_ALERT_ENV } from './stall-alerts.js';

/** Total limit for the new build's steps in one canary run. The canary runs only in the detached
 * background updater, so no command waits on it (2a0557b6); the limits only bound how long it holds
 * the update lock. */
export const CLI_CANARY_TIMEOUT_MS = 60_000;
/** Each step's own cap inside that limit; the current build's comparison run and the one retry get
 * the same cap of their own. */
export const CLI_CANARY_STEP_MS = 20_000;
/** A step the new build passes only on its retry still refuses when it is clearly slower than the
 * current build timed in the same run: more than 3x, and more than this margin, slower. */
export const CLI_CANARY_SLOW_MARGIN_MS = 5_000;
export const cliCanaryClearlySlower = (retryMs: number, currentMs: number) =>
  retryMs > Math.max(3 * currentMs, currentMs + CLI_CANARY_SLOW_MARGIN_MS);
/** After a refusal the same build is retried no sooner than this, doubling per attempt. */
export const CLI_CANARY_BACKOFF_MS = 10 * 60_000;
export const CLI_CANARY_BACKOFF_MAX_MS = 6 * 60 * 60_000;
/** Version skew right after main moves is usually the server deploy of the same State still
 * running (Issue 3205f7e6): retry this soon, without an alert, for at most the window below. */
export const CLI_CANARY_DEPLOY_RETRY_MS = 60_000;
export const CLI_CANARY_DEPLOY_WINDOW_MS = 15 * 60_000;
/** Codes a CLI returns when it and the server it talks to are different versions. */
const SKEW_CODES = new Set(['HOSTED_PROTOCOL_INVALID', 'HOSTED_ACTION_UNSUPPORTED', 'CLI_UPGRADE_REQUIRED']);
const OUTPUT_CAP = 4 * 1024 * 1024;
/** Environment names the canary children inherit; same set the detached updater already gets. */
const CHILD_ENV = [
  'FORGE_AUTH_TOKEN',
  'FORGE_DEPLOYMENT_URL',
  'FORGE_DEPLOYMENT',
  'FORGE_AGENT_NAME',
  'FORGE_ACTOR',
  'FORGE_PROJECT_ID',
  'FORGE_CLIENT_SETTINGS',
  'FORGE_TEST_MODE',
];
const refusalPath = (installation: string) => join(installation, 'canary-refused.json');
const clonePath = (installation: string) => join(installation, 'canary-clone.json');

export type CanaryStep = {
  name: string;
  ms: number;
  /** Passed on its one retry after a slow first run; the current build's time on the same step. */
  retry?: { currentMs: number };
};
export type CanaryRefusal = {
  head: string;
  at: string;
  step: string;
  reason: string;
  attempts: number;
  /** Epoch ms; a hold ignores it and lasts until main moves to another head. */
  nextRetryAt: number;
  hold?: boolean;
  /** Epoch ms of this head's first version-skew failure: inside the deploy window it is retried
   * every minute without an alert (the server deploy is probably not live yet). */
  deployPendingSince?: number;
  /** This record is such a deploy-window hold, not a refusal. */
  deployPending?: boolean;
  /** A release-signature hold: signatures are required and this State has none yet. */
  signaturePending?: boolean;
  alerted?: boolean;
};
type CloneRecord = { root: string; operationId?: string; operationKind?: 'landing' };
/** The canary step name of a hold for a server that is behind the build (not a broken build). */
export const SERVER_BEHIND_STEP = 'server-capabilities';
/** The step name of a release that failed its signature check (src/cli-release-check.ts). */
export const RELEASE_SIGNATURE_STEP = 'release-signature';

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
/** A hosted checkout root (the files the canary's reads need). */
const isForgeClone = (root: string) => existsSync(join(root, '.forge', 'hosted-main.json'));
const readClone = (installation: string) => readJson<CloneRecord>(clonePath(installation));

/** Remember a Forge clone for the canary's reads. Only update paths call this, never a normal
 * call; an existing usable clone is kept. */
export function rememberCanaryClone(installation: string, root: string | undefined) {
  try {
    if (!root || !isForgeClone(resolve(root))) return;
    const known = readClone(installation);
    if (known && isForgeClone(known.root)) return;
    durableReplace(clonePath(installation), JSON.stringify({ root: resolve(root) } satisfies CloneRecord));
  } catch {
    /* advisory */
  }
}
/** The clone a command names, when it is a hosted checkout: `agent|x|status ROOT ...`. */
export const canaryCloneHint = (args: string[]) =>
  ['agent', 'x', 'status', 'pull'].includes(args[0] ?? '') ? args[1] : undefined;

class CanaryFailure extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly detail = '',
    /** The wait found its operation still running: says nothing about the build (edcb0fc8). */
    readonly inProgress = false,
    /** The step ran out of time: slow, maybe only because the host is busy (2a0557b6). */
    readonly timedOut = false,
  ) {
    super(message);
  }
}
type Run = { code: number | null; stdout: string; stderr: string };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One child of the new build, killed (with its process group) when the shared deadline passes. */
function runChild(
  entry: string,
  args: string[],
  env: Record<string, string>,
  deadline: number,
  step: string,
) {
  return new Promise<Run>((done, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new CanaryFailure(step, `canary step ${step} had no time left`));
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env,
    });
    let stdout = '',
      stderr = '',
      settled = false;
    const stop = (failure?: CanaryFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopProcessTree(child);
      if (failure) reject(failure);
    };
    const timer = setTimeout(
      () =>
        stop(
          new CanaryFailure(
            step,
            `canary step ${step} timed out after ${seconds(remaining)}`,
            '',
            false,
            true,
          ),
        ),
      remaining,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > OUTPUT_CAP)
        stop(new CanaryFailure(step, `canary step ${step} printed too much output`));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2048);
    });
    child.once('error', error =>
      stop(new CanaryFailure(step, `canary step ${step} could not start`, String(error))),
    );
    child.once('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}
/** The last JSON document on stdout (a wait prints a status line before it). */
type Doc = {
  error?: unknown;
  serverContract?: { missing?: unknown };
  clone?: unknown;
  cliCommit?: unknown;
  result?: { items?: { id?: unknown; at?: unknown; kind?: unknown }[]; item?: { operationId?: unknown } };
};
function lastJson(step: string, stdout: string): Doc {
  const lines = stdout.split('\n').filter(line => line.trim());
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {
      break;
    }
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new CanaryFailure(step, `canary step ${step} printed bad JSON`);
  }
}
const ok = (step: string, run: Run) => {
  if (run.code !== 0)
    throw new CanaryFailure(step, `canary step ${step} exited ${run.code}`, run.stderr.slice(-300));
  return run;
};

export type CanaryInput = {
  installation: string;
  build: string;
  head: string;
  timeoutMs?: number;
  /** Per-step cap; defaults to CLI_CANARY_STEP_MS, never above timeoutMs. */
  stepMs?: number;
  /** Test seam: replaces the real home for private state. */
  home?: string;
};
export type CanaryResult = {
  steps: CanaryStep[];
  skipped: string[];
  operationId?: string;
  /** Steps that failed on the new build and on the current one alike (not a regression). */
  compared?: { step: string; build: string; current: string }[];
};
/** Wait outcomes that say nothing about the build: the operation is gone, belongs to another
 * request on this machine, or expired (edcb0fc8). The operation is skipped, never a refusal. */
const UNUSABLE_OPERATION = new Set(['NOT_FOUND', 'WORK_OPERATION_CHANGED', 'OPERATION_EXPIRED']);
/** Only a structured error code ever leaves a child: never its output. */
const failureCode = (failure: CanaryFailure) =>
  /"code"\s*:\s*"([A-Z][A-Z0-9_]{1,63})"/.exec(failure.detail)?.[1];
const describe = (failure: CanaryFailure) => {
  const code = failureCode(failure);
  return `${failure.message}${code ? ` (${code})` : ''}`;
};
const cloneProject = (root: string) =>
  readJson<{ selection?: { projectId?: unknown } }>(join(root, '.forge', 'hosted-main.json'))?.selection
    ?.projectId;

/** Run the NEW (installed, not active) build against the real project for reads only.
 * The child runs with a private HOME, so the real agent hook files are unreachable by
 * construction; credentials and caches come from the real XDG directories. A failing step is run
 * again on the current build (differential, edcb0fc8): only a step the current build passes
 * refuses the new one; a step both fail is logged with both results and skipped. A step that only
 * timed out on the new build while the current build passes it gets one retry per run (2a0557b6):
 * a busy host slows both builds alike, so only a retry that fails, times out again or is clearly
 * slower than the current build's timed run refuses. */
export async function runCliCanary(input: CanaryInput): Promise<CanaryResult> {
  const { installation, build, head } = input;
  const entry = join(build, 'dist', 'cli-entry.js');
  const timeoutMs = input.timeoutMs ?? CLI_CANARY_TIMEOUT_MS;
  const stepMs = Math.min(input.stepMs ?? CLI_CANARY_STEP_MS, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const realHome = input.home ?? homedir();
  const privateHome = mkdtempSync(join(tmpdir(), 'forge-canary-'));
  const xdg = (name: string, fallback: string[]) => process.env[name] || join(realHome, ...fallback);
  const stateHome = xdg('XDG_STATE_HOME', ['.local', 'state']);
  const environment = (pinned: string) =>
    childEnv({
      allow: CHILD_ENV,
      extra: {
        HOME: privateHome,
        USERPROFILE: privateHome,
        XDG_CONFIG_HOME: xdg('XDG_CONFIG_HOME', ['.config']),
        XDG_CACHE_HOME: xdg('XDG_CACHE_HOME', ['.cache']),
        XDG_STATE_HOME: stateHome,
        // Honored only by the build with that exact commit: no freshness read, no update.
        FORGE_CLI_CANARY: pinned,
      },
    }) as Record<string, string>;
  const env = environment(head);
  const current = join(installation, 'current');
  const currentEntry = join(current, 'dist', 'cli-entry.js');
  const currentHead = existsSync(currentEntry) ? cliBuildCommit(current) : undefined;
  // Every step has its own cap inside the total, so one slow step never uses up the whole canary.
  const stepDeadline = (limit = Infinity) => Math.min(limit, Date.now() + stepMs);
  let retried = false;
  const waitJson = (run: Run, expected: string) => {
    if (run.code === 3 && /"status"\s*:\s*"IN_PROGRESS"/.test(run.stdout))
      throw new CanaryFailure('wait', 'canary step wait found the operation still running', '', true);
    return agentJson('wait')(run, expected);
  };
  const steps: CanaryStep[] = [],
    skipped: string[] = [],
    compared: NonNullable<CanaryResult['compared']> = [];
  type Check<T> = (run: Run, expected: string) => T;
  /** Outcomes that say nothing about the build and go to the caller unchanged. */
  const passThrough = (name: string, error: CanaryFailure) =>
    error.step === SERVER_BEHIND_STEP ||
    (name === 'wait' && (error.inProgress || UNUSABLE_OPERATION.has(failureCode(error) ?? '')));
  /** One step on the new build; on a failure, the same step on the current build (only then). */
  const step = async <T>(name: string, args: string[], check: Check<T>): Promise<T | undefined> => {
    const started = Date.now();
    try {
      const value = check(await runChild(entry, args, env, stepDeadline(deadline), name), head);
      steps.push({ name, ms: Date.now() - started });
      return value;
    } catch (error) {
      if (!(error instanceof CanaryFailure) || passThrough(name, error)) throw error;
      if (!currentHead || currentHead === head) throw error;
      let baseline: CanaryFailure | undefined;
      const baselineStarted = Date.now();
      try {
        check(
          await runChild(currentEntry, args, environment(currentHead), stepDeadline(), name),
          currentHead,
        );
      } catch (other) {
        if (!(other instanceof CanaryFailure)) throw error;
        baseline = other;
      }
      const currentMs = Date.now() - baselineStarted;
      const label = `current build ${currentHead.slice(0, 8)}`;
      // Slow, not failed, while the current build passes: a busy host, or a slower build. One retry
      // per run, judged against the current build's time from this same run.
      if (!baseline && error.timedOut && !retried) {
        retried = true;
        const again = Date.now();
        let value: T;
        try {
          value = check(await runChild(entry, args, env, stepDeadline(), name), head);
        } catch (retry) {
          if (!(retry instanceof CanaryFailure) || passThrough(name, retry)) throw retry;
          throw new CanaryFailure(
            retry.step,
            `${error.message}, then on its retry ${retry.message.replace(/^canary step \S+ /, '')}; the ${label} passes the same step in ${seconds(currentMs)}`,
            retry.detail,
          );
        }
        const ms = Date.now() - again;
        if (cliCanaryClearlySlower(ms, currentMs))
          throw new CanaryFailure(
            name,
            `canary step ${name} timed out, then took ${seconds(ms)} on its retry; the ${label} passes the same step in ${seconds(currentMs)} (clearly slower)`,
          );
        steps.push({ name, ms, retry: { currentMs } });
        return value;
      }
      if (!baseline)
        throw new CanaryFailure(
          error.step,
          `${error.message}; the ${label} passes the same step`,
          error.detail,
        );
      compared.push({ step: name, build: describe(error), current: describe(baseline) });
      skipped.push(
        `step ${name} fails on both builds, not a regression (new: ${describe(error)}; ${label}: ${describe(baseline)})`,
      );
      return undefined;
    }
  };
  const agentJson = (name: string) => (run: Run, expected: string) => {
    ok(name, run);
    const json = lastJson(name, run.stdout);
    if (!json || typeof json !== 'object' || json.error)
      throw new CanaryFailure(name, `canary step ${name} returned an error document`);
    if (json.cliCommit !== undefined && json.cliCommit !== expected)
      throw new CanaryFailure(name, `canary step ${name} ran a different build than ${expected.slice(0, 8)}`);
    // The new build names server contract features it cannot do without (a83b6fd5): hold the switch
    // until the server it talks to advertises them, typically until its Convex deploy finishes.
    const missing = json.serverContract?.missing;
    if (expected === head && Array.isArray(missing) && missing.length)
      throw new CanaryFailure(
        SERVER_BEHIND_STEP,
        `the server does not yet advertise ${missing
          .slice(0, 5)
          .map(feature => String(feature).slice(0, 80))
          .join(', ')} that this build needs (its deploy has not reached this server)`,
      );
    return json;
  };
  let operationId: string | undefined;
  try {
    await step('version', ['--version'], run => {
      ok('version', run);
      if (!run.stdout.trim()) throw new CanaryFailure('version', 'canary step version printed nothing');
    });
    const clone = readClone(installation);
    if (!clone || !isForgeClone(clone.root)) skipped.push('no Forge clone recorded for the reads');
    else {
      const root = clone.root;
      await step('status', ['status', root, '--json'], run => {
        ok('status', run);
        const json = lastJson('status', run.stdout);
        if (!json || typeof json !== 'object' || json.error || !json.clone)
          throw new CanaryFailure('status', 'canary step status returned an unusable document');
      });
      await step(
        'planning',
        ['agent', root, 'planning', JSON.stringify({ limit: 50, reconcile: false })],
        (run, expected) => {
          const listing = agentJson('planning')(run, expected);
          if (!Array.isArray(listing.result?.items))
            throw new CanaryFailure('planning', 'canary step planning returned no item list');
        },
      );
      // The wait reads only landing operations: the vetted one, then the ones this machine saw land
      // (edcb0fc8). A planning put's operation id is never waitable and never used.
      const project = cloneProject(root);
      const candidates = [
        ...new Set([
          ...(clone.operationId && clone.operationKind === 'landing' ? [clone.operationId] : []),
          ...(typeof project === 'string' ? landedOperations(project, stateHome) : []),
        ]),
      ].slice(0, 2);
      let known: string | undefined;
      for (const id of candidates) {
        try {
          await step(
            'wait',
            ['agent', root, 'wait', JSON.stringify({ operationIds: [id], timeoutSeconds: 0 })],
            waitJson,
          );
          known = id;
          break;
        } catch (error) {
          if (
            !(error instanceof CanaryFailure) ||
            !(error.inProgress || UNUSABLE_OPERATION.has(failureCode(error) ?? ''))
          )
            throw error;
          skipped.push(
            `wait on operation ${id.slice(0, 8)} skipped: ${error.inProgress ? 'still running' : failureCode(error)}`,
          );
        }
      }
      if (!known && !candidates.length)
        skipped.push('no landed operation recorded on this machine for the wait');
      if (known !== clone.operationId || (known && clone.operationKind !== 'landing'))
        durableReplace(
          clonePath(installation),
          JSON.stringify({
            root,
            ...(known ? { operationId: known, operationKind: 'landing' as const } : {}),
          } satisfies CloneRecord),
        );
      operationId = known;
    }
  } finally {
    rmSync(privateHome, { recursive: true, force: true });
  }
  return {
    steps,
    skipped,
    ...(operationId ? { operationId } : {}),
    ...(compared.length ? { compared } : {}),
  };
}

export const cliCanaryBackoffMs = (attempts: number) =>
  Math.min(CLI_CANARY_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), CLI_CANARY_BACKOFF_MAX_MS);
export const readCliCanaryRefusal = (installation: string) =>
  readJson<CanaryRefusal>(refusalPath(installation));
export function writeCliCanaryRefusal(installation: string, record: CanaryRefusal) {
  durableReplace(refusalPath(installation), JSON.stringify(record));
}
export const clearCliCanaryRefusal = (installation: string, head?: string) => {
  const record = readCliCanaryRefusal(installation);
  if (!head || record?.head === head) {
    rmSync(refusalPath(installation), { force: true });
    clearNoticeMarks(installation);
  }
};
/** One marker per refused head records that its full notice was shown (2a0557b6). */
const NOTICE_MARK = 'canary-noticed-';
function clearNoticeMarks(installation: string, keep?: string) {
  try {
    for (const name of readdirSync(installation))
      if (name.startsWith(NOTICE_MARK) && name !== keep) rmSync(join(installation, name), { force: true });
  } catch {
    /* advisory */
  }
}
/** True for exactly one caller per head on this installation, even when many start together: the
 * marker is created exclusively. Any other outcome (already shown, unwritable) is not first. */
function claimFullNotice(installation: string, head: string) {
  const name = `${NOTICE_MARK}${head.slice(0, 16)}`;
  try {
    writeFileSync(join(installation, name), '', { flag: 'wx', mode: 0o600 });
  } catch {
    return false;
  }
  clearNoticeMarks(installation, name);
  return true;
}
/** A refusal that still keeps main's head off this machine: inside its back-off, or held until
 * main moves (explicit rollback). Another head, or an elapsed back-off, never matches. */
export function activeCliCanaryRefusal(installation: string, released: string, now = Date.now()) {
  const record = readCliCanaryRefusal(installation);
  return record && record.head === released && (record.hold || now < record.nextRetryAt) ? record : null;
}
const clock = (at: number) => new Date(at).toISOString().slice(11, 16) + ' UTC';
/** While a refusal is active: the full notice once per head on this installation (the first
 * command to claim it), then a short one-line hint. The full reason stays in canary-refused.json
 * and the updater's update.log (2a0557b6: 10 commands of one script printed it 10 times). */
export function cliCanaryNotice(installation: string, record: CanaryRefusal, runningOn: string) {
  const verdict = record.hold
    ? 'rolled back'
    : record.step === RELEASE_SIGNATURE_STEP
      ? record.signaturePending
        ? 'held until its release signature is published'
        : 'refused by its release signature check'
      : record.step === SERVER_BEHIND_STEP || record.deployPending
        ? 'held by its pre-switch canary'
        : 'refused by its pre-switch canary';
  const head = `Forge CLI main ${record.head.slice(0, 8)} was ${verdict}`;
  if (!claimFullNotice(installation, record.head)) return `${head}; running on ${runningOn.slice(0, 8)}.`;
  const retry = record.hold
    ? 'held until main moves (explicit rollback)'
    : `next retry after ${clock(record.nextRetryAt)}`;
  return (
    `${head} (${record.reason}); running on ${runningOn.slice(0, 8)}, ${retry}.` +
    ` Details: ${join(installation, 'canary-refused.json')} and update.log; later commands print one short line.` +
    ' Switch builds by hand: nforge cli rollback | nforge update.'
  );
}

type Send = Parameters<typeof deliverStallAlert>[3];
function alertWebhook(env: Record<string, string | undefined>, home: string) {
  const direct = env[STALL_ALERT_ENV.webhookUrl];
  if (direct) return direct;
  const file = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'forge', 'alert-webhook-url');
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
/** The existing stall-alert transport. The text names the step and exit class only: no URLs,
 * tokens, paths or child output. Failures to deliver are silent (the CLI notice remains). */
export async function alertCliCanary(
  record: CanaryRefusal,
  options: { env?: Record<string, string | undefined>; send?: Send; home?: string } = {},
) {
  const env = options.env ?? process.env;
  const url = alertWebhook(env, options.home ?? homedir());
  if (!url) return false;
  const results = await deliverStallAlert(
    {
      subject: `[Forge] CLI canary refused build ${record.head.slice(0, 8)}`,
      text: [
        `The auto-updater refused Forge CLI build ${record.head.slice(0, 8)}: ${record.reason}.`,
        'The previous build keeps serving every agent. The next retry follows a back-off or a new main.',
        'Check DIR/canary-refused.json and DIR/update.log on the machine; nforge cli rollback switches builds.',
      ].join('\n'),
    },
    { enabled: true, notifyAfterMinutes: 0, repeatAfterMinutes: 1, webhook: 'ntfy', email: [] },
    { [STALL_ALERT_ENV.webhookUrl]: url },
    options.send,
  );
  return results.some(result => typeof result.status === 'number' && result.status < 300);
}

export type CanaryHooks = {
  run?: typeof runCliCanary;
  alert?: (record: CanaryRefusal) => Promise<unknown>;
  now?: () => number;
  log?: (line: string) => void;
  timeoutMs?: number;
  stepMs?: number;
  home?: string;
};
/** The updater's `preSwitch`: throws CLI_CANARY_FAILED (after recording and alerting once) so the
 * previous build stays selected. Never writes hooks, never writes hosted state. */
export const cliCanaryPreSwitch =
  (installation: string, hooks: CanaryHooks = {}) =>
  async (build: string, head: string) => {
    const now = hooks.now ?? Date.now;
    const log = hooks.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
    const started = now();
    try {
      const result = await (hooks.run ?? runCliCanary)({
        installation,
        build,
        head,
        ...(hooks.timeoutMs ? { timeoutMs: hooks.timeoutMs } : {}),
        ...(hooks.stepMs ? { stepMs: hooks.stepMs } : {}),
        ...(hooks.home ? { home: hooks.home } : {}),
      });
      clearCliCanaryRefusal(installation);
      log(
        `Forge CLI canary passed for ${head.slice(0, 8)} in ${((now() - started) / 1000).toFixed(1)}s: ` +
          result.steps
            .map(
              step =>
                `${step.name} ${step.ms}ms` +
                (step.retry
                  ? ` (on its one retry after a slow first run; current build ${step.retry.currentMs}ms)`
                  : ''),
            )
            .join(', ') +
          (result.skipped.length ? `; skipped: ${result.skipped.join('; ')}` : '') +
          '.',
      );
    } catch (error) {
      const failure = error instanceof CanaryFailure ? error : null;
      const previous = readCliCanaryRefusal(installation);
      const same = previous?.head === head ? previous : null;
      // A step the current build passes fails on the new one with a version-skew code: the
      // server has probably not deployed this State yet. Retry every minute, no alert, for a
      // bounded window; only a skew that outlasts the window is a refusal.
      const skew =
        !!failure && failure.step !== SERVER_BEHIND_STEP && SKEW_CODES.has(failureCode(failure) ?? '');
      const pendingSince = skew ? (same?.deployPendingSince ?? now()) : undefined;
      const pending = pendingSince !== undefined && now() - pendingSince < CLI_CANARY_DEPLOY_WINDOW_MS;
      const attempts = pending ? (same?.attempts ?? 0) : (same?.attempts ?? 0) + 1;
      const record: CanaryRefusal = {
        head,
        at: new Date(now()).toISOString(),
        step: failure?.step ?? 'canary',
        reason: failure?.message ?? 'canary failed unexpectedly',
        attempts,
        nextRetryAt: now() + (pending ? CLI_CANARY_DEPLOY_RETRY_MS : cliCanaryBackoffMs(attempts)),
        ...(pendingSince !== undefined ? { deployPendingSince: pendingSince } : {}),
        ...(pending ? { deployPending: true } : {}),
        ...(same?.alerted ? { alerted: true } : {}),
      };
      writeCliCanaryRefusal(installation, record);
      const behind = record.step === SERVER_BEHIND_STEP;
      log(
        pending
          ? `Forge CLI canary held ${head.slice(0, 8)}: ${record.reason}; the server deploy of this State is probably not live yet, the previous build stays selected, next retry after ${clock(record.nextRetryAt)} (deploy window ends ${clock(pendingSince! + CLI_CANARY_DEPLOY_WINDOW_MS)}).`
          : behind
            ? `Forge CLI canary held ${head.slice(0, 8)}: ${record.reason}; the previous build stays selected, next retry after ${clock(record.nextRetryAt)} (attempt ${attempts}).`
            : `Forge CLI canary refused ${head.slice(0, 8)}: ${record.reason}; the previous build stays selected.`,
      );
      // A server that is behind is the normal deploy order, not a broken build: no alert.
      if (!record.alerted && !behind && !pending) {
        // Alert once per head, before the throw, and only ever once even if delivery failed.
        writeCliCanaryRefusal(installation, { ...record, alerted: true });
        await Promise.race([
          (hooks.alert ?? (alertCliCanary as (record: CanaryRefusal) => Promise<unknown>))(record).catch(
            () => undefined,
          ),
          new Promise(done => setTimeout(done, 5_000).unref()),
        ]);
      }
      throw new ForgeError(
        'CLI_CANARY_FAILED',
        `Pre-switch canary refused build ${head.slice(0, 8)}: ${record.reason}.`,
      );
    }
  };
