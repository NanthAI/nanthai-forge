// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { hostedAgentAddressSchema } from './hosted-address.js';
import { readAgentJson } from './hosted-agent-journal.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { ConvexExchange } from './exchange-client.js';
import { mainCheckoutTransport, pullHostedProject } from './hosted-pull.js';
import { invariant } from './errors.js';
export const PULL_HELP =
  'nforge pull ROOT\nRefresh a Forge clone to accepted main; re-run to resume an interrupted refresh.\n';
export async function hostedPullCli(
  args: string[],
  beforeRun?: () => Promise<boolean>,
  beforeLocal?: () => Promise<void>,
) {
  if (args.includes('--help')) {
    await beforeLocal?.();
    process.stdout.write(PULL_HELP);
    return;
  }
  invariant(args.length === 1 && args[0] && !args[0].startsWith('-'), 'BAD_ARGUMENT', PULL_HELP);
  const root = args[0],
    path = join(clientCacheRoot(root), 'agent', 'address.json'),
    address = checkoutPathExists(path) ? hostedAgentAddressSchema.parse(readAgentJson(path)) : null;
  invariant(address, 'WORK_CONFLICT', 'Pull requires a Forge clone root; use nforge clone PROJECT DIR.');
  if (beforeRun && !(await beforeRun())) return;
  const exchange = new ConvexExchange(address.url, undefined, address.projectId, '', null);
  return pullHostedProject(root, address, mainCheckoutTransport(root, address, exchange));
}
