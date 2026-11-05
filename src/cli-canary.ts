// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { ForgeError } from './errors.js';
import { durableReplace } from './native-durability.js';
import { cliBuildCommit } from './cli-installation.js';
import { landedOperations } from './landed-operations.js';
import { deliverStallAlert, STALL_ALERT_ENV } from './stall-alerts.js';

/** Hard total limit for one canary run (all steps together). */
export const CLI_CANARY_TIMEOUT_MS = 20_000;
/** The wait step's own cap inside that limit (it is a non-blocking read). */
export const CLI_CANARY_WAIT_STEP_MS = 10_000;
/** After a refusal the same build is retried no sooner than this, doubling per attempt. */
export const CLI_CANARY_BACKOFF_MS = 10 * 60_000;
export const CLI_CANARY_BACKOFF_MAX_MS = 6 * 60 * 60_000;
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

export type CanaryStep = { name: string; ms: number };
export type CanaryRefusal = {
  head: string;
  at: string;
  step: string;
  reason: string;
  attempts: number;
  /** Epoch ms; a hold ignores it and lasts until main moves to another head. */
  nextRetryAt: number;
  hold?: boolean;
  alerted?: boolean;
  noticed?: boolean;
};
type CloneRecord = { root: string; operationId?: string; operationKind?: 'landing' };
/** The canary step name of a hold for a server that is behind the build (not a broken build). */
export const SERVER_BEHIND_STEP = 'server-capabilities';

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
  ) {
    super(message);
  }
}
type Run = { code: number | null; stdout: string; stderr: string };

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
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      if (failure) reject(failure);
    };
    const timer = setTimeout(
      () =>
        stop(
          new CanaryFailure(
            step,
            `canary step ${step} timed out (limit ${CLI_CANARY_TIMEOUT_MS / 1000}s in total)`,
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
 * refuses the new one; a step both fail is logged with both results and skipped. */
export async function runCliCanary(input: CanaryInput): Promise<CanaryResult> {
  const { installation, build, head } = input;
  const entry = join(build, 'dist', 'cli-entry.js');
  const timeoutMs = input.timeoutMs ?? CLI_CANARY_TIMEOUT_MS;
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
  let baselineDeadline: number | undefined;
  // The wait is one non-blocking status read (timeoutSeconds 0) with its own short cap, so a slow
  // or still-running operation can never use up the whole canary.
  const stepDeadline = (name: string, limit: number) =>
    name === 'wait' ? Math.min(limit, Date.now() + CLI_CANARY_WAIT_STEP_MS) : limit;
  const waitJson = (run: Run, expected: string) => {
    if (run.code === 3 && /"status"\s*:\s*"IN_PROGRESS"/.test(run.stdout))
      throw new CanaryFailure('wait', 'canary step wait found the operation still running', '', true);
    return agentJson('wait')(run, expected);
  };
  const steps: CanaryStep[] = [],
    skipped: string[] = [],
    compared: NonNullable<CanaryResult['compared']> = [];
  type Check<T> = (run: Run, expected: string) => T;
  /** One step on the new build; on a failure, the same step on the current build (only then). */
  const step = async <T>(name: string, args: string[], check: Check<T>): Promise<T | undefined> => {
    const started = Date.now();
    try {
      const value = check(await runChild(entry, args, env, stepDeadline(name, deadline), name), head);
      steps.push({ name, ms: Date.now() - started });
      return value;
    } catch (error) {
      if (!(error instanceof CanaryFailure) || error.step === SERVER_BEHIND_STEP) throw error;
      if (name === 'wait' && (error.inProgress || UNUSABLE_OPERATION.has(failureCode(error) ?? '')))
        throw error;
      if (!currentHead || currentHead === head) throw error;
      baselineDeadline ??= Date.now() + timeoutMs;
      let baseline: CanaryFailure | undefined;
      try {
        check(
          await runChild(
            currentEntry,
            args,
            environment(currentHead),
            stepDeadline(name, baselineDeadline),
            name,
          ),
          currentHead,
        );
      } catch (other) {
        if (!(other instanceof CanaryFailure)) throw error;
        baseline = other;
      }
      const label = `current build ${currentHead.slice(0, 8)}`;
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
  if (!head || record?.head === head) rmSync(refusalPath(installation), { force: true });
};
/** A refusal that still keeps main's head off this machine: inside its back-off, or held until
 * main moves (explicit rollback). Another head, or an elapsed back-off, never matches. */
export function activeCliCanaryRefusal(installation: string, released: string, now = Date.now()) {
  const record = readCliCanaryRefusal(installation);
  return record && record.head === released && (record.hold || now < record.nextRetryAt) ? record : null;
}
const clock = (at: number) => new Date(at).toISOString().slice(11, 16) + ' UTC';
/** One stderr line per call while a refusal is active; the first call carries the detail. */
export function cliCanaryNotice(installation: string, record: CanaryRefusal, runningOn: string) {
  const first = !record.noticed;
  if (first) {
    try {
      writeCliCanaryRefusal(installation, { ...record, noticed: true });
    } catch {
      /* advisory */
    }
  }
  const retry = record.hold
    ? 'held until main moves (explicit rollback)'
    : `next retry after ${clock(record.nextRetryAt)}`;
  const head = `Forge CLI main ${record.head.slice(0, 8)} was ${record.hold ? 'rolled back' : record.step === SERVER_BEHIND_STEP ? 'held by its pre-switch canary' : 'refused by its pre-switch canary'}`;
  return (
    `${head} (${record.reason}); running on ${runningOn.slice(0, 8)}, ${retry}.` +
    (first
      ? ` Details: ${join(installation, 'canary-refused.json')}. Switch builds by hand: nforge cli rollback | nforge update.`
      : '')
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
        ...(hooks.home ? { home: hooks.home } : {}),
      });
      clearCliCanaryRefusal(installation);
      log(
        `Forge CLI canary passed for ${head.slice(0, 8)} in ${((now() - started) / 1000).toFixed(1)}s: ` +
          result.steps.map(step => `${step.name} ${step.ms}ms`).join(', ') +
          (result.skipped.length ? `; skipped: ${result.skipped.join('; ')}` : '') +
          '.',
      );
    } catch (error) {
      const failure = error instanceof CanaryFailure ? error : null;
      const previous = readCliCanaryRefusal(installation);
      const same = previous?.head === head ? previous : null;
      const attempts = (same?.attempts ?? 0) + 1;
      const record: CanaryRefusal = {
        head,
        at: new Date(now()).toISOString(),
        step: failure?.step ?? 'canary',
        reason: failure?.message ?? 'canary failed unexpectedly',
        attempts,
        nextRetryAt: now() + cliCanaryBackoffMs(attempts),
        ...(same?.alerted ? { alerted: true } : {}),
        ...(same?.noticed && same.reason === (failure?.message ?? '') ? { noticed: true } : {}),
      };
      writeCliCanaryRefusal(installation, record);
      const behind = record.step === SERVER_BEHIND_STEP;
      log(
        behind
          ? `Forge CLI canary held ${head.slice(0, 8)}: ${record.reason}; the previous build stays selected, next retry after ${clock(record.nextRetryAt)} (attempt ${attempts}).`
          : `Forge CLI canary refused ${head.slice(0, 8)}: ${record.reason}; the previous build stays selected.`,
      );
      // A server that is behind is the normal deploy order, not a broken build: no alert.
      if (!record.alerted && !behind) {
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
