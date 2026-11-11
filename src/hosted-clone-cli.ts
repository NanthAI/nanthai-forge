// SPDX-License-Identifier: Apache-2.0
import { hostedContractFeatures, sourceStateFeature } from './hosted-contract-features.js';
import { hostedMainV2Schema } from './hosted-main.js';
import { CUTOVER_CLI_VERSION } from './cutover-version.js';
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
import { durableReplace } from './state/durability.js';
import { workLocked } from './work-lock.js';
import { ForgeError, invariant } from './errors.js';
export const CLONE_HELP = 'nforge clone <project-url|project-id> DIR [--deployment URL]\n';
type Client = Pick<ConvexExchange['client'], 'query'>;
/** Root binding is the same private address used by CLI/MCP; no native owner is created. */
export async function cloneHostedProject(
  root: string,
  address: { url: string; projectId: string },
  transport: MainTransport,
) {
  root = resolve(root);
  const directory = hostedAgentDirectory(root, { exactRoot: true }),
    path = join(directory, 'clone.json');
  const select = (fresh: boolean) =>
    workLocked(join(directory, 'clone.lock'), () => {
      if (!fresh && checkoutPathExists(path)) {
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
  let operation = select(false),
    result;
  try {
    result = await checkoutHostedMain(root, operation, transport);
  } catch (error) {
    // The earlier clone finished but its folder is gone or emptied (Issue ca49dc6c): a clone into it
    // is new work, so it installs again (from this machine's cached objects when they are kept),
    // never a replayed success with no files. A non-empty folder still refuses below.
    if (!(error instanceof ForgeError && error.code === 'CHECKOUT_MISSING')) throw error;
    operation = select(true);
    result = await checkoutHostedMain(root, operation, transport);
  }
  durableReplace(join(directory, 'address.json'), JSON.stringify(address));
  return { ...result, operationId: operation.operationId, transport: 'hosted', path: result.root };
}
export async function hostedCloneCli(
  args: string[],
  dependencies?: {
    client: Client;
    transport(projectId: string): MainTransport;
  },
  beforeRun?: () => Promise<boolean>,
  beforeLocal?: () => Promise<void>,
) {
  if (args.includes('--help')) {
    await beforeLocal?.();
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
  if (beforeRun && !(await beforeRun())) return;
  const client = dependencies?.client ?? new ConvexExchange(url, undefined, '', '', null).client;
  // A clone by project ID reads main alongside the route lookup (two reads at once, same calls);
  // the read is used only when the lookup names that same project.
  const named =
    dependencies || !route.projectId ? null : new ConvexExchange(url, undefined, route.projectId, '', null);
  let early = named ? sourceCurrent(named) : undefined;
  early?.catch(() => undefined);
  const project = z
    .object({ id: z.string(), handle: z.string().optional(), slug: z.string().optional() })
    .nullable()
    .parse(await client.query(makeFunctionReference<'query'>('urlProjects:resolve'), route));
  invariant(project, 'PROJECT_UNAVAILABLE', 'This hosted project is unavailable with the current account.');
  const exchange = dependencies
    ? null
    : named && project.id === route.projectId
      ? named
      : new ConvexExchange(url, undefined, project.id, '', null);
  if (exchange !== named) early = undefined;
  const downloads = exchange ? new HostedCheckoutDownloads(exchange) : null;
  let sourceFeaturesRead = false;
  // The slug is what `nforge host ROOT --delete-project ID --confirm SLUG` needs; a re-import of the
  // same name gets a suffixed one, so it is printed rather than guessed.
  const cloned = await cloneHostedProject(
    root,
    { url, projectId: project.id },
    dependencies?.transport(project.id) ?? {
      current: async expected => {
        const read = expected === undefined ? early : undefined;
        early = undefined;
        if (read) {
          sourceFeaturesRead = true;
          return read;
        }
        if (!sourceFeaturesRead) {
          sourceFeaturesRead = true;
          return sourceCurrent(exchange!, expected);
        }
        return exchange!.current(expected);
      },
      ...downloads!.transport(),
    },
  );
  return {
    ...cloned,
    projectId: project.id,
    ...(project.slug ? { slug: project.slug } : {}),
    ...(project.handle ? { handle: project.handle } : {}),
  };
}

/** Existing discovery carries main, keeping one first selection call per current-server clone. */
async function sourceCurrent(
  exchange: ConvexExchange,
  expected?: import('./hosted-main.js').MainExpectation,
) {
  const value = await exchange.client.query(
    makeFunctionReference<'query'>('projectHostedAgent:capabilities'),
    {
      projectId: exchange.projectId,
      clientVersion: CUTOVER_CLI_VERSION,
      features: [...new Set([...hostedContractFeatures, sourceStateFeature, 'capabilities-main'])],
    },
  );
  const capabilities = typeof value === 'string' ? JSON.parse(value) : value;
  exchange.sourceStateReads = capabilities.features?.includes(sourceStateFeature) === true;
  const parsed = hostedMainV2Schema.safeParse(capabilities.main);
  if (!parsed.success) return exchange.current(expected);
  invariant(
    parsed.data.projectId === exchange.projectId,
    'PROJECT_UNAVAILABLE',
    'Select this hosted project.',
  );
  invariant(
    !expected || (expected.head === parsed.data.head && expected.receiptId === parsed.data.receipt.id),
    'CHANNEL_CHANGED',
    'Hosted main changed from the expected head and receipt.',
  );
  return parsed.data;
}
