// SPDX-License-Identifier: Apache-2.0
import { dirname, join, resolve } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { hostedAgentAddressSchema } from './hosted-address.js';
import { readAgentJson } from './hosted-agent-journal.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { ConvexExchange } from './exchange-client.js';
import { mainCheckoutTransport, pullHostedProject } from './hosted-pull.js';
import { invariant } from './errors.js';
import { lockfileState, staleDependenciesNotice } from './stale-dependencies.js';
export const PULL_HELP =
  'nforge pull [ROOT]\nRefresh a Forge clone to accepted main; re-run to resume an interrupted refresh. ROOT defaults to the Forge clone containing the current directory.\n';
const addressPath = (root: string) => join(clientCacheRoot(root), 'agent', 'address.json');
/** The Forge clone holding `start`: the nearest directory with a retained address. Local stats only. */
function cloneRoot(start: string) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (checkoutPathExists(addressPath(dir))) return dir;
    if (dirname(dir) === dir) return resolve(start);
  }
}
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
  invariant(
    args.length === 0 || (args.length === 1 && args[0] && !args[0].startsWith('-')),
    'BAD_ARGUMENT',
    PULL_HELP,
  );
  const root = args[0] ?? cloneRoot(process.cwd()),
    path = addressPath(root),
    address = checkoutPathExists(path) ? hostedAgentAddressSchema.parse(readAgentJson(path)) : null;
  invariant(address, 'WORK_CONFLICT', 'Pull requires a Forge clone root; use nforge clone PROJECT DIR.');
  if (beforeRun && !(await beforeRun())) return;
  const exchange = new ConvexExchange(address.url, undefined, address.projectId, '', null);
  const lockBefore = lockfileState(root)?.digest ?? null;
  const result = await pullHostedProject(root, address, mainCheckoutTransport(root, address, exchange));
  // Pull replaces sources only; a changed lockfile leaves this folder's node_modules behind. Say so, don't install.
  const stale = staleDependenciesNotice(root, lockBefore);
  if (stale) process.stderr.write(stale);
  return result;
}
