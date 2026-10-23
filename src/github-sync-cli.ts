// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { githubSync } from './github-sync.js';
export async function githubSyncCli(args: string[]) {
  const usage =
    'Use github-sync ROOT [--repo OWNER/NAME] [--branch main] [--dry-run | --push] [--operation-id UUID] [--rebind] [--wait-audit] [--audit-timeout-ms MS].';
  const root = args[0];
  invariant(root && !root.startsWith('--'), 'BAD_ARGUMENT', usage);
  const options: Parameters<typeof githubSync>[1] = {};
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    invariant(!seen.has(flag), 'BAD_ARGUMENT', usage);
    seen.add(flag);
    if (flag === '--dry-run' || flag === '--push') options.push = flag === '--push';
    else if (flag === '--wait-audit') options.waitAudit = true;
    else if (flag === '--rebind') options.rebind = true;
    else {
      invariant(
        ['--repo', '--branch', '--operation-id', '--audit-timeout-ms'].includes(flag) &&
          args[i + 1] &&
          !args[i + 1]!.startsWith('--'),
        'BAD_ARGUMENT',
        usage,
      );
      const value = args[++i]!;
      if (flag === '--repo') options.repository = value;
      else if (flag === '--branch') options.branch = value;
      else if (flag === '--audit-timeout-ms') {
        invariant(/^\d+$/.test(value) && Number.isSafeInteger(Number(value)), 'BAD_ARGUMENT', usage);
        options.auditTimeoutMs = Number(value);
      } else options.operationId = value;
    }
  }
  invariant(!(seen.has('--dry-run') && seen.has('--push')), 'BAD_ARGUMENT', usage);
  invariant(!options.waitAudit || options.push, 'BAD_ARGUMENT', '--wait-audit requires --push.');
  return githubSync(root, options);
}
