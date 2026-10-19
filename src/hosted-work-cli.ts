// SPDX-License-Identifier: Apache-2.0
import { WorkStore } from './work-store.js';
import { requireHostedBinding } from './host-binding.js';
import { readFileSync } from 'node:fs';
import { coordinationClient } from './coordination-client.js';
import { dispatchHostedWork } from './hosted-work-client.js';
import { invariant } from './errors.js';
export const HOSTED_WORK_HELP = `Forge scoped hosted Work and autonomy policy
nforge hosted-work ROOT JSON
nforge hosted-work DEPLOYMENT PROJECT_ID JSON
nforge hosted-work DEPLOYMENT PROJECT_ID --command-file FILE
Run nforge login or set FORGE_AUTH_TOKEN to an existing owner/contributor Convex JWT; never put it in arguments or source.
Policy: {"action":"policy"}; set-policy: {"action":"set-policy","operationId":"UUID","preset":"trusted"} (current owner only).
Workspace: {"action":"workspace"} returns source pins, current command revision, counts and capabilities.
Records: {"action":"records","collection":"intents","cursor":null,"pageSize":50} returns one indexed summary page.
Continue with the returned continueCursor (it includes the generation binding); a source change is explicit WORK_STALE.
Page/detail revision is the archive baseline; use workspace.revision for command concurrency.
Detail: {"action":"detail","collection":"planningItems","id":"ITEM_UUID"} hydrates only this record's full attributes.
Collections: intents, lanes, views, runs, planningItems (current), planningVersions, planningComments, notes, lifecycle, channels, channelMoves, hostedChannels, hostedChannelMoves, events.
Use parentId to scope notes/lifecycle to an Intent or comments/planningVersions to an item. Intent detail excludes these separately paged histories.
An absent derived index is prepared automatically from the existing authorized backup/journal. Warm reads do not load the full Work snapshot; records remain attributed untrusted data.
MCP: forge_hosted_work is available in mcp-coordination (configured project), or local mcp --agent after login or when FORGE_AUTH_TOKEN is configured (explicit deployment/project). Scoped source-read tokens gain no Work access.
`;
export async function hostedWorkCli(args: string[]) {
  if (!args.length || args.includes('--help')) {
    process.stdout.write(HOSTED_WORK_HELP);
    return undefined;
  }
  if (args.length === 2 || (args.length === 3 && args[1] === '--command-file')) {
    const binding = requireHostedBinding(new WorkStore(args[0]!));
    args = [binding.deployment, binding.projectId, ...args.slice(1)];
  }
  const [deployment, projectId, option, file] = args;
  invariant(
    deployment &&
      projectId &&
      option &&
      (args.length === 3 || (args.length === 4 && option === '--command-file' && file)),
    'BAD_ARGUMENT',
    'Use hosted-work DEPLOYMENT PROJECT_ID JSON or --command-file FILE.',
  );
  let input: unknown;
  try {
    input = JSON.parse(option === '--command-file' ? readFileSync(file!, 'utf8') : option);
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Read a valid hosted Work request JSON object.');
  }
  return dispatchHostedWork(coordinationClient(deployment, process.env.FORGE_AUTH_TOKEN), projectId, input);
}
