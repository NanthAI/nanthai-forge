// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_WAIT_SECONDS, interruptedWait, operationWait } from './agent-operation-wait.js';
import { cliInstallation } from './cli-installation.js';
import { measurementHoldProjects, waitForCliMeasurement } from './cli-measurement-hold.js';
import { ForgeError, invariant } from './errors.js';
import { hostedAgentDirectory, hostedAgentRoot, readAgentJson } from './hosted-agent-journal.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { finishSourceSelection } from './hosted-agent-finish-identity.js';
import type { HostedAgentResponse } from './hosted-agent-transport.js';
import { suppliedLandingMessage } from './landing-message.js';
import { MEASUREMENT_LAND_RECORD } from './hosted-land-child-env.js';
import { resolvedOriginFinishId } from './hosted-land-resolution.js';
import { spawnLandSubmitter } from './hosted-land-submitter-process.js';
import { landWaitContinuation } from './hosted-land-wait.js';
import { LAND_HELD_MS_ENV, LAND_INVOKED_ENV, MAX_LANDING_HOLD_MS } from './land-timing.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { processAlive, processIdentityIfKnown } from './local-process.js';
import { waitForSubmitter } from './hosted-land-measurement-wait.js';
import { clientCacheRoot } from './root-paths.js';
import { shellQuote } from './shell-quote.js';
import { durableReplace } from './state/durability.js';
import { workLocked } from './work-lock.js';

type Command = Record<string, unknown>;
type Held = {
  operationId: string;
  address: HostedAgentAddress;
  command: Command;
  auto: boolean;
  installation: string;
  budget: number;
  holdStartedAt?: number;
  heldMs?: number | null;
  worker: { pid: number; startTime?: string };
};
type Completion = { code: number; record: Held };

function pendingPath(root: string) {
  return join(clientCacheRoot(root), 'agent', MEASUREMENT_LAND_RECORD);
}
function readPending(path: string) {
  return existsSync(path) ? (readAgentJson(path) as Held[]) : [];
}
const baseOf = (path: string, id: string) => join(dirname(path), 'land', `held-${id}`);
const donePath = (path: string, id: string) => `${baseOf(path, id)}.done`;
const readCompletion = (path: string, id: string) => {
  const done = donePath(path, id);
  return existsSync(done) ? (readAgentJson(done) as Completion) : undefined;
};
const same = (a: unknown, b: unknown) => canonicalPayload(a) === canonicalPayload(b);

function heldBy(installation: string, projectId: string) {
  const projects = measurementHoldProjects(installation);
  return projects && !projects.includes(projectId) ? join(installation, '.freeze') : null;
}
function pendingReply(
  root: string,
  record: Held,
  action: 'finish' | 'wait',
  seconds?: number,
  completed = false,
) {
  const hold = !completed && heldBy(record.installation, record.address.projectId);
  const continuation = operationWait(root, {
    ...record.address,
    operationIds: [record.operationId],
    until: 'acceptance',
    ...(seconds === undefined ? {} : { timeoutSeconds: seconds }),
  });
  return {
    schema: 1 as const,
    transport: 'hosted' as const,
    action,
    resolved: null,
    operationId: record.operationId,
    result: {
      phase: hold ? 'measurement-hold' : completed ? 'submission-finished' : 'submitting',
      status: hold ? 'held' : 'pending',
      ...(hold ? { hold: { kind: 'measurement', path: hold } } : {}),
      ...continuation,
    },
  };
}

/** The child cannot proceed until its owner and exact request are durable. */
function launch(root: string, path: string, records: Held[], record: Omit<Held, 'worker'>): Held {
  const base = baseOf(path, record.operationId);
  mkdirSync(dirname(base), { recursive: true, mode: 0o700 });
  const child = spawnLandSubmitter(root, record.command, base, record.budget, false, { auto: record.auto });
  child.on('error', () => undefined);
  child.unref();
  invariant(child.pid, 'WORK_BUSY', 'Could not start the held landing submitter. Retry the original land.');
  const active = { ...record, worker: processIdentityIfKnown(child.pid) };
  durableReplace(path, JSON.stringify([...records, active]));
  return active;
}

/** Only explicit no-wait starts a held request. Any retry joins the retained operation. */
export function deferMeasurementLand(
  root: string,
  command: Command,
  address: HostedAgentAddress,
  options: { noWait: boolean; budget?: number; validate: () => void },
) {
  const installation = cliInstallation();
  if (!installation || process.env.FORGE_CLI_CANARY) return undefined;
  root = hostedAgentRoot(root);
  const path = pendingPath(root);
  const hold = heldBy(installation, address.projectId);
  if ((!hold || !options.noWait) && !existsSync(path)) return undefined;
  options.validate();
  const suppliedId = command.operationId;
  const parameters = Object.fromEntries(
    Object.entries(command).filter(([key]) => !['operationId', 'url', 'projectId', 'action'].includes(key)),
  );
  const request: Command = { ...parameters, ...address };
  const selection = (body: Command) => finishSourceSelection({ ...body, after: body.after ?? null });
  const matches = (record: Held) =>
    suppliedId === undefined
      ? record.auto &&
        request.accept === record.command.accept &&
        same(selection(request), selection(record.command))
      : record.operationId === suppliedId;
  // A completed request follows the normal finish selection/replay rules.
  const active = () => readPending(path).filter(record => !existsSync(donePath(path, record.operationId)));
  const completed = () =>
    hold && options.noWait && typeof suppliedId === 'string'
      ? readCompletion(path, suppliedId)?.record
      : undefined;
  const compatible = (record: Held) =>
    invariant(
      suppliedId === undefined
        ? JSON.stringify(request.notVerified) === JSON.stringify(record.command.notVerified)
        : same({ ...request, operationId: record.operationId }, record.command),
      'WORK_OPERATION_CHANGED',
      `Retry the original request or wait for landing ${record.operationId}.`,
    );
  const finished = completed();
  if (finished) {
    compatible(finished);
    return pendingReply(root, finished, 'finish', undefined, true);
  }
  if ((!hold || !options.noWait) && !active().some(matches)) return undefined;
  if (typeof command.message === 'string') suppliedLandingMessage(command.message);
  hostedAgentDirectory(root);
  const record = workLocked(`${path}.lock`, () => {
    const records = active();
    const previous = records.find(matches);
    if (previous) {
      compatible(previous);
      if (processAlive(previous.worker)) return previous;
      return launch(
        root,
        path,
        records.filter(item => item !== previous),
        previous,
      );
    }
    const finished = completed();
    if (finished) {
      compatible(finished);
      return finished;
    }
    if (!options.noWait || !heldBy(installation, address.projectId)) return undefined;
    const operationId =
      (suppliedId as string | undefined) ?? resolvedOriginFinishId(root, request) ?? randomUUID();
    const prior = readCompletion(path, operationId)?.record;
    if (prior) return prior;
    return launch(root, path, records, {
      operationId,
      address,
      command: { ...request, operationId },
      installation,
      budget: options.budget ?? AGENT_WAIT_SECONDS,
      holdStartedAt: Date.now(),
      auto: suppliedId === undefined,
    });
  });
  return (
    record && pendingReply(root, record, 'finish', undefined, existsSync(donePath(path, record.operationId)))
  );
}

/** Run before release discovery. Only the process committed with this request can submit it. */
export async function activateMeasurementSubmitter(root: string, command: Command) {
  const path = pendingPath(hostedAgentRoot(root));
  const record = workLocked(
    `${path}.lock`,
    () => readPending(path).find(item => item.worker.pid === process.pid && same(item.command, command)),
    { waitMs: 1000 },
  );
  if (!record) return false;
  let completed = record;
  process.once('beforeExit', code =>
    durableReplace(donePath(path, record.operationId), JSON.stringify({ code, record: completed })),
  );
  if (record.heldMs === undefined) {
    const heldMs = await waitForCliMeasurement(
      record.installation,
      undefined,
      async () => record.address.projectId,
      record.holdStartedAt,
    );
    if (record.holdStartedAt !== undefined)
      completed = workLocked(`${path}.lock`, () => {
        const records = readPending(path);
        const index = records.findIndex(item => item.operationId === record.operationId);
        const active = records[index];
        invariant(active?.worker.pid === process.pid, 'WORK_BUSY', 'The held landing submitter changed.');
        const measured = {
          ...active,
          heldMs: heldMs === undefined ? null : Math.min(MAX_LANDING_HOLD_MS, heldMs),
        };
        records[index] = measured;
        durableReplace(path, JSON.stringify(records));
        return measured;
      });
  }
  // Older records lack a start clock. A worker that missed release lacks an end clock.
  process.env[LAND_HELD_MS_ENV] = completed.heldMs == null ? '' : String(completed.heldMs);
  process.env[LAND_INVOKED_ENV] = String(Date.now());
  return true;
}

/** Watch the submitter's completion locally, then give the normal hosted wait its remaining budget. */
export async function observeMeasurementLand(root: string, command: Command, address: HostedAgentAddress) {
  if (!Array.isArray(command.operationIds) || command.operationIds.length !== 1) return undefined;
  const operationId: string = command.operationIds[0];
  root = hostedAgentRoot(root);
  const path = pendingPath(root);
  let completion = readCompletion(path, operationId);
  const record = completion?.record ?? readPending(path).find(item => item.operationId === operationId);
  if (!record || !same(record.address, address)) return undefined;
  const budget = (command.timeoutSeconds as number | undefined) ?? AGENT_WAIT_SECONDS;
  const deadline = Date.now() + budget * 1000;
  const base = baseOf(path, operationId),
    done = donePath(path, operationId);
  const pending = () => pendingReply(root, record, 'wait', command.timeoutSeconds as number | undefined);
  if (!completion) {
    let worker = record.worker;
    const ensureSubmitter = () => {
      if (existsSync(done) || processAlive(worker)) return;
      worker =
        workLocked(`${path}.lock`, () => {
          if (existsSync(done)) return;
          const records = readPending(path);
          const current = records.find(item => item.operationId === operationId);
          if (!current || processAlive(current.worker)) return current?.worker;
          return launch(
            root,
            path,
            records.filter(item => item !== current),
            current,
          ).worker;
        }) ?? worker;
    };
    ensureSubmitter();
    if (!existsSync(done)) {
      const hold = heldBy(record.installation, address.projectId);
      if (hold)
        process.stderr.write(`land: held by measurement ${hold}. It submits when the hold releases.\n`);
      const interrupt = await waitForSubmitter(
        done,
        hold,
        ensureSubmitter,
        Math.max(0, deadline - Date.now()),
      );
      if (interrupt || !existsSync(done)) {
        const stopped = interrupt ? interruptedWait(interrupt) : undefined;
        process.exitCode = stopped?.exitCode ?? 3;
        const reply = pending();
        return {
          reply: { ...reply, result: { ...reply.result, ...(stopped ? { reason: stopped.reason } : {}) } },
        };
      }
    }
  }
  completion ??= readCompletion(path, operationId);
  invariant(completion, 'WORK_BUSY', 'The held submitter receipt disappeared. Retry the original wait.');
  const { code } = completion;
  const line = readFileSync(`${base}.out`, 'utf8').trim().split('\n').at(-1);
  const response = line ? (JSON.parse(line) as HostedAgentResponse & { error?: unknown }) : undefined;
  const result = response?.result as { submission?: unknown; run?: unknown } | undefined;
  if (
    response &&
    !response.error &&
    (result?.submission || result?.run || landWaitContinuation(root, response))
  ) {
    return {
      command: {
        ...command,
        operationIds: [response.operationId],
        timeoutSeconds: Math.max(0, (deadline - Date.now()) / 1000),
      },
    };
  }
  // A local preflight or source refusal may have no hosted operation to observe.
  if (response && !response.error && response.operationId === operationId) {
    process.exitCode = code;
    return { reply: response };
  }
  if (code === 0 || code === 3)
    return { command: { ...command, timeoutSeconds: Math.max(0, (deadline - Date.now()) / 1000) } };
  const replay = `nforge agent ${shellQuote(root)} finish ${shellQuote(JSON.stringify(record.command))}`;
  const errors = readFileSync(`${base}.err`, 'utf8').trim().split('\n');
  for (const diagnostic of [line, ...errors.reverse()]) {
    if (!diagnostic?.startsWith('{"error":')) continue;
    const { error } = JSON.parse(diagnostic) as {
      error: { code: string; message: string; recovery?: Command };
    };
    throw new ForgeError(error.code, error.message, undefined, { command: replay, ...error.recovery });
  }
  throw new ForgeError(
    'WORK_BUSY',
    'The held submitter exited before returning a landing receipt.',
    undefined,
    {
      command: replay,
    },
  );
}
