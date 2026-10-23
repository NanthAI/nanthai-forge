// SPDX-License-Identifier: Apache-2.0
// Supervise whole files, including module loading, teardown and leaked child handles.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { coverageMarker, v8Touched } from './test-coverage.mjs';
import { workerBudget } from '../tests/worker-budget.mjs';

export function fileTimeout(env = process.env) {
  const value = env.FORGE_TEST_FILE_TIMEOUT_MS ?? '600000';
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647)
    throw new Error('FORGE_TEST_FILE_TIMEOUT_MS must be a positive integer up to 2147483647.');
  return Number(value);
}

export async function runFiles(files, { workers = workerBudget(), timeoutMs = fileTimeout() } = {}) {
  const totals = Object.fromEntries(
    ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(k => [k, 0]),
  );
  const coverageHead = process.env.FORGE_TEST_COVERAGE_HEAD;
  let coverageFiles = null;
  if (coverageHead) {
    try {
      const { sourceFiles } = await import('./test-impact.mjs');
      coverageFiles = sourceFiles();
    } catch {
      process.stdout.write(
        '# Coverage unavailable: source inventory could not be read; graph selection remains active.\n',
      );
    }
  }
  let next = 0,
    failed = false;
  const children = new Set();
  function kill(child) {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill('SIGKILL');
    }
  }
  const stop = () => {
    failed = true;
    next = files.length;
    for (const child of children) kill(child);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  async function runFile(file) {
    return new Promise(resolve => {
      const started = performance.now();
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      let coverageDirectory = null;
      if (coverageFiles) {
        try {
          coverageDirectory = mkdtempSync(join(tmpdir(), 'forge-v8-'));
        } catch {
          process.stdout.write(
            `# Coverage unavailable for ${file}: temporary storage could not be prepared.\n`,
          );
        }
      }
      if (coverageDirectory) childEnv.NODE_V8_COVERAGE = coverageDirectory;
      const child = spawn(
        process.execPath,
        [
          '--import',
          fileURLToPath(new URL('../tests/check-runtime.mjs', import.meta.url)),
          '--test',
          '--test-reporter=tap',
          file,
        ],
        { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
      );
      children.add(child);
      const results = [],
        diagnostics = [];
      const headings = new Map();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        process.stdout.write(`not ok - ${file}: exceeded per-file timeout (${timeoutMs}ms)\n`);
        // Kill descendants too: an MCP child may be holding a pipe open after tests finish.
        totals.tests++;
        totals.fail++;
        kill(child);
      }, timeoutMs);
      for (const stream of [child.stdout, child.stderr]) {
        createInterface({ input: stream }).on('line', line => {
          if (process.env.FORGE_TEST_DIAGNOSTICS === '1') diagnostics.push(line);
          const heading = /^(\s*)# Subtest: (.*)$/.exec(line);
          if (heading) {
            const depth = heading[1].length;
            for (const key of headings.keys()) if (key >= depth) headings.delete(key);
            headings.set(depth, heading[2]);
          }
          const result = /^(\s*)(ok|not ok) (?:\d+ - | - )?(.+?)(?: # (?:SKIP|TODO).*)?$/.exec(line);
          if (result && !/ # (?:SKIP|TODO)/.test(line)) {
            const parents = [...headings]
              .filter(([depth]) => depth < result[1].length)
              .map(([, name]) => name);
            results.push({ name: [...parents, result[3]].join(' > '), passed: result[2] === 'ok' });
          }
          const summary = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
          if (summary) totals[summary[1]] += Number(summary[2]);
          else process.stdout.write(`${line}\n`);
        });
      }
      child.once('error', error => {
        process.stdout.write(`not ok - ${file}: ${error.message}\n`);
      });
      child.once('close', code => {
        const durationMs = performance.now() - started;
        if (coverageDirectory) {
          try {
            const touched = v8Touched(coverageDirectory, coverageFiles);
            process.stdout.write(
              `${coverageMarker}${JSON.stringify({ version: 1, head: coverageHead, test: file, complete: code === 0 && !timedOut, touched })}\n`,
            );
          } catch {
            process.stdout.write(
              `${coverageMarker}${JSON.stringify({ version: 1, head: coverageHead, test: file, complete: false })}\n`,
            );
          } finally {
            try {
              rmSync(coverageDirectory, { recursive: true, force: true });
            } catch {
              process.stdout.write(`# Coverage temporary files retained for ${file}.\n`);
            }
          }
        }
        clearTimeout(timer);
        children.delete(child);
        if (code !== 0 || timedOut) {
          failed = true;
          process.stdout.write(`# Failed test file: ${file}\n`);
          if (process.env.FORGE_TEST_DIAGNOSTICS === '1')
            process.stdout.write(
              `__FORGE_TEST_FAILURE__${JSON.stringify({ file, output: diagnostics.join('\n') })}\n`,
            );
        }
        if (process.env.FORGE_TEST_EVENTS === '1')
          process.stdout.write(
            `__FORGE_TESTS__${JSON.stringify({ file, results, durationMs, complete: !timedOut && (code === 0 || results.some(item => !item.passed)) })}\n`,
          );
        resolve();
      });
    });
  }
  await Promise.all(
    Array.from({ length: Math.min(workers, files.length) }, async () => {
      while (next < files.length) await runFile(files[next++]);
    }),
  );
  process.off('SIGTERM', stop);
  process.off('SIGINT', stop);
  for (const [name, count] of Object.entries(totals)) process.stdout.write(`# ${name} ${count}\n`);
  return !failed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = (await runFiles(process.argv.slice(2))) ? 0 : 1;
