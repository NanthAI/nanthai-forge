// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { WorkStore } from './work-store.js';
import { readImprovements, formatImprovements } from './improve.js';
export function improveCli(args: string[]) {
  if (!args.length || args[0] === '--help') {
    process.stdout.write(
      'nforge improve ROOT [--json]\nTriage: nforge agent ROOT friction-triage \'{"frictionIds":["ID"],"status":"planned","reason":"…"}\'\n',
    );
    return;
  }
  invariant(
    args[0] && (args.length === 1 || (args.length === 2 && args[1] === '--json')),
    'BAD_ARGUMENT',
    'Use improve ROOT [--json].',
  );
  const response = readImprovements(new WorkStore(args[0]));
  if (args[1] === '--json') return response;
  process.stdout.write(formatImprovements(response.result));
}
