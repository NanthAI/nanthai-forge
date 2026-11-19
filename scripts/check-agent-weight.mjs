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
import { moduleInventory, moduleFindings } from './agent-weight-modules.mjs';
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
    const run = args => {
      const child = spawnSync(process.execPath, ['--import', preload, ...args], {
        cwd: temp,
        env,
        encoding: 'utf8',
        timeout: 15_000,
      });
      const line = /FORGE_STARTUP (\{.*\})/.exec(child.stderr ?? '')?.[1];
      if (child.status !== 0 || !line)
        throw new Error('Startup fixture failed or returned incomplete evidence (diagnostics redacted).');
      const sample = JSON.parse(line);
      if (sample.code !== 0) throw new Error('Startup probe failed.');
      return {
        ...sample,
        moduleUrls: JSON.parse(readFileSync(env.FORGE_PROBE_MODULES_FILE, 'utf8')),
        stdout: child.stdout,
      };
    };
    for (const [name, args] of [
      ['version', [join(installed, manifest.bin.nforge), '--version']],
      ['help', [join(installed, manifest.bin.nforge), '--help']],
      ['mcp', [mcpProbe, pathToFileURL(`${installed}/`).href]],
    ]) {
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
export function agentWeightFindings(report, baseline) {
  const cpuCeilings = {},
    exactCeilings = {};
  for (const [name, limit] of Object.entries(baseline.ceilings))
    (name.endsWith('Ms') ? cpuCeilings : exactCeilings)[name] = limit;
  const exact = [
    ...weightFindings(report.actual, { ceilings: exactCeilings }),
    ...agentSurfaceFindings(report, baseline),
  ];
  const cpu = weightFindings(report.actual, { ceilings: cpuCeilings });
  for (const [name, metric] of [
    ['version', 'cliColdStartCpu'],
    ['help', 'cliColdStartCpu'],
    ...Object.keys(agentCommands).map(name => [name, name]),
  ]) {
    const verdict = measurement(
      metric,
      report.samples[name].map(sample => ({ durationMs: sample.cpuMs })),
    );
    if (verdict.status !== 'pass')
      cpu.push(`${name}: exceeds the existing speed-budgets.json CPU ceiling ${verdict.budgetMs} ms.`);
  }
  return { exact, cpu };
}
export function checkAgentWeight(prefix, { measure = measureAgentWeight, log = console.log } = {}) {
  const baseline = readWeightBaseline(root);
  let report = measure(prefix);
  let findings = agentWeightFindings(report, baseline);
  // One in-job repeat for shared-runner CPU noise. Exact weight failures never retry,
  // and both batches retain every unchanged CPU ceiling and five-sample median.
  if (!findings.exact.length && findings.cpu.length) {
    log(
      `Agent weight CPU retry: ${JSON.stringify({ findings: findings.cpu, actual: report.actual, wallMs: report.wallMs })}`,
    );
    report = measure(prefix);
    findings = agentWeightFindings(report, baseline);
  }
  const { packages, samples, moduleInventory: inventories, ...summary } = report;
  log(`Agent weight: ${JSON.stringify(summary)}`);
  if (findings.exact.length || findings.cpu.length)
    // Added modules first: a cut receipt excerpt still names them (ad80e037).
    throw new Error([...moduleFindings(report, baseline), ...findings.exact, ...findings.cpu].join('\n'));
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
