// SPDX-License-Identifier: Apache-2.0
import { semanticTests, type SemanticPlan } from './intent-semantic-conflict.js';

/** Fixed runner code, not a repository hook. Complete reports from the configured
 * check satisfy the union; only uncovered files run afterwards in the same exact
 * workspace/environment. The outer run owns cancellation, evidence and Q3 reuse. */
const program = `
const { spawn } = await import('node:child_process');
const { performance } = await import('node:perf_hooks');
const { command, tests } = JSON.parse(process.argv[1]);
const covered = new Set(), failedReports = new Set();
const execute = (args, observe = false) => new Promise(resolve => {
  const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  const tails = new Map();
  const stream = (pipe, output) => {
    pipe.setEncoding('utf8');
    pipe.on('data', text => {
      output.write(text);
      if (!observe) return;
      let pending = (tails.get(pipe) ?? '') + text;
      const lines = pending.split('\\n');
      tails.set(pipe, lines.pop().slice(-1048576));
      for (const line of lines) if (line.startsWith('__FORGE_TESTS__')) {
        try {
          const report = JSON.parse(line.slice('__FORGE_TESTS__'.length));
          if (report.complete && report.results?.length && report.results.every(test => typeof test.passed === 'boolean')) { covered.add(report.file); if (report.results.some(test => !test.passed)) failedReports.add(report.file); else failedReports.delete(report.file); }
        } catch {}
      }
    });
  };
  stream(child.stdout, process.stdout); stream(child.stderr, process.stderr);
  child.on('error', () => resolve(127));
  child.on('close', code => resolve(code ?? 128));
});
let code = await execute(command, true);
if (tests.some(test => failedReports.has(test))) code = code || 1;
const missing = tests.filter(test => !covered.has(test));
let next = 0;
await Promise.all(Array.from({length: Math.min(2, missing.length)}, async () => {
  while (next < missing.length) {
    const file = missing[next++], start = performance.now();
    const status = await execute([process.execPath, '--test', '--test-concurrency=2', '--test-timeout=90000', file]);
    const durationMs = performance.now() - start;
    process.stdout.write('__FORGE_TESTS__' + JSON.stringify({file, complete:status === 0 || status === 1, durationMs, results:[{name:file, passed:status === 0}]}) + '\\n');
    if (status !== 0) code = code || status;
  }
}));
process.exitCode = code;
`;
export function semanticCheckCommand(
  command: string[],
  plan?: SemanticPlan,
  node = 'node',
  coveredTests: string[] = [],
): string[] {
  const covered = new Set(coveredTests);
  const tests = semanticTests(plan).filter(test => !covered.has(test));
  if (!tests.length) return command;
  return [node, '--input-type=module', '--eval', program, JSON.stringify({ command, tests })];
}
