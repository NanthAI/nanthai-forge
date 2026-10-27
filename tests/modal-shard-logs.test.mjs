// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModalShardLogs } from '../dist/modal-shard-logs.js';

for (const exitCode of [1, 137])
  test(`Modal exit ${exitCode} summary retains the failing file and diagnoses only an observed kill`, t => {
    const path = mkdtempSync(join(tmpdir(), 'forge-shard-summary-'));
    t.after(() => rmSync(path, { recursive: true, force: true }));
    const logs = new ModalShardLogs(path, 1);
    logs.register({ kind: 'execution', executionId: 'synthetic', index: 0, attempt: 0 });
    logs.append('synthetic', '# Failed test file: tests/broken.test.mjs\nnot ok 1 - broken\n');
    const summary = logs.failureSummary({
      kind: 'result',
      executions: [{ executionId: 'synthetic', index: 0, attempt: 0, exitCode }],
    });
    assert.match(summary, /Failing tests: tests\/broken.test.mjs/);
    if (exitCode === 137) assert.match(summary, /exit 137\/SIGKILL \(likely OOM\)/);
    else assert.doesNotMatch(summary, /OOM|SIGKILL/);
  });
