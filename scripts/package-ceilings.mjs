// SPDX-License-Identifier: Apache-2.0
// Preflight uses core's existing build for runtime probes and never packs or installs a package.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWeightBaseline } from './agent-weight.mjs';
import {
  agentCeilingFindings,
  moduleFindings,
  moduleInventory,
  startupSample,
} from './agent-weight-modules.mjs';
import { childEnv } from './child-env.mjs';
import { packageProbeProcesses } from './package-probe-process.mjs';
import { packageInstalledBytes } from './package-installed-bytes.mjs';
import { agentCommands, firstNetworkModules } from './perf/cli-first-network.mjs';

const root = realpathSync(process.cwd());
const baseline = readWeightBaseline(root);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function installedByteCheck() {
  const { bytes, exact } = packageInstalledBytes(root, manifest);
  const findings = agentCeilingFindings({ installedBytes: bytes }, baseline, { partial: true });
  if (findings.length) {
    console.error(`Error: ${exact ? '' : 'Installed byte lower bound: '}${findings.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(
      exact
        ? `Package ceilings: {"installedBytes":${bytes}}`
        : `Installed bytes: verified a ${bytes}-byte lower bound; exact count deferred to package smoke.`,
    );
  }
}

const installedNames = new Map([['scripts/perf/mcp-startup.mjs', '.forge-weight-probe.mjs']]);
const installedPath = name =>
  name.startsWith('node_modules/') ? name : `node_modules/@nanthai/forge/${installedNames.get(name) ?? name}`;

async function runtimeCheck() {
  const stage = mkdtempSync(join(tmpdir(), 'forge-package-ceilings-'));
  const processes = packageProbeProcesses();
  try {
    const env = childEnv({
      extra: {
        HOME: stage,
        USERPROFILE: stage,
        XDG_CONFIG_HOME: stage,
        XDG_CACHE_HOME: stage,
        XDG_STATE_HOME: stage,
        TMPDIR: stage,
      },
    });
    const perf = join(root, 'scripts/perf');
    const cli = join(root, manifest.bin.nforge);
    const actual = {};
    const inventory = {};
    async function startup(name, args) {
      const file = join(stage, `${name}-modules.json`);
      const sample = startupSample(
        await processes.run(['--import', join(perf, 'startup-preload.mjs'), ...args], {
          cwd: root,
          env: { ...env, FORGE_PROBE_MODULES_FILE: file },
        }),
        file,
      );
      actual[`${name}Modules`] = sample.modules;
      inventory[name] = moduleInventory(sample.moduleUrls, root).map(installedPath);
      if (name === 'mcp') actual.toolListBytes = JSON.parse(sample.stdout).toolListBytes;
    }
    const results = await Promise.allSettled([
      startup('version', [cli, '--version']),
      startup('help', [cli, '--help']),
      startup('mcp', [join(perf, 'mcp-startup.mjs'), pathToFileURL(`${root}/`).href]),
      ...Object.keys(agentCommands).map(async name => {
        const modules = await firstNetworkModules(name, cli, processes.run);
        actual[`${name}Modules`] = modules.length;
        inventory[name] = moduleInventory(modules, root);
      }),
    ]);
    if (results.some(result => result.status === 'rejected')) {
      const missing = Object.keys(baseline.ceilings).filter(
        name => (name.endsWith('Modules') || name === 'toolListBytes') && !(name in actual),
      );
      console.error(`Error: package ceilings did not collect ${missing.join(', ')} from the core build.`);
      process.exitCode = 1;
    }
    const findings = agentCeilingFindings(actual, baseline, { partial: true });
    if (findings.length) {
      const failedProbes = Object.fromEntries(
        Object.entries(inventory).filter(([name]) =>
          findings.some(
            line =>
              line.startsWith(`${name}Modules:`) || (name === 'mcp' && line.startsWith('toolListBytes:')),
          ),
        ),
      );
      const modules = moduleFindings({ moduleInventory: failedProbes }, baseline);
      console.error(`Error: ${[...findings, ...modules].join('\n')}`);
      process.exitCode = 1;
    }
    console.log(`Package ceilings: ${JSON.stringify(actual)}`);
    if (process.argv.includes('--inventory'))
      console.log(`Package module inventory: ${JSON.stringify(inventory)}`);
  } finally {
    processes.dispose();
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--installed-bytes') installedByteCheck();
else if (process.argv[2] === '--runtime') await runtimeCheck();
else throw new Error('Use package-ceilings.mjs --runtime or --installed-bytes.');
