// SPDX-License-Identifier: Apache-2.0
// Issue 58236de6: a failed static step names itself, its reproduction and its first error
// in the 4 KiB tail the hosted job keeps, so CHECK_FAILED never says only `FAIL 4.8s check`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkFailureDetail, CHECK_FAILED_NEXT } from '../dist/check-failure-detail.js';
import { failingStep } from '../dist/hosted-landing-suspect.js';
import { landSummary } from '../dist/hosted-land-summary.js';

const fakeToken = 'sk_live_abcdefghijklmnop1234';
const failures = {
  // The exact 2026-11-06 shape: npm's `check` step runs check-foundation, which rejected a machine path.
  foundation: {
    step: 'check',
    command: /^npm run check \(node scripts\/check-foundation\.mjs\)$/,
    error: /ERROR: tests\/fixture\.mjs: machine-specific home path/,
  },
  lint: { step: 'lint (oxlint)', command: /^node scripts\/oxc\.mjs lint$/, error: /no-unused-vars/ },
  format: {
    step: 'format:check (oxfmt)',
    command: /^node scripts\/oxc\.mjs format:check$/,
    error: /src\/a\.ts is not formatted/,
  },
  documents: {
    step: 'documents',
    command: /^node scripts\/check-documents\.mjs$/,
    error: /AssertionError \[ERR_ASSERTION\]: Unlisted packaged document: docs\/research\/b15d-report\.md/,
  },
};

for (const [name, expected] of Object.entries(failures)) {
  test(`a failed ${name} step names itself, its reproduction and first error in the log tail`, t => {
    const root = mkdtempSync(join(tmpdir(), 'forge-verify-digest-'));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const write = (path, text) => writeFileSync(join(root, path), text);
    for (const directory of [
      'scripts',
      'tests',
      'convex',
      'node_modules/typescript/bin',
      'node_modules/@typescript/native/bin',
    ])
      mkdirSync(join(root, directory), { recursive: true });
    for (const file of [
      'verify.mjs',
      'verify-queue.mjs',
      'verify-failure-digest.mjs',
      'selection-guard.mjs',
      'check-contract.mjs',
      'prepare-convex-api.mjs',
    ])
      write(`scripts/${file}`, readFileSync(`scripts/${file}`));
    const pass = 'process.exit(0);';
    write(
      'scripts/check-foundation.mjs',
      name === 'foundation'
        ? `console.error('ERROR: tests/fixture.mjs: machine-specific home path /home/runner token=${fakeToken}'); process.exitCode = 1;`
        : pass,
    );
    write('scripts/check-schema-compat.mjs', pass);
    write('scripts/check-convex-runtime.mjs', pass);
    write(
      'scripts/check-documents.mjs',
      name === 'documents'
        ? `import assert from 'node:assert/strict'; assert.ok(false, 'Unlisted packaged document: docs/research/b15d-report.md. Add its manifest under scripts/package-documents/.');`
        : pass,
    );
    write(
      'scripts/oxc.mjs',
      `const [mode] = process.argv.slice(2);
      if (mode === ${JSON.stringify(name === 'lint' ? 'lint' : name === 'format' ? 'format:check' : 'never')}) {
        console.error(${JSON.stringify(name === 'lint' ? 'x no-unused-vars: src/a.ts:3:7 unused' : 'src/a.ts is not formatted')});
        process.exitCode = 1;
      }`,
    );
    write('scripts/package-smoke.mjs', pass);
    write('tests/worker-budget.mjs', 'export const workerBudget = () => 2;');
    write('tests/placeholder.test.mjs', '');
    write(
      'scripts/test-files.mjs',
      'export const fileTimeout = () => 1000; if (process.argv[1].endsWith("test-files.mjs")) process.exitCode = 0;',
    );
    write(
      'package.json',
      JSON.stringify({
        type: 'module',
        scripts: {
          'build:core': 'node -e "process.exit(0)"',
          'build:web': 'node -e "process.exit(0)"',
          check: 'node scripts/check-foundation.mjs',
          'smoke:package': 'node scripts/package-smoke.mjs',
        },
      }),
    );
    for (const compiler of ['typescript', '@typescript/native'])
      write(`node_modules/${compiler}/bin/tsc`, pass);
    const result = spawnSync(process.execPath, ['scripts/verify.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        FORGE_STATIC_WORKERS: '2',
        FORGE_SELECTED_TESTS: JSON.stringify({ scope: 'full', tests: ['tests/placeholder.test.mjs'] }),
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const digest = result.stdout.split('\n').filter(line => line.startsWith('[failed-step] '));
    assert.equal(digest.length, 1, `digest rows: ${digest.length}\n${result.stdout}${result.stderr}`);
    const [, step, command, text] = /^\[failed-step\] (.+?) :: (.+?) :: (.*)$/.exec(digest[0]);
    assert.equal(step, expected.step);
    assert.match(command, expected.command);
    assert.match(text, expected.error);
    assert.ok(digest[0].length <= 1500, 'one digest row stays within the budget');

    // The hosted job keeps only the last 4 KiB; the digest must survive it and beat the timings row.
    const tail = result.stdout.slice(-4096);
    const found = failingStep(
      [{ descriptor: JSON.stringify({ shard: 11 }), seal: JSON.stringify({ failureSummary: tail }) }],
      12,
    );
    assert.equal(found.job, 'job 11 (static)');
    assert.ok(found.excerpt.length <= 560);
    assert.doesNotMatch(found.excerpt, /^FAIL /);
    const detail = checkFailureDetail({}, found);
    assert.match(
      detail,
      new RegExp(`^Failing job 11 \\(static\\): ${step.replace(/[()]/g, '\\$&')} \\(reproduce: `),
    );
    assert.match(detail, expected.error);
    assert.doesNotMatch(detail, new RegExp(fakeToken), 'a token-shaped value never reaches the receipt');
    const message = `The original exact check settled as failed. ${detail} ${CHECK_FAILED_NEXT}`;
    const [line] = landSummary({
      result: {
        phase: 'finish',
        submission: { phase: 'terminal-failed', error: { code: 'CHECK_FAILED', message } },
      },
    });
    assert.match(line, /^FAILED CHECK_FAILED: .*\(reproduce: .*land --save again/);
  });
}
