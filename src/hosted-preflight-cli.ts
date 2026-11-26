// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AGENT_WAIT_SECONDS, operationWait } from './agent-operation-wait.js';
import { resolveAgentSession } from './agent-session.js';
import { backgroundWake, WAKE_BUDGET_SECONDS } from './agent-wake.js';
import { hostedAgentDirectory, hostedAgentRoot, retainedHostedValues } from './hosted-agent-journal.js';
import { processAlive, processIdentityIfKnown } from './local-process.js';
import { watchLocal } from './local-watcher.js';
import {
  PREFLIGHT_COMPLETION,
  PREFLIGHT_RUNNER,
  PREFLIGHT_EXECUTOR,
  interruptedPreflight,
  preflightJournal,
  type PreflightCompletion,
  type PreflightRequest,
  type PreflightWorkerReply,
  type PreflightWorkerMessage,
} from './hosted-preflight-result.js';

const read = (root: string, id: string) => retainedHostedValues(root, id, 'preflight');
const completionOf = (values: ReturnType<typeof read>) =>
  values?.[PREFLIGHT_COMPLETION] as PreflightCompletion | undefined;
const workerIdentity = (values: ReturnType<typeof read>, key: string) =>
  values?.[key] as ReturnType<typeof processIdentityIfKnown> | null | undefined;
const verdictWords: Readonly<Partial<Record<string, string>>> = {
  failed: 'FAILED',
  incomplete: 'NOT COMPLETE',
  environment: 'ENVIRONMENT',
};

function pending(root: string, id: string, seconds: number) {
  const wait = operationWait(root, { operationIds: [id], timeoutSeconds: seconds });
  return {
    status: 'IN_PROGRESS',
    phase: 'preflight',
    ...wait,
    instruction:
      'Run this wait once in the background for a completion wake, or in the foreground for the same result. If the shell stops early, run the same wait again.',
    wake: { delivery: 'background-exit', command: wait.command, budgetSeconds: seconds },
  };
}

function show(id: string, done: PreflightCompletion, full?: PreflightWorkerReply) {
  process.exitCode = done.exitCode;
  const { status, localPreflight, reason, error, command } = done.result;
  const verdict = verdictWords[status] ?? status;
  const line = localPreflight
    ? `, ${localPreflight.tests} test file(s) in ${localPreflight.seconds.toFixed(1)} s`
    : '';
  const detail = error ? ` (${error.code}: ${error.message})` : reason ? ` (${reason})` : '';
  if (full?.error) process.stderr.write(`${JSON.stringify({ error: full.error })}\n`);
  process.stderr.write(
    `preflight result: ${verdict}${line}${detail}${command ? `. Next: ${command}` : ''}.\n`,
  );
  const reply = full?.reply;
  return {
    ...reply,
    action: 'preflight',
    operationId: id,
    result: { ...done.result, ...(reply?.result as object | undefined) },
  };
}

/** One timer and signal change for a waiting client. Only the client stops. */
function waitFor<T>(seconds: number, start: (settle: (result?: T) => void) => () => void) {
  return new Promise<T | undefined>(resolve => {
    let stop: (() => void) | undefined;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const interrupt = () => settle();
    const settle = (value?: T) => {
      clearTimeout(timer);
      for (const signal of signals) process.removeListener(signal, interrupt);
      stop?.();
      resolve(value);
    };
    const timer = setTimeout(interrupt, seconds * 1000);
    for (const signal of signals) process.once(signal, interrupt);
    try {
      stop = start(settle);
    } catch {
      settle();
    }
  });
}

/** Observe atomic journal replacements, with one watcher and deadline for the whole batch. */
async function observePreflights(root: string, ids: string[], seconds: number, anyChange = false) {
  const results = new Map<string, PreflightCompletion>();
  const readResult = (id: string, checkLiveness: boolean) => {
    if (results.has(id)) return;
    const values = read(root, id);
    const done = completionOf(values);
    if (done) {
      results.set(id, done);
      return;
    }
    if (!checkLiveness) return;
    const runner = workerIdentity(values, PREFLIGHT_RUNNER);
    const executor = workerIdentity(values, PREFLIGHT_EXECUTOR);
    if (
      !values ||
      runner === null ||
      (runner && !processAlive(runner) && (!executor || !processAlive(executor)))
    )
      results.set(id, completionOf(read(root, id)) ?? interruptedPreflight());
  };
  const settled = () => (anyChange ? results.size > 0 : results.size === ids.length);
  for (const id of ids) readResult(id, true);
  if (!settled() && seconds > 0) {
    process.stderr.write(`preflight: waiting for ${ids.join(', ')}.\n`);
    await waitFor<boolean>(seconds, settle => {
      const check = (file: string | null) => {
        if (file) {
          const id = file.slice(0, -5);
          if (file.endsWith('.json') && ids.includes(id)) readResult(id, false);
        } else for (const id of ids) readResult(id, false);
        if (settled()) settle(true);
      };
      // Read again once the isolated helper attaches: a completion during startup
      // may have no filesystem event to replay.
      const watcher = watchLocal(hostedAgentDirectory(root), { onReady: () => check(null) }, (_event, file) =>
        check(file),
      );
      void watcher.probe().then(health => {
        if (health.status === 'degraded') settle();
      });
      return () => {
        void watcher.close();
      };
    });
    for (const id of ids) readResult(id, true);
  }
  return results;
}

async function waitLocalPreflight(root: string, id: string, seconds: number) {
  const done = (await observePreflights(root, [id], seconds)).get(id);
  return done ? show(id, done) : unfinished(root, id);
}

/** Local-only waits skip capability discovery. Mixed waits keep the original hosted observer
 * for its own IDs and spend any remaining budget on the local results. */
export async function waitLocalPreflights(
  root: string,
  command: Record<string, unknown>,
  ids: string[],
  observeHosted?: () => Promise<unknown>,
) {
  root = hostedAgentRoot(root);
  const seconds =
    typeof command.timeoutSeconds === 'number'
      ? command.timeoutSeconds
      : observeHosted
        ? AGENT_WAIT_SECONDS
        : WAKE_BUDGET_SECONDS;
  if (ids.length === 1 && !observeHosted) return await waitLocalPreflight(root, ids[0]!, seconds);
  const started = performance.now();
  const hosted = (await observeHosted?.()) as
    | { result?: { inProgress?: boolean; status?: string } }
    | undefined;
  const hostedExit = Number(process.exitCode ?? 0);
  const hostedPending = hosted?.result?.inProgress === true;
  const anyChange = command.until === 'any-change';
  const remaining =
    hostedPending || (hosted && anyChange) ? 0 : Math.max(0, seconds - (performance.now() - started) / 1000);
  const results = await observePreflights(root, ids, remaining, anyChange);
  const preflights = ids.map(id => {
    const result = results.get(id);
    return result ? show(id, result) : { operationId: id, result: pending(root, id, WAKE_BUDGET_SECONDS) };
  });
  const incomplete = results.size < ids.length;
  const stillWaiting = incomplete || hostedPending;
  const code = [...results.values()].find(result => result.exitCode !== 0)?.exitCode ?? 0;
  process.exitCode = stillWaiting && hostedExit < 128 ? 3 : hostedExit || code;
  const { action, url, projectId, ...targets } = command;
  void action;
  void url;
  void projectId;
  const resume = stillWaiting ? operationWait(root, targets) : {};
  return {
    action: 'wait',
    operationId: null,
    ...hosted,
    result: {
      status: 'terminal',
      ...hosted?.result,
      preflights,
      ...(stillWaiting ? { status: 'IN_PROGRESS', phase: 'preflight', ...resume } : {}),
    },
  };
}

function unfinished(root: string, id: string, exitCode = 3) {
  process.exitCode = exitCode;
  const result = pending(root, id, WAKE_BUDGET_SECONDS);
  process.stderr.write(`preflight: IN PROGRESS. Continue with: ${result.command}\n`);
  return { action: 'preflight', operationId: id, result };
}

export async function hostedPreflightCli(
  root: string,
  address: PreflightRequest['address'],
  selected: Record<string, unknown>,
  wait?: boolean,
) {
  root = hostedAgentRoot(root);
  const { operationId, projectId, url, action, ...command } = selected;
  void projectId;
  void url;
  void action;
  const id = typeof operationId === 'string' ? operationId : randomUUID();
  const request = { root, address, operationId: id, command };
  const journal = preflightJournal(request);
  const foreground = wait ?? !backgroundWake();
  const launch: { handle?: { child: ChildProcess; closed: Promise<void>; output?: PreflightWorkerReply } } =
    {};
  try {
    journal.retainLocal(PREFLIGHT_RUNNER, () => {
      const session = resolveAgentSession()?.key;
      const args = [
        fileURLToPath(new URL('./hosted-preflight-worker.js', import.meta.url)),
        JSON.stringify(request),
      ];
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        env: session ? { ...process.env, FORGE_AGENT_SESSION: session } : process.env,
      });
      const started: NonNullable<typeof launch.handle> = {
        child,
        closed: new Promise<void>(resolve => {
          child.once('close', () => resolve());
          child.once('error', () => resolve());
        }),
      };
      child.on('message', value => {
        const message = value as PreflightWorkerMessage;
        if (message.type === 'progress' && foreground) process.stderr.write(message.chunk);
        if (message.type === 'result') started.output = message.output;
      });
      launch.handle = started;
      return child.pid ? processIdentityIfKnown(child.pid) : null;
    });
    const { handle } = launch;
    const existing = journal.get<PreflightCompletion>(PREFLIGHT_COMPLETION);
    if (existing && !handle) return show(id, existing);
    if (!foreground) return unfinished(root, id, 0);
    if (!handle) return await waitLocalPreflight(root, id, AGENT_WAIT_SECONDS);
    process.stderr.write(
      `preflight: ${id}; if this shell stops, wait for the result with: ${pending(root, id, WAKE_BUDGET_SECONDS).command}\n`,
    );
    const exited = await waitFor<boolean>(AGENT_WAIT_SECONDS, settle => {
      void handle.closed.then(() => settle(true));
      return () => undefined;
    });
    const done = journal.get<PreflightCompletion>(PREFLIGHT_COMPLETION);
    if (done) return show(id, done, handle.output);
    return exited ? show(id, interruptedPreflight()) : unfinished(root, id);
  } finally {
    const child = launch.handle?.child;
    if (child?.connected) child.disconnect();
    child?.unref();
  }
}
