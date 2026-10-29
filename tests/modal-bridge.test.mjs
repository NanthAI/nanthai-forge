// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

test('Python bridge verifies hashes, redacts failures and adopts exact execution IDs with a mock SDK', () => {
  const output = execFileSync('python3', ['-B', 'tests/modal-bridge-fixture.py'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(output, '');
});

test('Modal collection detects silent streams, reconnects and requires confirmed termination', () => {
  execFileSync('python3', ['-B', 'tests/modal-collect-fixture.py'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});

test('installed remote worker preserves command failure and streams only safe selected output', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-modal-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'output.bin'), 'synthetic artifact');
  const command = {
    command: [process.execPath, '-e', 'process.exitCode = 7'],
    artifacts: ['output.bin', '../outside'],
  };
  let output;
  try {
    execFileSync(process.execPath, [resolve('scripts/modal-check/worker.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { FORGE_MODAL_COMMAND: JSON.stringify(command) },
    });
    assert.fail('command failure was lost');
  } catch (error) {
    assert.equal(error.status, 7);
    output = error.stdout;
  }
  const events = output
    .trim()
    .split('\n')
    .filter(line => line.startsWith('__FORGE_ARTIFACT__'))
    .map(line => JSON.parse(line.slice('__FORGE_ARTIFACT__'.length)));
  const usage = JSON.parse(
    output
      .trim()
      .split('\n')
      .find(line => line.startsWith('__FORGE_USAGE__'))
      .slice('__FORGE_USAGE__'.length),
  );
  assert.ok(usage.seconds > 0 && Number.isFinite(usage.seconds));
  assert.equal(events[0].kind, 'artifactChunk');
  assert.equal(events[1].sha256, createHash('sha256').update('synthetic artifact').digest('hex'));
  assert.equal(events[2].kind, 'artifactUnavailable');
});

for (const body of ['process.exit(137)', "process.kill(process.pid, 'SIGKILL')"]) {
  test(`remote worker preserves OOM (${body}) without publishing superseded artifacts`, () => {
    assert.throws(
      () =>
        execFileSync(process.execPath, [resolve('scripts/modal-check/worker.mjs')], {
          env: {
            FORGE_MODAL_COMMAND: JSON.stringify({
              command: [process.execPath, '-e', body],
              artifacts: ['unused'],
            }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      error => {
        assert.equal(error.status, 137);
        assert.doesNotMatch(error.stdout.toString(), /__FORGE_ARTIFACT__/);
        assert.match(error.stdout.toString(), /__FORGE_USAGE__/);
        return true;
      },
    );
  });
}
