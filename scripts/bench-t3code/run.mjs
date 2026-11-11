#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The registered sequence for an already set-up and qualified bench. Scheduling and resume
// belong to drive.mjs; this entry point never sets up, qualifies or tears down resources.
import { spawn } from 'node:child_process';
import { openSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { benchRoot, benchRootOrExit } from './bench-root.mjs';
import { coordinationBatches } from './cells.mjs';

/** Forward terminal signals to the active stage and preserve its exit code. */
export function executeStage(script, args, { root, output } = {}) {
  return new Promise((resolve, reject) => {
    const fd = output ? openSync(output, 'w', 0o600) : null;
    const child = spawn(process.execPath, [join(import.meta.dirname, script), ...args], {
      env: { ...process.env, BENCH_ROOT: root },
      stdio: ['inherit', fd ?? 'inherit', 'inherit'],
    });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = signals.map(signal => [signal, () => child.kill(signal)]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (fd !== null) closeSync(fd);
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once('error', error => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129));
    });
  });
}

/** `execute` is injected only by synthetic tests, never through configuration or flags. */
export async function runBench({ root = benchRoot(), execute = executeStage, log = console.log } = {}) {
  const stages = [
    ['plan check', 'plan.mjs', ['check']],
    ['preflight', 'preflight.mjs', []],
    ['scored cells (resume)', 'drive.mjs', []],
    ...(coordinationBatches().length
      ? [['coordination cells (resume)', 'drive.mjs', ['--coordination']]]
      : []),
    ['summarize', 'summarize.mjs', []],
  ];
  for (const [name, script, args] of stages) {
    log(`BENCH ${name}`);
    const output = script === 'summarize.mjs' ? join(root, `summary.json.${process.pid}.tmp`) : null;
    let code;
    try {
      code = await execute(script, args, { root, output });
      if (code === 0 && output) renameSync(output, join(root, 'summary.json'));
    } finally {
      if (output) rmSync(output, { force: true });
    }
    if (code !== 0) {
      log(`BENCH STOP ${name} (exit ${code}); see the reason above. Resume with the same run.mjs command.`);
      return code;
    }
  }
  log('BENCH DONE summary.json (all attempts retained in runs/ and batches/)');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.length > 2) {
    const help = process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2]);
    const usage =
      'Usage: node scripts/bench-t3code/run.mjs\nRun the registered scored sequence for an already set-up BENCH_ROOT. No flags are forwarded to its stages.';
    (help ? console.log : console.error)(usage);
    process.exitCode = help ? 0 : 2;
  } else {
    const root = benchRootOrExit();
    process.exitCode = await runBench({ root });
  }
}
