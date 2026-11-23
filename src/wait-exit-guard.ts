// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { writeSync } from 'node:fs';

/** A wait that exits without a terminal landing state makes an agent believe the work settled
 * (Issue 203c1ce5: a background wait ended after its banner). This guard makes every such exit
 * loud: non-zero, with the reason and the command that resumes the same wait. */

/** Reply statuses that say the work is unfinished. Exit 0 with one of these is a contradiction. */
const UNFINISHED = new Set([
  'IN_PROGRESS',
  'timeout',
  'cancelled',
  'message',
  'pending',
  'submitted',
  'settling',
  'sync-required',
]);
export const UNFINISHED_WAIT_EXIT = 3;

let resume: string | undefined;
let listening = false;
const signalListeners: [NodeJS.Signals, () => void][] = [];

function shellWord(word: string) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The reason a wait that stopped with `code` and no terminal reply gives, with its resume command. */
export function unfinishedWaitMessage(code: number, command: string) {
  return `nforge wait ended before the work settled (exit ${code}); the work goes on, nothing finished. Run the same command again: ${command}`;
}

/** What a reply that is about to exit 0 must become: unfinished work never exits 0. */
export function guardedWaitExit(reply: unknown, exitCode: number | string | undefined | null) {
  const code = typeof exitCode === 'number' ? exitCode : 0;
  if (code !== 0) return { exitCode: code };
  const result = (reply as { result?: { status?: unknown; inProgress?: unknown } } | null | undefined)
    ?.result;
  const status = typeof result?.status === 'string' ? result.status : undefined;
  if ((status && UNFINISHED.has(status)) || result?.inProgress === true)
    return {
      exitCode: UNFINISHED_WAIT_EXIT,
      reason: `The wait returned ${status ?? 'unfinished work'} without a terminal landing state, so it exits ${UNFINISHED_WAIT_EXIT}, not 0.`,
    };
  return { exitCode: 0 };
}

/** Arm when a wait starts. Any exit before the reply settles it (a drained event loop, a stray
 * process.exit, a hangup no other handler caught) reports itself and cannot exit 0. */
export function armWaitExitGuard(args: string[]) {
  const stdin = args.includes('-') ? ' (its JSON came from stdin: pass it again)' : '';
  resume = `nforge ${args.map(shellWord).join(' ')}${stdin}`;
  if (listening) return;
  listening = true;
  // Synchronous writes: an exit handler cannot wait for a backpressured stderr pipe.
  const say = (text: string) => {
    try {
      writeSync(2, `${text}\n`);
    } catch {
      /* stderr is gone; the exit code still says it */
    }
  };
  process.on('exit', code => {
    if (resume === undefined) return;
    const reached = code || UNFINISHED_WAIT_EXIT;
    process.exitCode = reached;
    say(unfinishedWaitMessage(reached, resume));
  });
  // The waits that handle these signals themselves return IN_PROGRESS; any other wait would
  // die silently from the default action. Only act when no other handler exists.
  for (const signal of ['SIGHUP', 'SIGTERM'] as const) {
    const onSignal = () => {
      if (process.listenerCount(signal) > 1) return;
      say(`nforge wait stopped by ${signal}; the work goes on.`);
      process.exit(UNFINISHED_WAIT_EXIT);
    };
    process.on(signal, onSignal);
    signalListeners.push([signal, onSignal]);
  }
}

/** The reply is complete (or an error is about to be printed with exit 1): the exit is explained. */
export function settleWaitExit(reply?: unknown) {
  if (resume === undefined) return;
  resume = undefined;
  // Settled: a later signal takes its default action again.
  for (const [signal, listener] of signalListeners.splice(0)) process.removeListener(signal, listener);
  if (reply === undefined) return;
  const guarded = guardedWaitExit(reply, process.exitCode);
  if (guarded.reason) {
    process.exitCode = guarded.exitCode;
    process.stderr.write(`${guarded.reason}\n`);
  }
}
