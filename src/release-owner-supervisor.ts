// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { childEnv } from '../scripts/child-env.mjs';
import { belowRuntime } from './release-owner-processes.js';
import { invariant } from './errors.js';

export type OwnerService = { id: string; cli: string };
export type OwnerSupervisor = {
  discover(owner: string, runtimeDirectory: string): Promise<OwnerService | undefined>;
  pid(service: OwnerService): Promise<number | undefined>;
  restart(service: OwnerService): Promise<void>;
};
const options = {
  encoding: 'utf8' as const,
  timeout: 10_000,
  env: childEnv(),
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
};
/** Never retain launchctl output: it can include environment values. */
export function parseOwnerService(output: string, owner: string, runtimeDirectory: string) {
  const body = /\n\s*arguments = \{\n([\s\S]*?)\n\s*\}/.exec(output)?.[1];
  const args = body?.split('\n').map(line => line.trim());
  if (!args || args[2] !== 'serve' || !args[3]) return;
  if (realpathSync(args[3]) !== realpathSync(owner)) return;
  const cli = args[1];
  invariant(
    cli && (belowRuntime(runtimeDirectory, cli) || belowRuntime(realpathSync(runtimeDirectory), cli)),
    'RELEASE_OWNER_PATH',
    'Supervised owner entry point is outside the runtime directory.',
  );
  return cli;
}
export function launchdOwnerSupervisor(): OwnerSupervisor {
  const id = `gui/${process.getuid?.()}/com.nanthai.forge-owner`;
  const print = () => execFileSync('/bin/launchctl', ['print', id], options);
  return {
    async discover(owner, root) {
      if (process.platform !== 'darwin') return;
      let output: string;
      try {
        output = print();
      } catch (error) {
        // launchctl's documented missing-service result. Other failures are not absence.
        if ((error as { status?: number }).status === 113) return;
        throw error;
      }
      const cli = parseOwnerService(output, owner, root);
      return cli ? { id, cli } : undefined;
    },
    async pid() {
      const value = /\n\s*pid = (\d+)\s*\n/.exec(print())?.[1];
      return value ? Number(value) : undefined;
    },
    async restart() {
      execFileSync('/bin/launchctl', ['kickstart', '-k', id], options);
    },
  };
}
