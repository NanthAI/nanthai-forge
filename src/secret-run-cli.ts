// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AGENT_CLIENTS, nearestAgentProcess } from './agent-session.js';
import { ForgeError, invariant } from './errors.js';
import { canonicalRoot } from './root-paths.js';
import { runWithSecrets, type RunSecretProvider } from './secret-run.js';

export const secretRunUsage =
  'nforge run [--root ROOT] [--set development|checks] [--only A,B] [--show] -- COMMAND [ARGS...]';
export function secretRunOptions(args: string[]) {
  const split = args.indexOf('--');
  invariant(split >= 0 && split < args.length - 1, 'BAD_ARGUMENT', `Use ${secretRunUsage}.`);
  let root: string | undefined,
    set: 'development' | 'checks' = 'development',
    only: string[] | undefined,
    show = false;
  const seen = new Set<string>();
  for (let i = 0; i < split; i++) {
    const flag = args[i]!;
    invariant(
      ['--root', '--set', '--only', '--show'].includes(flag) && !seen.has(flag),
      'BAD_ARGUMENT',
      `Use ${secretRunUsage}.`,
    );
    seen.add(flag);
    if (flag === '--show') {
      show = true;
      continue;
    }
    const value = args[++i];
    invariant(i < split && value && !value.startsWith('--'), 'BAD_ARGUMENT', `Use ${secretRunUsage}.`);
    if (flag === '--root') root = value;
    if (flag === '--set') {
      invariant(
        value === 'development' || value === 'checks',
        'BAD_ARGUMENT',
        '--set is development or checks.',
      );
      set = value;
    }
    if (flag === '--only') {
      only = value.split(',');
      invariant(
        only.every(name => /^[A-Z][A-Z0-9_]{0,63}$/.test(name)),
        'BAD_ARGUMENT',
        '--only needs comma-separated secret names.',
      );
    }
  }
  return { root, set, only, show, command: args.slice(split + 1) };
}
/** Discover the containing clone or Lane even when run is called from a subdirectory. */
export function secretRunRoot(from: string) {
  let root = canonicalRoot(from);
  for (;;) {
    if (['hosted-main.json', 'hosted-lane.json'].some(file => existsSync(join(root, '.forge', file))))
      return root;
    const parent = dirname(root);
    if (parent === root)
      throw new ForgeError('FORGE_ROOT_UNAVAILABLE', 'Run from a Forge clone or Lane, or use --root ROOT.');
    root = parent;
  }
}
export async function secretRunCli(args: string[], provider?: RunSecretProvider) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(`${secretRunUsage}\nDevelopment uses the owner device’s verified sealed set.\n`);
    return;
  }
  const input = secretRunOptions(args);
  const source = process.env;
  const agent = Boolean(
    source.FORGE_AGENT_SESSION ||
    source.FORGE_AGENT ||
    source.CLAUDECODE ||
    AGENT_CLIENTS.some(client => client.sessionVariable && source[client.sessionVariable]) ||
    nearestAgentProcess(),
  );
  process.exitCode = await runWithSecrets(
    { ...input, root: secretRunRoot(resolve(input.root ?? '.')) },
    provider ?? (await import('./sealed-run.js')).sealedRunSecrets,
    { source, agent },
  );
}
