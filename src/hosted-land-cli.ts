// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';
import { HostedAgentTransport, type HostedAgentResponse } from './hosted-agent-transport.js';
import { hostedAgentCli } from './hosted-agent-cli.js';
import { observeHostedSubmissions } from './hosted-agent-submission-wait.js';
import { observeHostedRun } from './hosted-agent-observe.js';
import { waitHostedAgentSource } from './hosted-agent-source-wait.js';
import { readClientSettings } from './client-settings.js';
import { withLaneCommand } from './lane-registry.js';
import { markerIdentity } from './lane-prune.js';
import { landPhase, landSummary, resultOf, terminalPhases } from './hosted-land-summary.js';
import { landAnnouncement, landWaitCommand } from './hosted-land-wait.js';
import { markOverlapShown, overlapBannerOnce, type HostedOverlapNotice } from './hosted-overlap-notice.js';

export { landPhase, landSummary };

/** Set in the detached submitter; it submits and exits without waiting. */
export const LAND_CHILD_ENV = 'FORGE_LAND_CHILD';
const noticeOf = (response: HostedAgentResponse) =>
  (response as { overlapNotice?: HostedOverlapNotice }).overlapNotice;
/** Immediate stderr progress for a submitted landing: operation id, replay and wait commands, overlap banner. */
function announce(root: string, command: Record<string, unknown>, response: HostedAgentResponse) {
  for (const line of landAnnouncement(root, command, response)) process.stderr.write(`${line}\n`);
  const notice = noticeOf(response);
  if (notice) process.stderr.write(overlapBannerOnce(notice));
}

/** The submitter: replays finish while its save job is still running, so compose and submission
 * never wait for the agent to call again. Bounded; every replay reuses the same retained operation. */
export async function submitHostedLand(
  root: string,
  command: Record<string, unknown>,
  address: HostedAgentAddress,
  transport = new HostedAgentTransport(root, address),
  rounds = 30,
) {
  let response = (await hostedAgentCli(root, 'finish', command, address, transport)) as HostedAgentResponse;
  // The first receipt already carries the operation id and any overlap notice: show them now, not at exit.
  announce(root, command, response);
  for (let round = 0; round < rounds; round++) {
    const result = resultOf(response);
    if (result.phase !== 'save' || !result.saveOperationId || result.progress?.status === 'failed') break;
    await waitHostedAgentSource(
      address,
      result.saveOperationId,
      result.progress,
      undefined,
      undefined,
      'Saves',
    );
    response = (await hostedAgentCli(root, 'finish', command, address, transport)) as HostedAgentResponse;
  }
  return response;
}

/** Copy a growing file to stderr; stop() flushes the rest. A short local timer, no network. */
export function relayFile(path: string) {
  const fd = openSync(path, 'r');
  let offset = 0;
  const flush = () => {
    const size = fstatSync(fd).size;
    if (size <= offset) return;
    const buffer = Buffer.alloc(size - offset);
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    offset += read;
    process.stderr.write(buffer.subarray(0, read));
  };
  const timer = setInterval(flush, 200);
  return {
    stop() {
      clearInterval(timer);
      try {
        flush();
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** Run the submitter in its own process group with file output: a killed, interrupted or
 * SIGPIPEd client never stops a landing it already started. */
async function detachedSubmit(
  root: string,
  command: Record<string, unknown>,
): Promise<HostedAgentResponse | null> {
  const directory = join(`${hostedAgentRoot(root)}.forge-client`, 'agent', 'land');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const base = join(directory, randomUUID()),
    out = openSync(`${base}.out`, 'w', 0o600),
    err = openSync(`${base}.err`, 'w', 0o600);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./cli-entry.js', import.meta.url)),
      'agent',
      root,
      'finish',
      JSON.stringify(command),
    ],
    { detached: true, stdio: ['ignore', out, err], env: { ...process.env, [LAND_CHILD_ENV]: '1' } },
  );
  closeSync(out);
  closeSync(err);
  const leave = () => {
    process.stderr.write(
      `land: submission continues in the background (pid ${child.pid}); run the same command to resume.\n`,
    );
    process.exit(130);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.once(signal, leave);
  // Forward the submitter's stderr as it appears (local file reads only), so the operation id and an
  // overlap banner reach the agent while the save and compose are still running.
  const relay = relayFile(`${base}.err`);
  const code = await new Promise<number>(resolve => {
    child.once('error', () => resolve(1));
    child.once('exit', status => resolve(status ?? 1));
  });
  relay.stop();
  for (const signal of signals) process.removeListener(signal, leave);
  const stdout = readFileSync(`${base}.out`, 'utf8');
  rmSync(`${base}.out`, { force: true });
  rmSync(`${base}.err`, { force: true });
  const line = stdout.trim().split('\n').at(-1);
  if (code !== 0 || !line) {
    process.exitCode = code || 1;
    return null;
  }
  const response = JSON.parse(line) as HostedAgentResponse;
  // The relayed stderr already showed this notice; the final banner must not repeat it.
  const notice = noticeOf(response);
  if (notice) markOverlapShown(notice);
  return response;
}

/** Event-driven wait on the submission (or check-only run); Ctrl-C stops waiting, never the landing. */
async function waitLanding(
  transport: HostedAgentTransport,
  response: HostedAgentResponse,
  timeoutSeconds: number,
) {
  const result = resultOf(response);
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (result.phase === 'check' && result.run?.id)
      await observeHostedRun(transport, { runId: result.run.id, timeoutSeconds }, controller.signal);
    else if (response.operationId)
      await observeHostedSubmissions(
        transport,
        { operationIds: [response.operationId], timeoutSeconds },
        controller.signal,
      );
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return !controller.signal.aborted;
}

/** land --save / finish for hosted Lanes: submit (detached), then wait for the outcome by default. */
export async function hostedLandCli(
  root: string,
  command: Record<string, unknown>,
  address: HostedAgentAddress,
  options: { wait?: boolean | undefined; detach?: boolean; timeoutSeconds?: number } = {},
): Promise<HostedAgentResponse | undefined> {
  if (process.env[LAND_CHILD_ENV] === '1') return submitHostedLand(root, command, address);
  const submitted =
    options.detach === false
      ? await submitHostedLand(root, command, address)
      : await detachedSubmit(root, command);
  if (!submitted) return undefined;
  const wait = options.wait ?? readClientSettings().landWait;
  const phase = landPhase(submitted);
  if (
    !wait ||
    (phase && terminalPhases.has(phase)) ||
    ['conflict', 'save', 'compose', 'sync'].includes(String(resultOf(submitted).phase))
  ) {
    for (const line of landSummary(submitted)) process.stderr.write(`${line}\n`);
    return submitted;
  }
  process.stderr.write(
    `land: waiting for the outcome (operationId ${submitted.operationId}); Ctrl-C stops waiting, not the landing.\n`,
  );
  const transport = new HostedAgentTransport(root, address);
  const finished = await withLaneCommand(markerIdentity(root)?.laneId ?? undefined, 'land', () =>
    waitLanding(transport, submitted, options.timeoutSeconds ?? 5400),
  );
  // One replay of the same request returns the canonical terminal receipt.
  const final = (await hostedAgentCli(root, 'finish', command, address, transport)) as HostedAgentResponse;
  const lines = landSummary(final);
  for (const line of lines) process.stderr.write(`${line}\n`);
  const outcome = landPhase(final);
  if (outcome === 'terminal-failed' || lines[0]?.startsWith('FAILED')) process.exitCode = 2;
  else if (!finished || !outcome || !terminalPhases.has(outcome)) {
    if (!(resultOf(final).phase === 'check' && resultOf(final).run?.status === 'passed')) {
      const resume = landWaitCommand(root, final);
      process.stderr.write(
        `land: still running; ${resume ? `keep waiting with: ${resume}` : 'run the same command again to keep waiting.'}\n`,
      );
      process.exitCode = 3;
    }
  }
  return final;
}
