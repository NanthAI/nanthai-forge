// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../child-env.mjs';

/** CPU an agent command spends before its first network call (Issue 7b2ae8d8). The built CLI runs
 * against an address that never resolves, under a preload that stops it at the first Convex call (or,
 * for land, at the hand-off to its detached submitter) and reports the CPU time (user+sys) and the
 * modules loaded by then. Nothing leaves the machine and no project is read. */
const PROBE = 'https://forge-probe.convex.cloud';
const LANE = '00000000-0000-4000-8000-000000000000';
export const agentCommands = {
  cliAgentStatusCpu: { args: ['status'], input: {} },
  cliAgentPlanningCpu: { args: ['planning'], input: { status: 'open', limit: 5 } },
  cliAgentSaveCpu: { args: ['save'], input: { message: 'probe' } },
  cliAgentLandCpu: { args: ['land', '--save'], input: { laneId: LANE, message: 'probe' } },
};
const preload = fileURLToPath(new URL('./first-network-preload.mjs', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));

/** An inherited temp path can itself sit under a Lane. CLI probes need an independent root,
 * since agent commands intentionally discover an ancestor Lane. */
export function unboundProbeDirectory(prefix) {
  let parent = realpathSync(tmpdir());
  for (let ancestor = parent; dirname(ancestor) !== ancestor; ancestor = dirname(ancestor))
    if (existsSync(join(ancestor, '.forge', 'hosted-lane.json'))) parent = dirname(ancestor);
  return mkdtempSync(join(parent, prefix));
}

function firstNetworkProbe(name, cli, modules, warm) {
  const command = agentCommands[name];
  const state = unboundProbeDirectory('forge-first-network-');
  return {
    args: [
      '--import',
      preload,
      cli,
      'agent',
      state,
      ...command.args,
      JSON.stringify({ url: PROBE, projectId: 'probe', ...command.input }),
    ],
    options: {
      encoding: 'utf8',
      env: childEnv({
        extra: {
          FORGE_AUTH_TOKEN: 'probe-not-a-token',
          FORGE_DEPLOYMENT_URL: PROBE,
          HOME: state,
          XDG_STATE_HOME: state,
          XDG_CONFIG_HOME: state,
          XDG_CACHE_HOME: state,
          ...(warm ? { NODE_COMPILE_CACHE: join(state, 'compile-cache') } : {}),
          ...(modules ? { FORGE_PROBE_MODULES: '1' } : {}),
        },
      }),
      timeout: 60_000,
      cwd: root,
    },
    dispose() {
      for (const path of [state, `${state}.forge-client`, `${state}.forge-metrics.jsonl`])
        rmSync(path, { recursive: true, force: true });
    },
  };
}

function firstNetworkSample(stderr, passed) {
  const line = /FORGE_FIRST_NETWORK (\{.*\})/.exec(stderr ?? '')?.[1];
  const seen = line ? JSON.parse(line) : null;
  return {
    durationMs: seen && passed ? seen.cpuMs : NaN,
    ...(seen ? { reason: seen.reason, maxRssKiB: seen.maxRssKiB } : {}),
    ...(seen?.modules ? { modules: seen.modules.filter(url => url.startsWith('file:')) } : {}),
  };
}

/** One sample per run: durationMs is the CPU before the first network call (NaN when the run never
 * reached one), with the loaded module count when `modules` is set. A compile cache, as the installed
 * launcher enables for every command, is warmed by one unmeasured run. */
export function firstNetworkSamples(
  count,
  name,
  { cli = join(root, 'dist', 'cli-entry.js'), modules = false } = {},
) {
  const { args, options, dispose } = firstNetworkProbe(name, cli, modules, true);
  const run = () => spawnSync(process.execPath, args, options);
  try {
    run();
    return Array.from({ length: count }, () => {
      const child = run();
      return firstNetworkSample(child.stderr, child.status === 0);
    });
  } finally {
    dispose();
  }
}

/** Deterministic loads from one process per command; no warm-up or CPU verdict in preflight. */
export async function firstNetworkModules(name, cli, run) {
  const { args, options, dispose } = firstNetworkProbe(name, cli, true, false);
  try {
    const { stderr } = await run(args, options);
    const sample = firstNetworkSample(stderr, true);
    if (!sample.modules || !Number.isFinite(sample.durationMs))
      throw new Error('Incomplete first-call probe.');
    return sample.modules;
  } finally {
    dispose();
  }
}
