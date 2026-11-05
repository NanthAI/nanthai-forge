// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { ForgeError } from './errors.js';
import { durableReplace } from './native-durability.js';
import { deliverStallAlert, STALL_ALERT_ENV } from './stall-alerts.js';

/** Hard total limit for one canary run (all steps together). */
export const CLI_CANARY_TIMEOUT_MS = 20_000;
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
type CloneRecord = { root: string; operationId?: string };
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
export type CanaryResult = { steps: CanaryStep[]; skipped: string[]; operationId?: string };

/** Run the NEW (installed, not active) build against the real project for reads only.
 * The child runs with a private HOME, so the real agent hook files are unreachable by
 * construction; credentials and caches come from the real XDG directories. */
export async function runCliCanary(input: CanaryInput): Promise<CanaryResult> {
  const { installation, build, head } = input;
  const entry = join(build, 'dist', 'cli-entry.js');
  const deadline = Date.now() + (input.timeoutMs ?? CLI_CANARY_TIMEOUT_MS);
  const realHome = input.home ?? homedir();
  const privateHome = mkdtempSync(join(tmpdir(), 'forge-canary-'));
  const xdg = (name: string, fallback: string[]) => process.env[name] || join(realHome, ...fallback);
  const env = childEnv({
    allow: CHILD_ENV,
    extra: {
      HOME: privateHome,
      USERPROFILE: privateHome,
      XDG_CONFIG_HOME: xdg('XDG_CONFIG_HOME', ['.config']),
      XDG_CACHE_HOME: xdg('XDG_CACHE_HOME', ['.cache']),
      XDG_STATE_HOME: xdg('XDG_STATE_HOME', ['.local', 'state']),
      FORGE_CLI_CANARY: head,
    },
  }) as Record<string, string>;
  const steps: CanaryStep[] = [],
    skipped: string[] = [];
  const step = async <T>(name: string, args: string[], check: (run: Run) => T) => {
    const started = Date.now();
    const run = await runChild(entry, args, env, deadline, name);
    const value = check(run);
    steps.push({ name, ms: Date.now() - started });
    return value;
  };
  const agentJson = (name: string) => (run: Run) => {
    ok(name, run);
    const json = lastJson(name, run.stdout);
    if (!json || typeof json !== 'object' || json.error)
      throw new CanaryFailure(name, `canary step ${name} returned an error document`);
    if (json.cliCommit !== undefined && json.cliCommit !== head)
      throw new CanaryFailure(name, `canary step ${name} ran a different build than ${head.slice(0, 8)}`);
    // The new build names server contract features it cannot do without (a83b6fd5): hold the switch
    // until the server it talks to advertises them, typically until its Convex deploy finishes.
    const missing = json.serverContract?.missing;
    if (Array.isArray(missing) && missing.length)
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
      const listing = await step(
        'planning',
        ['agent', root, 'planning', JSON.stringify({ limit: 50, reconcile: false })],
        agentJson('planning'),
      );
      const items = listing.result?.items;
      if (!Array.isArray(items))
        throw new CanaryFailure('planning', 'canary step planning returned no item list');
      // A wait on an operation the project no longer knows (NOT_FOUND) says nothing about the new
      // build; any other failure does. Such an operation is dropped and derived again next time.
      const waitOn = async (id: string) => {
        try {
          await step(
            'wait',
            ['agent', root, 'wait', JSON.stringify({ operationIds: [id] })],
            agentJson('wait'),
          );
          return true;
        } catch (error) {
          if (error instanceof CanaryFailure && /NOT_FOUND/.test(error.detail)) return false;
          throw error;
        }
      };
      let known: string | undefined;
      if (clone.operationId && (await waitOn(clone.operationId))) known = clone.operationId;
      else {
        // Operation records are kept for a limited time: the most recently written Issues carry
        // the freshest ones, so try the two newest.
        const newest = items
          .filter(item => typeof item?.id === 'string' && (item.kind === undefined || item.kind === 'issue'))
          .sort((x, y) => (Date.parse(String(y.at)) || 0) - (Date.parse(String(x.at)) || 0))
          .slice(0, 2);
        for (const item of newest) {
          if (known) break;
          const detail = await step(
            'planning-item',
            ['agent', root, 'planning', JSON.stringify({ id: item.id, reconcile: false })],
            agentJson('planning-item'),
          );
          const candidate = detail.result?.item?.operationId;
          if (typeof candidate === 'string' && /^[0-9a-f-]{36}$/.test(candidate) && (await waitOn(candidate)))
            known = candidate;
        }
      }
      if (!known) skipped.push('no finished operation known to the project for the wait');
      if (known !== clone.operationId)
        durableReplace(
          clonePath(installation),
          JSON.stringify({ root, ...(known ? { operationId: known } : {}) } satisfies CloneRecord),
        );
      operationId = known;
    }
  } finally {
    rmSync(privateHome, { recursive: true, force: true });
  }
  return { steps, skipped, ...(operationId ? { operationId } : {}) };
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
