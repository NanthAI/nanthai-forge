// SPDX-License-Identifier: Apache-2.0
// Reuses package-smoke's packed, offline installation; never installs a second dependency tree in CI.
import { spawnSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  moduleInventory,
  moduleFindings,
  startupSample,
  agentCeilingFindings,
} from './agent-weight-modules.mjs';
import { childEnv } from './child-env.mjs';
import { agentCommands, firstNetworkSamples } from './perf/cli-first-network.mjs';
import { measurement } from './perf/report.mjs';
import { agentActionNames } from './check-growth.mjs';
import { lifecycleVerbs } from './agent-verb-forms.mjs';
import {
  agentSurfaceFindings,
  installedWeight,
  webOnlyPackages,
  baselineHash,
  readWeightBaseline,
  weightFindings,
} from './agent-weight.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Runner-speed calibration (10fbb67b): a fixed synthetic ESM graph that shares no code with Forge,
 * loaded like the CLI paths (fresh process, warm compile cache). A slow or loaded runner raises it and
 * the CLI samples alike; a CLI regression raises the CLI samples alone. */
function writeCalibrationGraph(directory) {
  mkdirSync(directory);
  for (let m = 0; m < 100; m++) {
    let source = m
      ? `import { v${m - 1} } from './m${m - 1}.mjs';\nconst base = v${m - 1};\n`
      : 'const base = 0;\n';
    for (let f = 0; f < 60; f++)
      source += `export function f${f}(a, b = ${f}) { const o = { k: a, n: [b, a, 's${m}_${f}'], m: new Map([[a, b]]) }; return o.n[0] + String(a).length + o.n[2].length + o.m.size; }\n`;
    source += `const table = {};\nfor (let i = 0; i < 60; i++) table['k' + i] = { i, s: String(i).padStart(4, '0') };\n`;
    source += `export const v${m} = base + f0(${m}) + Object.keys(table).length;\n`;
    writeFileSync(join(directory, `m${m}.mjs`), source);
  }
  const entry = join(directory, 'entry.mjs');
  writeFileSync(
    entry,
    `import { v99 } from './m99.mjs';\nif (!Number.isFinite(v99)) process.exitCode = 1;\n`,
  );
  return entry;
}
export function measureAgentWeight(prefix, count = 5, enforceBoundary = true) {
  const started = performance.now();
  const installed = join(prefix, 'node_modules/@nanthai/forge');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const boundary = Object.keys(manifest.dependencies).sort();
  const installation = installedWeight(prefix);
  for (const name of webOnlyPackages) {
    if (
      enforceBoundary &&
      (boundary.includes(name) || installation.packages.some(pkg => pkg.startsWith(`${name}@`)))
    )
      throw new Error(`Web-only runtime dependency: ${name}`);
  }
  const mcpProbe = join(installed, '.forge-weight-probe.mjs');
  copyFileSync(join(root, 'scripts/perf/mcp-startup.mjs'), mcpProbe, constants.COPYFILE_EXCL);
  const temp = mkdtempSync(join(tmpdir(), 'forge-weight-'));
  const actual = { installedBytes: installation.bytes };
  const samples = {};
  const inventories = {};
  try {
    const env = childEnv({
      extra: {
        HOME: temp,
        USERPROFILE: temp,
        XDG_CONFIG_HOME: temp,
        XDG_STATE_HOME: temp,
        XDG_CACHE_HOME: temp,
        TMPDIR: temp,
        NODE_COMPILE_CACHE: join(temp, 'compile-cache'),
        FORGE_PROBE_MODULES_FILE: join(temp, 'modules.json'),
      },
    });
    const preload = join(root, 'scripts/perf/startup-preload.mjs');
    const run = (args, runEnv = env) => {
      const child = spawnSync(process.execPath, ['--import', preload, ...args], {
        cwd: temp,
        env: runEnv,
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (child.status !== 0)
        throw new Error('Startup fixture failed or returned incomplete evidence (diagnostics redacted).');
      return startupSample(child, env.FORGE_PROBE_MODULES_FILE);
    };
    // One calibration sample before each measured batch, so the calibration sees the same load. Its own
    // compile cache keeps it independent of how many Forge modules the other batches cached.
    const calibrationEntry = writeCalibrationGraph(join(temp, 'calibration'));
    const calibrationEnv = { ...env, NODE_COMPILE_CACHE: join(temp, 'calibration-cache') };
    run([calibrationEntry], calibrationEnv);
    const calibration = [];
    const calibrate = () => calibration.push(run([calibrationEntry], calibrationEnv).cpuMs);
    for (const [name, args] of [
      ['version', [join(installed, manifest.bin.nforge), '--version']],
      ['help', [join(installed, manifest.bin.nforge), '--help']],
      ['mcp', [mcpProbe, pathToFileURL(`${installed}/`).href]],
    ]) {
      calibrate();
      run(args); // Warm the compile cache exactly as the installed launcher does.
      const rows = Array.from({ length: count }, () => run(args));
      samples[name] = rows.map(s => ({ cpuMs: s.cpuMs, modules: s.modules, maxRssKiB: s.maxRssKiB }));
      actual[`${name}CpuMs`] = median(rows.map(s => s.cpuMs));
      actual[`${name}Modules`] = Math.max(...rows.map(s => s.modules));
      inventories[name] = moduleInventory(
        rows.flatMap(s => s.moduleUrls),
        installed,
      );
      if (name === 'mcp') actual.toolListBytes = JSON.parse(rows[0].stdout).toolListBytes;
    }
    for (const name of Object.keys(agentCommands)) {
      calibrate();
      const rows = firstNetworkSamples(count, name, { modules: true });
      if (rows.some(s => !Number.isFinite(s.durationMs)))
        throw new Error(`${name} did not reach the network boundary.`);
      samples[name] = rows.map(s => ({
        cpuMs: s.durationMs,
        modules: s.modules.length,
        maxRssKiB: s.maxRssKiB,
      }));
      actual[`${name}Ms`] = median(rows.map(s => s.durationMs));
      actual[`${name}Modules`] = Math.max(...rows.map(s => s.modules.length));
      inventories[name] = moduleInventory(
        rows.flatMap(s => s.modules),
        root,
      );
    }
    samples.calibration = calibration.map(cpuMs => ({ cpuMs }));
    actual.calibrationCpuMs = median([...calibration]);
    return {
      actual,
      samples,
      moduleInventory: inventories,
      boundary,
      agentActions: [
        ...agentActionNames(readFileSync(join(root, 'src/agent-verbs.ts'), 'utf8'), lifecycleVerbs),
      ].sort(),
      packages: installation.packages,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      peakChildRssKiB: Math.max(
        ...Object.values(samples)
          .flat()
          .map(s => s.maxRssKiB ?? 0),
      ),
      wallMs: Math.round(performance.now() - started),
      maxRssKiB: process.resourceUsage().maxRSS,
    };
  } finally {
    rmSync(mcpProbe, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
/** How much slower this runner is than the one the CPU ceilings were set on: this job's calibration
 * median over the baseline's reference, never below 1 (a fast runner keeps the absolute ceilings).
 * Without both numbers the scale is 1, as strict as an unscaled check. */
function runnerScale(report, baseline) {
  const measured = report.actual.calibrationCpuMs,
    reference = baseline.calibration?.cpuMs;
  return measured > 0 && reference > 0 ? Math.max(1, measured / reference) : 1;
}
const atReference = (value, scale) =>
  Number.isFinite(value) ? Math.round((value / scale) * 1000) / 1000 : value;

export function agentWeightFindings(report, baseline) {
  const cpuCeilings = Object.fromEntries(
    Object.entries(baseline.ceilings).filter(([name]) => name.endsWith('Ms')),
  );
  const exact = [...agentCeilingFindings(report.actual, baseline), ...agentSurfaceFindings(report, baseline)];
  // CPU is judged at reference-runner speed: every CPU number divided by the runner scale.
  const scale = runnerScale(report, baseline);
  const cpu = weightFindings(
    Object.fromEntries(Object.keys(cpuCeilings).map(name => [name, atReference(report.actual[name], scale)])),
    { ceilings: cpuCeilings },
  );
  for (const [name, metric] of [
    ['version', 'cliColdStartCpu'],
    ['help', 'cliColdStartCpu'],
    ...Object.keys(agentCommands).map(name => [name, name]),
  ]) {
    const verdict = measurement(
      metric,
      report.samples[name].map(sample => ({ durationMs: atReference(sample.cpuMs, scale) })),
    );
    if (verdict.status !== 'pass')
      cpu.push(`${name}: exceeds the existing speed-budgets.json CPU ceiling ${verdict.budgetMs} ms.`);
  }
  if (cpu.length)
    cpu.push(
      `CPU judged at reference speed: runner scale ${scale.toFixed(3)} (calibration ${report.actual.calibrationCpuMs ?? 'missing'} ms, reference ${baseline.calibration?.cpuMs ?? 'missing'} ms).`,
    );
  return { exact, cpu, scale };
}
export function checkAgentWeight(prefix, { measure = measureAgentWeight, log = console.log } = {}) {
  const baseline = readWeightBaseline(root);
  const report = measure(prefix);
  const findings = agentWeightFindings(report, baseline);
  const { packages, samples, moduleInventory: inventories, ...summary } = report;
  log(`Agent weight: ${JSON.stringify({ ...summary, runnerScale: findings.scale })}`);
  if (findings.exact.length || findings.cpu.length)
    // Added modules first: a cut receipt excerpt still names them (ad80e037).
    throw new Error([...moduleFindings(report, baseline), ...findings.exact, ...findings.cpu].join('\n'));
  const { cliAgentLandCpuMs, calibrationCpuMs, versionCpuMs } = report.actual;
  const ms = value => (Number.isFinite(value) ? value.toFixed(3) : 'n/a');
  log(
    `Agent weight summary: land CPU ${ms(cliAgentLandCpuMs)} ms, calibration ${ms(calibrationCpuMs)} ms, scaled ${ms(atReference(cliAgentLandCpuMs, findings.scale))} ms, version CPU ${ms(versionCpuMs)} ms`,
  );
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [prefix, mode, ...reasonWords] = process.argv.slice(2);
  if (!prefix || (mode && !['--measure', '--record'].includes(mode)))
    throw new Error('Use check-agent-weight.mjs PREFIX [--measure | --record REASON including Issue id].');
  if (mode === '--record') {
    const reason = reasonWords.join(' '),
      issue = /\b[0-9a-f]{8}\b/.exec(reason)?.[0];
    if (!issue || reason.length < 20)
      throw new Error('A baseline change needs measurements, a reason and an Issue.');
    const report = measureAgentWeight(resolve(prefix));
    const old = readWeightBaseline(root);
    // Recording preserves ceilings. Raising any one is an explicit, reviewed baseline edit, not an automatic ratchet reset.
    const baseline = { ...old, report };
    writeFileSync(join(root, 'tests/agent-weight-baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
    mkdirSync(join(root, 'tests/agent-weight-ledger'), { recursive: true });
    writeFileSync(
      join(root, 'tests/agent-weight-ledger', `${baselineHash(baseline)}.json`),
      `${JSON.stringify({ issue, reason }, null, 2)}\n`,
    );
    console.log(JSON.stringify(report));
  } else if (mode === '--measure') console.log(JSON.stringify(measureAgentWeight(resolve(prefix), 5, false)));
  else checkAgentWeight(resolve(prefix));
}
