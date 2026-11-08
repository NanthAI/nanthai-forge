// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { semanticTests, type SemanticPlan } from './intent-semantic-conflict.js';
import { junitLimits } from './junit-report.js';
import { FILES_PLACEHOLDER, runnerCommand, type TestRunnerResolution } from './project-test-runner.js';

/** Fixed runner code, not a repository hook. Complete reports from the configured
 * check satisfy the union: Forge's `__FORGE_TESTS__` lines, and JUnit XML the check wrote to
 * `FORGE_JUNIT_DIR` (the src/junit-report.ts parser, shipped in the payload so an exported script needs
 * no Forge install). Only uncovered files run afterwards in the same exact workspace/environment. The
 * outer run owns cancellation, evidence and Q3 reuse. */
const program = `
const { spawn } = await import('node:child_process');
const { performance } = await import('node:perf_hooks');
const { command, tests, runner, unavailable, junit } = JSON.parse(process.argv[1]);
const runnerArgs = file => { const at = runner.indexOf(${JSON.stringify(FILES_PLACEHOLDER)}); return at < 0 ? [...runner, file] : [...runner.slice(0, at), file, ...runner.slice(at + 1)]; };
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
if (process.env.FORGE_JUNIT_DIR && junit) {
  try {
    const fs = await import('node:fs'), path = await import('node:path'), zlib = await import('node:zlib');
    const { JunitReader } = await import('data:text/javascript;base64,' + zlib.gunzipSync(Buffer.from(junit.module, 'base64')).toString('base64'));
    const found = new Map();
    let budget = junit.totalBytes;
    for (const name of fs.readdirSync(process.env.FORGE_JUNIT_DIR).filter(name => name.endsWith('.xml')).sort().slice(0, junit.files)) {
      try {
        const file = path.join(process.env.FORGE_JUNIT_DIR, name), info = fs.lstatSync(file);
        if (!info.isFile() || info.size > Math.min(junit.fileBytes, budget)) continue;
        budget -= info.size;
        const reader = new JunitReader(process.cwd());
        reader.accept(fs.readFileSync(file, 'utf8'));
        for (const report of reader.finish() ?? []) found.set(report.file, (found.get(report.file) ?? 0) + report.counts.failed);
      } catch {}
    }
    for (const [file, failed] of found) if (!covered.has(file)) { covered.add(file); if (failed) failedReports.add(file); }
  } catch {}
}
if (tests.some(test => failedReports.has(test))) code = code || 1;
const missing = tests.filter(test => !covered.has(test));
let next = 0;
await Promise.all(Array.from({length: Math.min(2, missing.length)}, async () => {
  while (next < missing.length) {
    const file = missing[next++], start = performance.now();
    const status = runner === undefined
      ? await execute([process.execPath, '--test', '--test-concurrency=2', '--test-timeout=90000', file])
      : runner === null
        ? (process.stderr.write('SEMANTIC_TESTS_UNAVAILABLE: ' + file + ': ' + unavailable + '\\n'), 2)
        : !Array.isArray(runner) && !Array.isArray(runner[file])
          ? (process.stderr.write('SEMANTIC_TESTS_UNAVAILABLE: ' + file + ': no runner command for this test\\n'), 2)
          : await execute(Array.isArray(runner) ? runnerArgs(file) : runner[file]);
    const durationMs = performance.now() - start;
    process.stdout.write('__FORGE_TESTS__' + JSON.stringify({file, complete:status === 0 || status === 1, durationMs, results:[{name:file, passed:status === 0}]}) + '\\n');
    if (status !== 0) code = code || status;
  }
}));
process.exitCode = code;
`;
let junitPayload: { module: string } | undefined | null;
/** The JUnit parser as the check's runner can load it: the compiled module, compressed. Undefined when
 * it cannot be read (then only Forge's own markers count, as before). */
function junitParser() {
  if (junitPayload === undefined) {
    try {
      const source = readFileSync(new URL('./junit-report.js', import.meta.url), 'utf8').replace(
        /^\/\/# sourceMappingURL=.*$/m,
        '',
      );
      junitPayload = { module: gzipSync(source).toString('base64') };
    } catch {
      junitPayload = null;
    }
  }
  return junitPayload ?? undefined;
}

/** `runner`: the project's test runner at the checked source (src/project-test-runner.ts). Forge's
 * Node layout, or none given, runs uncovered union tests with Node's runner as before; any other
 * runner runs them with its own command; without a runner they fail as unavailable, never with a
 * guessed runner. */
export function semanticCheckCommand(
  command: string[],
  plan?: SemanticPlan,
  node = 'node',
  coveredTests: string[] = [],
  runner?: TestRunnerResolution,
): string[] {
  const covered = new Set(coveredTests);
  const tests = semanticTests(plan).filter(test => !covered.has(test));
  if (!tests.length) return command;
  const project =
    runner?.status === 'unavailable'
      ? { runner: null, unavailable: runner.reason }
      : runner && runner.runner.layout !== 'forge-node'
        ? {
            // A chained script's runner: each file's own argv, from the part whose globs own it.
            runner: runner.runner.parts
              ? Object.fromEntries(tests.map(test => [test, runnerCommand(runner.runner, [test])]))
              : runner.runner.command,
          }
        : {};
  const parser = junitParser();
  const junit = parser
    ? {
        junit: {
          ...parser,
          files: junitLimits.files,
          fileBytes: junitLimits.fileBytes,
          totalBytes: junitLimits.totalBytes,
        },
      }
    : {};
  return [
    node,
    '--input-type=module',
    '--eval',
    program,
    JSON.stringify({ command, tests, ...project, ...junit }),
  ];
}
