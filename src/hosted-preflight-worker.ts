// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processIdentityIfKnown } from './local-process.js';
import {
  PREFLIGHT_COMPLETION,
  PREFLIGHT_EXECUTOR,
  PREFLIGHT_RUNNER,
  completedPreflight,
  interruptedPreflight,
  preflightJournal,
  refusedPreflight,
  type PreflightRequest,
  type PreflightWorkerMessage,
  type PreflightWorkerReply,
} from './hosted-preflight-result.js';

const json = process.argv[2]!;
const request = JSON.parse(json) as PreflightRequest;
const journal = preflightJournal(request);
if (process.argv[3] === 'execute') await execute();
else {
  // When the CLI dies between spawn and the journal write, the supervisor can claim its run.
  // An exact replay racing that startup may spawn, but only the claim holder runs checks.
  const runner = journal.retainLocal(PREFLIGHT_RUNNER, () => processIdentityIfKnown());
  if (runner?.pid === process.pid) await supervise();
}

function send(message: PreflightWorkerMessage, done?: () => void) {
  if (!process.connected || !process.send) {
    done?.();
    return;
  }
  process.send(message, () => done?.());
}

/** Own the output pipe and the executor's lifetime independently of the shell. A test's inherited
 * stderr stays writable when the shell vanishes. The executor's exit wakes us even after SIGKILL. */
async function supervise() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), json, 'execute'], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
  });
  child.on('message', value => send(value as PreflightWorkerMessage));
  child.stderr!.on('data', (chunk: Buffer) => {
    child.stderr!.pause();
    send({ type: 'progress', chunk }, () => child.stderr!.resume());
  });
  const interrupted = () => {
    if (journal.get(PREFLIGHT_COMPLETION)) return;
    journal.retainLocal(PREFLIGHT_COMPLETION, interruptedPreflight);
    // A process the killed executor left behind may still have the write end open.
    child.stderr!.destroy();
  };
  await new Promise<void>(resolve => {
    child.once('exit', interrupted);
    child.once('close', () => resolve());
    child.once('error', () => {
      interrupted();
      resolve();
    });
  });
}

async function execute() {
  journal.retainLocal(PREFLIGHT_EXECUTOR, () => processIdentityIfKnown());
  const start = performance.now();
  let output: PreflightWorkerReply;
  try {
    const { hostedAgentCli } = await import('./hosted-agent-cli.js');
    output = {
      reply: (await hostedAgentCli(
        request.root,
        'preflight',
        request.command,
        request.address,
      )) as NonNullable<PreflightWorkerReply['reply']>,
    };
  } catch (error) {
    const { cliTeachContext } = await import('./error-teaching.js');
    const { reportFailure } = await import('./system-errors.js');
    output = {
      error: reportFailure(
        error,
        cliTeachContext(['agent', request.root, 'preflight', JSON.stringify(request.command)]),
      ),
    };
  }
  const completion = output.error
    ? refusedPreflight(output.error)
    : completedPreflight(
        request.root,
        output.reply!,
        Number(process.exitCode ?? 0),
        performance.now() - start,
      );
  journal.retainLocal(PREFLIGHT_COMPLETION, () => completion);
  send({ type: 'result', output });
}
