// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import type { hostedMachineRunnerSchema } from './hosted-check.js';

export type HostedMachineRunner = z.infer<typeof hostedMachineRunnerSchema>;
/** Legacy Mac is a semantic alias only. Never rewrite pinned historic payloads. */
export function isMachineRunner(runner: { provider: string }): runner is HostedMachineRunner {
  return runner.provider === 'mac' || runner.provider === 'self-hosted';
}
export function machineRunnerDescription(runner: HostedMachineRunner) {
  const platform = runner.provider === 'mac' ? { os: 'darwin', arch: 'unknown' } : runner.platform;
  return `runner: self-hosted (${platform ? `${platform.os}/${platform.arch}` : 'platform unrecorded'}, your machine; you pay nothing to Forge)`;
}
