import { checkLogsCli } from './check-logs-cli.js';
// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { coordinationClient } from './coordination-client.js';
import { WorkStore } from './work-store.js';
import { requireHostedBinding } from './host-binding.js';
import { invariant } from './errors.js';
import { runR2Backfill } from './r2-backfill.js';
import type { BackfillCheck, BackfillPage, BackfillTarget, BackfillTransport } from './r2-backfill-types.js';
export const MAINTENANCE_HELP = `nforge maintenance check-logs ROOT --dry-run|--apply --plan FILE [--hosted]
nforge maintenance r2-backfill ROOT [--dry-run|--verify [--full-digest]] [--resume] [--state FILE]
nforge maintenance r2-backfill DEPLOYMENT PROJECT_ID [--dry-run|--verify [--full-digest]] [--resume] [--state FILE]
Run with the existing owner login or FORGE_AUTH_TOKEN. New bytes already go to R2; this moves legacy Convex copies.
Dry-run reads counts/bytes only, including Convex copies already in R2 that cleanup could delete. Run streams through private local files; resume uses the original state file.
Verify HEAD-checks every backfilled row and downloads a SHA-256 sample (first, then every 100th row).
Add --full-digest to download and verify every migrated object, with the same paged resume state.
No Convex files are deleted. A full verified pass reports a date 14 days later; purge is separate.
`;
export async function maintenanceCli(args: string[]) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(MAINTENANCE_HELP);
    return;
  }
  if (args[0] === 'check-logs') return checkLogsCli(args.slice(1));
  invariant(args.shift() === 'r2-backfill', 'BAD_ARGUMENT', 'Use maintenance r2-backfill.');
  const positional: string[] = [];
  let statePath: string | undefined;
  let dryRun = false,
    verify = false,
    fullDigest = false,
    resume = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i]!;
    if (option === '--dry-run') dryRun = true;
    else if (option === '--verify') verify = true;
    else if (option === '--full-digest') fullDigest = true;
    else if (option === '--resume') resume = true;
    else if (option === '--state') {
      statePath = args[++i];
      invariant(statePath && !statePath.startsWith('--'), 'BAD_ARGUMENT', 'Supply --state FILE.');
    } else {
      invariant(!option.startsWith('--'), 'BAD_ARGUMENT', 'Unknown maintenance option.');
      positional.push(option);
    }
  }
  invariant(
    positional.length >= 1 &&
      positional.length <= 2 &&
      !(dryRun && (verify || resume)) &&
      (!fullDigest || verify),
    'BAD_ARGUMENT',
    MAINTENANCE_HELP,
  );
  const binding =
    positional.length === 1
      ? requireHostedBinding(new WorkStore(positional[0]!))
      : { deployment: positional[0]!, projectId: positional[1]! };
  const { deployment, projectId } = binding,
    client = coordinationClient(deployment, process.env.FORGE_AUTH_TOKEN);
  const transport: BackfillTransport = {
    page: (kind, cursor, verify) =>
      client.query(makeFunctionReference<'query'>('projectR2Backfill:page'), {
        projectId,
        kind,
        cursor,
        verify,
      }) as Promise<BackfillPage>,
    targets: pins =>
      client.mutation(makeFunctionReference<'mutation'>('projectR2Backfill:targets'), {
        projectId,
        pins,
      }) as Promise<BackfillTarget[]>,
    check: (pins, operationId, commit) =>
      client.action(makeFunctionReference<'action'>('projectR2BackfillActions:check'), {
        projectId,
        pins,
        operationId,
        commit,
      }) as Promise<BackfillCheck[]>,
  };
  const project = JSON.stringify([deployment, projectId]);
  statePath ??= resolve(
    `forge-r2-${createHash('sha256').update(project).digest('hex').slice(0, 16)}-${fullDigest ? 'full-digest' : verify ? 'verify' : 'backfill'}.json`,
  );
  return runR2Backfill(transport, {
    project,
    statePath,
    dryRun,
    verify,
    fullDigest,
    resume,
    progress: line => process.stderr.write(line + '\n'),
  });
}
