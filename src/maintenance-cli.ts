// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { checkLogsCli } from './check-logs-cli.js';
import { invariant } from './errors.js';

export const MAINTENANCE_HELP = `nforge maintenance check-logs ROOT --dry-run|--apply --plan FILE [--hosted]
Run with the existing owner login or FORGE_AUTH_TOKEN.
`;
export async function maintenanceCli(args: string[]) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(MAINTENANCE_HELP);
    return;
  }
  invariant(args[0] === 'check-logs', 'BAD_ARGUMENT', 'Use maintenance check-logs.');
  return checkLogsCli(args.slice(1));
}
