// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { lstatSync, readdirSync } from 'node:fs';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { deploymentUrl, readAuth } from './auth-store.js';
import { ConvexExchange } from './exchange-client.js';
import { checkoutHostedMain, type MainTransport } from './hosted-main-checkout.js';
import { HostedCheckoutDownloads } from './hosted-checkout-downloads.js';
import { hostedAgentDirectory, readAgentJson } from './hosted-agent-journal.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { durableReplace } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { invariant } from './errors.js';
export const CLONE_HELP = 'nforge clone <project-url|project-id> DIR [--deployment URL]\n';
type Client = Pick<ConvexExchange['client'], 'query'>;
/** Root binding is the same private address used by CLI/MCP; no native owner is created. */
export async function cloneHostedProject(
  root: string,
  address: { url: string; projectId: string },
  transport: MainTransport,
) {
  root = resolve(root);
  const directory = hostedAgentDirectory(root),
    path = join(directory, 'clone.json');
  const operation = workLocked(join(directory, 'clone.lock'), () => {
    if (checkoutPathExists(path)) {
      const previous = z
        .object({ url: z.string(), projectId: z.string(), operationId: z.uuid() })
        .parse(readAgentJson(path));
      invariant(
        previous.url === address.url && previous.projectId === address.projectId,
        'WORK_OPERATION_CHANGED',
        'Retry clone with its original project and deployment.',
      );
      return previous;
    }
    if (checkoutPathExists(root)) {
      const stat = lstatSync(root);
      invariant(
        stat.isDirectory() && !stat.isSymbolicLink(),
        'UNSAFE_PATH',
        'Clone destination must be a real directory.',
      );
      invariant(
        readdirSync(root).length === 0,
        'WORK_CONFLICT',
        'Clone requires an empty destination directory.',
      );
    }
    const request = { ...address, operationId: randomUUID() };
    durableReplace(path, JSON.stringify(request));
    return request;
  });
  const result = await checkoutHostedMain(root, operation, transport);
  durableReplace(join(directory, 'address.json'), JSON.stringify(address));
  return { ...result, operationId: operation.operationId, transport: 'hosted', path: result.root };
}
export async function hostedCloneCli(
  args: string[],
  dependencies?: {
    client: Client;
    transport(projectId: string): MainTransport;
  },
) {
  if (args.includes('--help')) {
    process.stdout.write(CLONE_HELP);
    return;
  }
  const [source, root, ...flags] = args;
  invariant(
    source &&
      root &&
      !root.startsWith('-') &&
      (flags.length === 0 || (flags.length === 2 && flags[0] === '--deployment' && flags[1])),
    'BAD_ARGUMENT',
    CLONE_HELP,
  );
  let route: { handle?: string; slug?: string; projectId?: string } = { projectId: source };
  let origin: string | undefined;
  if (/^https?:\/\//.test(source)) {
    const url = new URL(source),
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    invariant(!url.username && !url.password, 'BAD_ARGUMENT', 'Use a project URL without credentials.');
    origin = url.origin;
    route = url.searchParams.has('project')
      ? { projectId: url.searchParams.get('project')! }
      : { handle: parts[0]!, slug: parts[1]! };
    invariant(
      route.projectId || (route.handle && route.slug),
      'BAD_ARGUMENT',
      'Use the hosted project URL or project ID.',
    );
  }
  const selected = flags[1] ?? process.env.FORGE_DEPLOYMENT_URL ?? readAuth().defaultDeployment ?? origin;
  invariant(
    selected,
    'AUTH_REQUIRED',
    'Run nforge login DEPLOYMENT_URL before cloning, or pass --deployment.',
  );
  const url = deploymentUrl(selected);
  const client = dependencies?.client ?? new ConvexExchange(url, undefined, '', '', null).client;
  const project = z
    .object({ id: z.string() })
    .nullable()
    .parse(await client.query(makeFunctionReference<'query'>('urlProjects:resolve'), route));
  invariant(project, 'PROJECT_UNAVAILABLE', 'This hosted project is unavailable with the current account.');
  const exchange = dependencies ? null : new ConvexExchange(url, undefined, project.id, '', null);
  const downloads = exchange ? new HostedCheckoutDownloads(exchange) : null;
  return cloneHostedProject(
    root,
    { url, projectId: project.id },
    dependencies?.transport(project.id) ?? {
      current: expected => exchange!.current(expected),
      objects: ids => downloads!.objects(ids),
      downloadToFile: (pin, path) => downloads!.downloadToFile(pin, path),
      downloadFiles: files => downloads!.downloadFiles(files),
    },
  );
}
