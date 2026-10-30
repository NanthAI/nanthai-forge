// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

for (const flaky of [false, true])
  test(`verify streams a ${flaky ? 'flaky' : 'failed'} file diagnostic while another file is still running`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'forge-verify-stream-'));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const write = (path, text) => writeFileSync(join(root, path), text);
    for (const dir of [
      'scripts',
      'tests',
      'convex',
      'node_modules/typescript/bin',
      'node_modules/@typescript/native/bin',
    ])
      mkdirSync(join(root, dir), { recursive: true });
    for (const name of [
      'verify.mjs',
      'verify-queue.mjs',
      'test-files.mjs',
      'test-coverage.mjs',
      'prepare-convex-api.mjs',
    ])
      write(`scripts/${name}`, readFileSync(`scripts/${name}`));
    write('scripts/oxc.mjs', '');
    write('scripts/check-schema-compat.mjs', '');
    write('scripts/check-documents.mjs', '');
    write('tests/worker-budget.mjs', 'export const workerBudget = () => 2;');
    write('tests/check-runtime.mjs', '');
    write('node_modules/typescript/bin/tsc', '');
    write('node_modules/@typescript/native/bin/tsc', '');
    write(
      'package.json',
      JSON.stringify({
        type: 'module',
        scripts: Object.fromEntries(
          ['build:core', 'build:web', 'check', 'format:check', 'lint', 'smoke:package'].map(name => [
            name,
            'node -e ""',
          ]),
        ),
      }),
    );
    write(
      'tests/failure.test.mjs',
      `import test from 'node:test';
    import assert from 'node:assert/strict';
    import { existsSync, writeFileSync } from 'node:fs';
    const retry = existsSync('failed-once');
    writeFileSync('failed-once', '1');
    test('synthetic failure', () => { if (!(${flaky} && retry)) assert.equal('actual diagnostic', 'expected diagnostic'); });`,
    );
    write(
      'tests/held.test.mjs',
      `import test from 'node:test';
    import { existsSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    test('held until parent releases', async () => {
      while (!existsSync('release')) await setTimeout(10);
    });`,
    );
    const child = spawn(process.execPath, ['scripts/verify.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        FORGE_STATIC_WORKERS: '2',
        FORGE_TEST_WORKERS: '2',
        FORGE_SELECTED_TESTS: JSON.stringify({
          scope: 'scoped',
          tests: ['tests/failure.test.mjs', 'tests/held.test.mjs'],
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill('SIGKILL'));
    let output = '',
      observed = false;
    let release;
    const diagnostic = new Promise(resolve => {
      release = resolve;
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', chunk => {
        output += chunk;
        if (
          output.includes('expected diagnostic') &&
          output.includes('Failed test file: tests/failure.test.mjs')
        ) {
          observed = true;
          release();
        }
      });
    const closed = new Promise(resolve => child.once('close', code => resolve(code)));
    const deadline = setTimeout(release, 8000);
    await diagnostic;
    clearTimeout(deadline);
    const streamedBeforeRelease = observed;
    write('release', '');
    assert.equal(await closed, flaky ? 0 : 1, output);
    if (flaky) assert.match(output, /\[test\] Flaky test file: tests\/failure.test.mjs/);
    assert.equal(streamedBeforeRelease, true, output);
    assert.match(output, /actual diagnostic/);
    const reports = output
      .split('\n')
      .filter(line => line.startsWith('__FORGE_TESTS__'))
      .map(line => JSON.parse(line.slice('__FORGE_TESTS__'.length)));
    assert.deepEqual(reports.map(report => report.file).sort(), [
      'tests/failure.test.mjs',
      'tests/held.test.mjs',
    ]);
    assert.ok(
      reports.every(report => report.complete && Number.isFinite(report.durationMs) && report.durationMs > 0),
    );
  });
