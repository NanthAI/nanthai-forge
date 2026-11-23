// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
  // CPU calibration fixtures vary the measurements. The separate surface tests vary these lists.
  boundary: [...baseline.boundary],
  agentActions: [...baseline.agentActions],
  actual: { ...baseline.ceilings },
  samples: Object.fromEntries(Object.keys(baseline.report.samples).map(name => [name, [{ cpuMs: 0 }]])),
});
// Every CPU number at `speed` times the reference runner, just under its ceiling at reference
// speed; `land` multiplies the land path alone (a real regression). The calibration probe
// measures the runner, so it moves with `speed` and never with `land`.
const runner = ({ speed, land = 1, calibration = speed }) => {
  const report = clean();
  for (const name of Object.keys(baseline.ceilings).filter(name => name.endsWith('Ms')))
    report.actual[name] = baseline.ceilings[name] * 0.95 * speed;
  report.actual.cliAgentLandCpuMs *= land;
  for (const name of Object.keys(report.samples)) {
    const cpuMs = (name.startsWith('cliAgent') ? 470 : 40) * speed * (name === 'cliAgentLandCpu' ? land : 1);
    report.samples[name] = Array.from({ length: 5 }, () => ({ cpuMs }));
  }
  report.actual.calibrationCpuMs = baseline.calibration.cpuMs * calibration;
  return report;
};
const judge = report => {
  let attempts = 0;
  const messages = [];
  const run = () =>
    checkAgentWeight('synthetic', {
      measure: () => (attempts++, report),
      log: line => messages.push(line),
    });
  return { run, attempts: () => attempts, messages };
};

test('10fbb67b: a uniformly slow runner (every CPU sample and the calibration 1.6x) passes unchanged ceilings', () => {
  const slow = judge(runner({ speed: 1.6 }));
  assert.equal(slow.run().actual.cliAgentLandCpuMs, baseline.ceilings.cliAgentLandCpuMs * 0.95 * 1.6);
  assert.equal(slow.attempts(), 1);
  const { runnerScale } = JSON.parse(slow.messages[0].slice('Agent weight: '.length));
  assert.ok(Math.abs(runnerScale - 1.6) < 1e-12);
  assert.equal(
    slow.messages[1],
    `Agent weight summary: land CPU 760.000 ms, calibration ${(baseline.calibration.cpuMs * 1.6).toFixed(3)} ms, scaled 475.000 ms, version CPU ${(baseline.ceilings.versionCpuMs * 0.95 * 1.6).toFixed(3)} ms`,
  );
  assert.ok(Buffer.byteLength(`  ${slow.messages[1]}\n`) <= 200);
});

test('10fbb67b: a land-path CPU regression fails on a reference-speed runner and on a slow one, without retry', () => {
  for (const speed of [1, 1.6]) {
    const regressed = judge(runner({ speed, land: 1.3 }));
    assert.throws(
      regressed.run,
      /cliAgentLandCpuMs: \d+(\.\d+)?, ceiling 500[^]*cliAgentLandCpu: exceeds[^]*runner scale/,
    );
    assert.equal(regressed.attempts(), 1);
  }
});

test('10fbb67b: a fast runner keeps the absolute ceilings; a missing calibration judges unscaled', () => {
  assert.throws(judge(runner({ speed: 1.6, calibration: 0.5 })).run, /runner scale 1\.000/);
  const missing = runner({ speed: 1.6 });
  delete missing.actual.calibrationCpuMs;
  assert.throws(judge(missing).run, /calibration missing ms/);
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

test('ad80e037: an over-ceiling module count names the added module on the first line', () => {
  const report = clean();
  const names = Object.keys(report.moduleInventory);
  for (const name of names)
    report.moduleInventory[name] = [...report.moduleInventory[name], 'dist/new-HASH.js'];
  report.actual.cliAgentLandCpuModules++;
  assert.throws(
    () => checkAgentWeight('synthetic', { measure: () => report, log() {} }),
    error => error.message.split('\n')[0] === `${names.join(', ')}: added modules/chunks: dist/new-HASH.js`,
  );
});
