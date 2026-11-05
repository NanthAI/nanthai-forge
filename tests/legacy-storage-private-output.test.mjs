// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { childEnv } from '../scripts/child-env.mjs';
import { parseAudit } from '../scripts/legacy-storage-audit.mjs';
import { parseVerification } from '../scripts/legacy-storage-verify.mjs';
import { parseCleanup } from '../scripts/legacy-storage-cleanup.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
test('every legacy operator rejects evidence at the source root or a child before provider access', () => {
  for (const out of [root, resolve(root, 'private-audit.json')]) {
    assert.throws(
      () => parseAudit(['inventory', '--deployment', 'dev:fixture', '--out', out]),
      /AUDIT_PRIVATE_OUTPUT_REQUIRED/,
    );
    assert.throws(
      () => parseVerification(['--deployment', 'dev:fixture', '--audit', '/missing', '--out', out]),
      /VERIFY_PRIVATE_OUTPUT_REQUIRED/,
    );
    assert.throws(
      () =>
        parseCleanup([
          'dry-run',
          '--deployment',
          'dev:fixture',
          '--audit',
          '/missing',
          '--verification',
          '/missing',
          '--body-coverage',
          '/missing',
          '--out',
          out,
        ]),
      /CLEANUP_PRIVATE_OUTPUT_REQUIRED/,
    );
    for (const [script, code, extra] of [
      ['legacy-storage-closure.mjs', 'CLOSURE_ARGUMENT_INVALID', []],
      ['legacy-storage-bench.mjs', 'BENCH_ARGUMENT_INVALID', ['--candidate', '/missing']],
      ['legacy-storage-attribute.mjs', 'VERIFY_PRIVATE_OUTPUT_REQUIRED', []],
    ]) {
      const r = spawnSync(
        process.execPath,
        ['scripts/' + script, '--deployment', 'dev:fixture', '--audit', '/missing', '--out', out, ...extra],
        { cwd: root, env: childEnv(), encoding: 'utf8' },
      );
      assert.equal(r.status, 1, script);
      assert.equal(JSON.parse(r.stderr.trim()).error.code, code, script);
    }
  }
  const sibling = root + '-operator-evidence/audit.json';
  assert.equal(
    parseVerification(['--deployment', 'dev:fixture', '--audit', '/missing', '--out', sibling]).out,
    sibling,
  );
});
