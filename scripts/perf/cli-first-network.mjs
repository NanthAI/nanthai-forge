// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** One sample per run: durationMs is the CPU before the first network call (NaN when the run never
 * reached one), with the loaded module count when `modules` is set. A compile cache, as the installed
 * launcher enables for every command, is warmed by one unmeasured run. */
export function firstNetworkSamples(
  count,
  name,
  { cli = join(root, 'dist', 'cli-entry.js'), modules = false } = {},
) {
  const command = agentCommands[name];
  const state = mkdtempSync(join(tmpdir(), 'forge-first-network-'));
  try {
    const env = childEnv({
      extra: {
        FORGE_AUTH_TOKEN: 'probe-not-a-token',
        HOME: state,
        XDG_STATE_HOME: state,
        XDG_CONFIG_HOME: state,
        XDG_CACHE_HOME: state,
        NODE_COMPILE_CACHE: join(state, 'compile-cache'),
        ...(modules ? { FORGE_PROBE_MODULES: '1' } : {}),
      },
    });
    const run = () =>
      spawnSync(
        process.execPath,
        [
          '--import',
          preload,
          cli,
          'agent',
          state,
          ...command.args,
          JSON.stringify({ url: PROBE, projectId: 'probe', ...command.input }),
        ],
        { encoding: 'utf8', env, timeout: 60_000, cwd: root },
      );
    run();
    return Array.from({ length: count }, () => {
      const child = run();
      const line = /FORGE_FIRST_NETWORK (\{.*\})/.exec(child.stderr ?? '')?.[1];
      const seen = line ? JSON.parse(line) : null;
      return {
        durationMs: seen && child.status === 0 ? seen.cpuMs : NaN,
        ...(seen ? { reason: seen.reason } : {}),
        ...(seen?.modules ? { modules: seen.modules.filter(url => url.startsWith('file:')) } : {}),
      };
    });
  } finally {
    for (const path of [state, `${state}.forge-client`, `${state}.forge-metrics.jsonl`])
      rmSync(path, { recursive: true, force: true });
  }
}
