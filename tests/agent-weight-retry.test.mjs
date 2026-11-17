// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAgentWeight } from '../scripts/check-agent-weight.mjs';
import { readWeightBaseline } from '../scripts/agent-weight.mjs';
import { childEnv } from '../scripts/child-env.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = readWeightBaseline(root);
const clean = () => ({
  ...structuredClone(baseline.report),
  actual: { ...baseline.ceilings },
  samples: Object.fromEntries(Object.keys(baseline.report.samples).map(name => [name, [{ cpuMs: 0 }]])),
});
const noisy = () => {
  const report = clean();
  report.actual.cliAgentLandCpuMs = 521;
  report.samples.cliAgentLandCpu = Array.from({ length: 5 }, () => ({ cpuMs: 521 }));
  return report;
};

test('a7073c8d: shared-runner CPU-only failure retries once against unchanged budgets', () => {
  const reports = [noisy(), clean()];
  const messages = [];
  const accepted = checkAgentWeight('synthetic', {
    measure: () => reports.shift(),
    log: line => messages.push(line),
  });
  assert.equal(reports.length, 0);
  assert.equal(accepted.actual.cliAgentLandCpuMs, 500);
  assert.match(messages[0], /CPU retry.*521/);
});

test('a7073c8d: a sustained CPU regression still fails after the single in-job retry', () => {
  let attempts = 0;
  assert.throws(
    () => checkAgentWeight('synthetic', { measure: () => (attempts++, noisy()), log() {} }),
    /cliAgentLandCpu.*500/,
  );
  assert.equal(attempts, 2);
});

test('a7073c8d: a real heavy eager import fails the deterministic module guard without retry', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-eager-weight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, 'entry.mjs');
  writeFileSync(
    join(directory, 'heavy.mjs'),
    `export const payload = ${JSON.stringify('x'.repeat(512 * 1024))};`,
  );
  const probe = source => {
    writeFileSync(entry, source);
    const child = spawnSync(
      process.execPath,
      ['--import', join(root, 'scripts/perf/startup-preload.mjs'), entry],
      {
        cwd: directory,
        env: childEnv({ extra: { HOME: directory, TMPDIR: directory } }),
        encoding: 'utf8',
      },
    );
    assert.equal(child.status, 0);
    return JSON.parse(/FORGE_STARTUP (\{.*\})/.exec(child.stderr)[1]);
  };
  const before = probe('console.log("synthetic CLI");');
  const after = probe('import { payload } from "./heavy.mjs"; console.log(payload.length);');
  assert.equal(after.modules - before.modules, 1);
  let attempts = 0;
  assert.throws(
    () =>
      checkAgentWeight('synthetic', {
        measure: () => {
          attempts++;
          const report = clean();
          report.actual.cliAgentLandCpuModules += after.modules - before.modules;
          return report;
        },
        log() {},
      }),
    /cliAgentLandCpuModules: 178, ceiling 177/,
  );
  assert.equal(attempts, 1);
});
