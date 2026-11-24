#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { printedReceipt } from './receipt-slim.js';
import type { ExactConflictNotice } from './hosted-conflict-notice.js';
import { supportedNode, nodeRequirement } from '../scripts/node-runtime.mjs';
import { ForgeError, invariant } from './errors.js';
import { reportFailure } from './system-errors.js';
import { agentDeadEnd, cliTeachContext, teachReceipt } from './error-teaching.js';
import { cliBuildIdentity, withCliBuildProvenance } from './cli-installation.js';

const HELP = `Forge is a source host and workspace for humans and AI agents working on the same code.

Start here: nforge docs quickstart (hosted project to first landing).
Browse packaged documentation: nforge docs

Usage:
  nforge clone [--find] NAME [--site URL]   # find public projects by name or handle/slug
  nforge clone <project-url|project-id> DIR [--deployment URL]
  nforge import <github-url|OWNER/NAME> [--ref REF] [--name NAME] [--deployment URL] [--operation-id UUID] [--no-wait]
  nforge import --resume OPERATION_UUID   # resume a pinned GitHub source import; reports project and readiness
  nforge pull [ROOT]           # refresh a clean clone to accepted main (ROOT: cwd clone)
  nforge update [FORGE_CHECKOUT] [--directory DIR] [--channel main|stable] [--pin STATE | --unpin | --state STATE]
  nforge cli rollback [--directory DIR]   # switch to the one retained previous CLI build
  nforge cli release-sign --key FILE [--state STATE --release N]   # owner: sign released main for the CLI updater
  nforge cli release-verify [--state STATE]...   # re-check stored release signatures with this build's keys
  nforge worker DEPLOYMENT_URL PROJECT_ID MACHINE_UUID
  nforge metrics ROOT [--from DATE] [--to DATE] [--json] [--report FILE.md] [--compare FROM..TO]
  nforge metrics record-bill ROOT --provider P --from DATE --to DATE --billed-usd N [--list-usd N] [--usage unit=qty,...] [--rate unit=usd,...] [--basis TEXT]
  nforge wait ID [--budget SECONDS]   # resume this agent session's own unfinished landing or run
  nforge watch ROOT [--mine | --lanes ID,…] [--json] [--on-landing CMD]
  nforge docs [name]
  nforge run [--root ROOT] [--set development|checks] [--only A,B] [--show] -- COMMAND [ARGS...]
  nforge secret set|list|rm|repin|resolve [options]
  nforge --version
  nforge agent ROOT queue '{}'   # hosted landing queue
  nforge queue list|cancel OPERATION|prioritize OPERATION   # local command recovery
  nforge github connect|status|disconnect|resume PROJECT [--url DEPLOYMENT] [--repo OWNER/NAME] [--operation-id UUID] [--no-mirror] [--no-browser]
  nforge github-sync ROOT [--repo OWNER/NAME] [--branch main] [--dry-run | --push] [--operation-id UUID] [--rebind] [--wait-audit] [--audit-timeout-ms MS]
  nforge host ROOT [--deployment URL] [--name NAME] [--visibility private|public] [--status | --new]
  nforge login [DEPLOYMENT_URL] [--name NAME] [--scope cli|coordination] [--no-browser]
  nforge logout [DEPLOYMENT_URL]
  nforge auth status [DEPLOYMENT_URL]
  nforge maintenance check-logs ROOT --dry-run|--apply --plan FILE [--hosted]
  nforge maintenance r2-backfill <root> [--dry-run|--verify] [--resume] [--state FILE]
  nforge hosted-work <deployment-url> <project-id> JSON
  nforge make-editable <deployment-url> <project-id> [operation-uuid]
  nforge coordination <deployment-url> <project-id> JSON
  nforge mcp-coordination <deployment-url> <project-id>
  nforge exchange ROOT pull [--target NEW_DIRECTORY]
  nforge exchange <root> pull|open|restore|receive-proposal|pull-proposal|migrate-archive --command-file FILE
  nforge agent <root> start|save|land|ask|hand-back [--mode] [json | --command-file FILE|-] [--message-file FILE|-] [--no-wait]   # nforge agent --help
  nforge heavy [--] CMD [ARGS...]   # run a heavy local command under the machine-wide slot limit
  nforge prune [--apply] [--finished-only | --unreachable] [--scan DIRECTORY]   # remove local roots of landed/abandoned Lanes
  nforge settings [KEY [VALUE | --reset]]   # client parallel-work defaults (docs/parallel-work-defaults.md)
  nforge agent <root> <read> [json | --command-file FILE]
  nforge agent <root> abandon|revert|cancel [json | --command-file FILE|-]
  nforge x <root> <operator-action> [json | --command-file FILE]
  nforge recover NEW_RUNNER --command-file REQUEST.json
  nforge policy <root>
  nforge set-policy <root> JSON
  nforge mcp --public [SITE_URL]   # find public projects without a checkout
  nforge mcp <root> [--agent]   # source tools; --agent: a hosted checkout's agent tools
  nforge mcp-agent <forge-convex-deployment-url>
  nforge mcp-config <root> [--agent [--client APP]]
  nforge connect <claude-code|codex|cursor|opencode|pi> [--undo BACKUP_ID]
  nforge plugin-config <root> <new-directory>
  nforge doctor <git-worktree-root | forge-clone-or-lane-root>
  nforge index <git-worktree-root>
  nforge status ROOT [--json]   # a hosted checkout's status; elsewhere the source graph status
  nforge context <git-worktree-root> [search] [--limit N]
  nforge inspect <git-worktree-root> <name-or-id> [--limit N]
  nforge refs <git-worktree-root> <name-or-id> [--limit N]
  nforge imports <git-worktree-root> <relative-file> [--limit N]
  nforge source <git-worktree-root> <relative-file> [start-line] [end-line]

Forge runs hosted projects only: a Git folder becomes one with nforge host ROOT, then work
happens in its clone or Lanes (they keep working offline and land once back online).
Query results are JSON; mcp speaks stdio. Queries refuse stale source; run index again after edits.
Artifacts stay in <root>/.forge/index.json.
MCP defaults to read-only source tools. --agent exposes a hosted checkout's agent tools. Use mcp-coordination for hosted activity/messages and scoped Work reads.
MCP-agent uses FORGE_AGENT_TOKEN from the process environment for explicitly delegated hosted source reads only.
Source/context commands do not use the network or execute target source. No inference.
`;

const HOSTED_ONLY =
  'was part of the removed native mode; Forge runs hosted projects only (nforge host ROOT makes a Git folder one).';
/** Commands of the removed native-owner mode: each names its hosted replacement. */
const REMOVED: Record<string, string> = {
  work: `nforge work ${HOSTED_ONLY} Use nforge agent ROOT ACTION in a hosted checkout.`,
  'init-native': `nforge init-native ${HOSTED_ONLY}`,
  'restore-native': `nforge restore-native ${HOSTED_ONLY}`,
  'restore-work': `nforge restore-work ${HOSTED_ONLY}`,
  'import-native-git': `nforge import-native-git ${HOSTED_ONLY}`,
  'export-native-git': `nforge export-native-git ${HOSTED_ONLY} A hosted project mirrors main to GitHub (nforge github connect).`,
  owner: `nforge owner refresh ${HOSTED_ONLY} Use nforge pull in a clone.`,
  land: `nforge land ROOT LANE ${HOSTED_ONLY} Use nforge agent ROOT land --save in the Lane to submit, or nforge agent ROOT save to save without submitting.`,
  pr: `nforge pr ${HOSTED_ONLY} Use nforge agent ROOT status, diff and land --save.`,
  repo: `nforge repo ${HOSTED_ONLY} Use nforge agent ROOT status.`,
  improve: `nforge improve ${HOSTED_ONLY} Use nforge agent ROOT friction-list.`,
  'local-checks': `nforge local-checks ${HOSTED_ONLY} Use nforge x ROOT configure-runner.`,
  release: `nforge release ${HOSTED_ONLY} Use nforge update for the CLI.`,
  status: `nforge status --pending ${HOSTED_ONLY} Use nforge agent ROOT status in a hosted checkout.`,
};

async function main(args: string[]): Promise<unknown> {
  const runtimeCallbacks = (await import('./cli-command-ready.js')).cliRuntimeCallbacks(args);
  const { beforeDispatch, beforeLocal } = runtimeCallbacks;
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    process.stdout.write(HELP);
    return undefined;
  }
  if (Object.hasOwn(REMOVED, args[0]!) && args[0] !== 'status')
    throw new ForgeError('BAD_ARGUMENT', REMOVED[args[0]!]!);
  if (args[0] === 'worker') return (await import('./worker-cli.js')).workerCli(args.slice(1));
  if (args[0] === 'metrics') return (await import('./metrics-cli.js')).metricsCli(args.slice(1));
  if (args[0] === 'watch') return (await import('./watch-cli.js')).watchCli(args.slice(1));
  if (args[0] === 'docs') return (await import('./docs-cli.js')).docsCli(args.slice(1));
  if (args[0] === 'run') return (await import('./secret-run-cli.js')).secretRunCli(args.slice(1));
  if (args[0] === 'secret') return (await import('./sealed-cli.js')).sealedCli(args.slice(1));
  if (args[0] === '--version') {
    invariant(args.length === 1, 'UNSUPPORTED_FLAG', `Unsupported flag: ${args[1]}`);
    const { cliVersion, cliCommit, cliChannel, cliPin } = cliBuildIdentity();
    process.stdout.write(
      `nforge version ${cliVersion} (channel ${cliChannel}, pin ${cliPin ?? 'none'}, build ${cliCommit})\n`,
    );
    return undefined;
  }
  if (['login', 'logout', 'auth'].includes(args[0]!))
    return (await import('./auth-cli.js')).authCli(args[0]!, args.slice(1));
  if (args[0] === 'queue') return (await import('./queue-control.js')).queueCli(args.slice(1));
  if (args[0] === 'github') return (await import('./github-connect-cli.js')).githubConnectCli(args.slice(1));
  if (args[0] === 'github-sync') return (await import('./github-sync-cli.js')).githubSyncCli(args.slice(1));
  if (args[0] === 'recover') return (await import('./recovery-cli.js')).recoveryCli(args.slice(1));
  if (args[0] === 'pull')
    return (await import('./hosted-pull-cli.js')).hostedPullCli(args.slice(1), beforeDispatch, beforeLocal);
  if (args[0] === 'clone')
    return (await import('./hosted-clone-cli.js')).hostedCloneCli(
      args.slice(1),
      undefined,
      beforeDispatch,
      beforeLocal,
    );
  if (args[0] === 'host') return (await import('./host-cli.js')).hostCli(args.slice(1));
  if (args[0] === 'import') return (await import('./github-import-cli.js')).githubImportCli(args.slice(1));
  if (args[0] === 'policy' || args[0] === 'set-policy') {
    invariant(
      args[1] &&
        ((args[0] === 'policy' && args.length === 2) || (args[0] === 'set-policy' && args.length === 3)),
      'BAD_ARGUMENT',
      'Use policy ROOT or set-policy ROOT JSON.',
    );
    return (await import('./agent-cli.js')).agentCli([args[1], args[0], ...(args[2] ? [args[2]] : [])], {
      notices: false,
    });
  }
  if (args[0] === 'maintenance') return (await import('./maintenance-cli.js')).maintenanceCli(args.slice(1));
  if (args[0] === 'hosted-work') return (await import('./hosted-work-cli.js')).hostedWorkCli(args.slice(1));
  if (args[0] === 'make-editable')
    return (await import('./make-editable-cli.js')).makeEditableCli(args.slice(1));
  if (args[0] === 'coordination')
    return (await import('./coordination-cli.js')).coordinationCli(args.slice(1));
  if (args[0] === 'mcp-coordination') {
    invariant(
      (args.length === 2 || args.length === 3) && args[1],
      'BAD_ARGUMENT',
      'Use mcp-coordination ROOT or DEPLOYMENT PROJECT_ID.',
    );
    const target =
      args.length === 2 ? (await import('./coordination-cli.js')).coordinationTarget(args[1]) : null;
    await (
      await import('./coordination-mcp.js')
    ).startCoordinationMcp(target?.deployment ?? args[1], target?.projectId ?? args[2]!);
    return undefined;
  }
  if (args[0] === 'exchange') return (await import('./exchange-cli.js')).exchangeCli(args.slice(1));
  if (args[0] === 'agent')
    return (await import('./agent-cli.js')).agentCli(args.slice(1), { process: true, ...runtimeCallbacks });
  if (args[0] === 'x')
    return (await import('./agent-cli.js')).agentCli(args.slice(1), {
      operator: true,
      process: true,
      ...runtimeCallbacks,
    });
  if (args[0] === 'heavy') {
    process.exitCode = await (
      await import('./heavy-slots.js')
    ).heavyCli(args.slice(1), beforeDispatch, beforeLocal);
    return undefined;
  }
  if (args[0] === 'settings') {
    const result = (await import('./client-settings.js')).clientSettingsCli(args.slice(1));
    // Waiting heavy runs take a raised slot now, not at the next release (friction 25f56c0a).
    if (args[1] === 'localHeavySlots' && args[2] !== undefined)
      (await import('./heavy-slots.js')).wakeHeavyWaiters();
    return result;
  }
  if (args[0] === 'prune') {
    const { pruneCli, convexLaneStates } = await import('./lane-prune.js');
    const { ConvexExchange } = await import('./exchange-client.js');
    const clients = new Map<string, InstanceType<typeof ConvexExchange>['client']>();
    return pruneCli(
      args.slice(1),
      convexLaneStates(({ url, projectId }) => {
        const key = `${url}\0${projectId}`;
        if (!clients.has(key))
          clients.set(key, new ConvexExchange(url, process.env.FORGE_AUTH_TOKEN, projectId, '', null).client);
        const client = clients.get(key)!;
        return { query: (name, input) => client.query(name as never, input as never) };
      }),
    );
  }
  if (args[0] === 'connect') {
    // The emitted sibling keeps the config parsers and their dependency graph out of the CLI bundle.
    const { agentConnect } = (await import(
      /* @vite-ignore */ new URL('./agent-connect-cli.js', import.meta.url).href
    )) as typeof import('./agent-connect-cli.js');
    return agentConnect(args.slice(1));
  }
  if (args[0] === 'plugin-config') {
    invariant(
      args.length === 3 && args[1] && args[2],
      'BAD_ARGUMENT',
      'Use plugin-config <root> <new-directory>.',
    );
    return (await import('./plugin-config.js')).pluginConfig(args[1], args[2]);
  }
  if (args[0] === 'mcp-config' && args[2] === '--agent') {
    const setupClient = args.length === 5 && args[3] === '--client' ? args[4] : undefined;
    invariant(
      args[1] && (args.length === 3 || setupClient),
      'BAD_ARGUMENT',
      'Use mcp-config <root> --agent [--client APP].',
    );
    const config = (await import('./setup.js')).mcpConfig(args[1], { agent: true });
    if (setupClient) config.mcpServers.forge.args.push('--client', setupClient);
    return config;
  }
  if (args[0] === 'mcp-agent') {
    invariant(args.length === 2 && args[1], 'BAD_ARGUMENT', 'Use mcp-agent <forge-convex-deployment-url>.');
    await (await import('./agent-mcp.js')).startAgentMcp(args[1], process.env.FORGE_AGENT_TOKEN);
    return undefined;
  }
  if (args[0] === 'mcp') {
    if (args[1] === '--public') {
      invariant(args.length <= 3, 'BAD_ARGUMENT', 'Use nforge mcp --public [SITE_URL].');
      await (await import('./public-project-mcp.js')).startPublicProjectMcp(args[2]);
      return undefined;
    }
    const explicitHosted =
      args.length === 7 && args[2] === '--agent' && args[3] === '--url' && args[5] === '--project-id';
    const setupClient =
      args.length === 5 && args[2] === '--agent' && args[3] === '--client' ? args[4] : undefined;
    invariant(
      args[1] &&
        !args[1].startsWith('--') &&
        (args.length === 2 ||
          (args.length === 3 && ['--work', '--agent'].includes(args[2]!)) ||
          explicitHosted ||
          setupClient),
      'BAD_ARGUMENT',
      'Use mcp <root> [--work | --agent [--url URL --project-id ID]].',
    );
    await (
      await import('./mcp.js')
    ).startMcp(
      args[1],
      args[2] === '--work' || args[2] === '--agent',
      args[2] === '--agent',
      explicitHosted ? { url: args[4], projectId: args[6] } : {},
      setupClient,
    );
    return undefined;
  }
  if (args[0] === 'status' && args[1]) {
    invariant(!args.includes('--pending'), 'BAD_ARGUMENT', REMOVED.status!);
    const hosted = await (await import('./hosted-cli-status.js')).readHostedCliStatus(args[1]);
    if (hosted) {
      if (args.includes('--json')) return hosted.value;
      process.stdout.write(hosted.text + '\n');
      return undefined;
    }
  }
  const ignored = args[0] === 'status' && args.includes('--ignored');
  if (args[0] === 'status') args = args.filter(arg => arg !== '--ignored' && arg !== '--json');
  const flag = args.indexOf('--limit');
  let limit = 20;
  if (flag >= 0) {
    invariant(
      flag === args.length - 2 && /^\d+$/.test(args[flag + 1] ?? ''),
      'BAD_ARGUMENT',
      '--limit requires an integer as the final option.',
    );
    limit = Number(args[flag + 1]);
    args = args.slice(0, flag);
  }
  const [command, root, subject, first, last] = args;
  const sizes: Record<string, [number, number]> = {
    mcp: [2, 2],
    'mcp-config': [2, 2],
    doctor: [2, 2],
    index: [2, 2],
    status: [2, 2],
    context: [2, 3],
    inspect: [3, 3],
    refs: [3, 3],
    imports: [3, 3],
    source: [3, 5],
  };
  // Only a command this CLI does not know loads the agent verb lists (593fc2d7).
  if (command && !Object.hasOwn(sizes, command))
    (await import('./agent-cli.js')).refuseTopLevelAgentVerb(command);
  invariant(
    root && !root.startsWith('--'),
    'BAD_ARGUMENT',
    'A ROOT is required: a Forge clone, a Lane checkout or a Git worktree ("." for the current folder). Use --help.',
  );
  invariant(!args.some(a => a.startsWith('--')), 'BAD_ARGUMENT', 'Unknown option. Use --help.');
  const expected = sizes[command ?? ''];
  invariant(
    expected && args.length >= expected[0] && args.length <= expected[1],
    'BAD_ARGUMENT',
    'Unknown command or incorrect arguments. Use --help.',
  );
  invariant(
    flag < 0 || ['context', 'inspect', 'refs', 'imports'].includes(command!),
    'BAD_ARGUMENT',
    '--limit is not supported by this command.',
  );
  if (command === 'mcp-config') return (await import('./setup.js')).mcpConfig(root);
  if (command === 'doctor') return (await import('./setup.js')).doctor(root);
  if (command === 'index') {
    const { indexRepository } = await import('./index.js');
    const { pack, elapsedMs, work } = indexRepository(root);
    return {
      artifact: '.forge/index.json',
      sourceId: pack.source.id,
      analysisId: pack.id,
      gitHead: pack.source.gitHead,
      files: pack.source.files.length,
      symbols: pack.nodes.length,
      imports: pack.imports.length,
      references: pack.references.length,
      syntaxIssues: pack.issues.length,
      bytes: pack.source.files.reduce((n, f) => n + f.bytes, 0),
      elapsedMs,
      work,
      analysis: pack.analysis,
      excluded: pack.source.excluded,
    };
  }
  const { RepositoryQuery } = await import('./query.js');
  const query = new RepositoryQuery(root);
  switch (command) {
    case 'status':
      return query.status(ignored);
    case 'context':
      return query.context(subject, limit);
    case 'inspect':
      return query.inspect(subject!, limit);
    case 'refs':
      return query.references(subject!, limit);
    case 'imports':
      return query.imports(subject!, limit);
    case 'source':
      return query.source(
        subject!,
        first === undefined ? 1 : Number(first),
        last === undefined ? (first === undefined ? 40 : Number(first) + 39) : Number(last),
      );
  }
}
// A closed reader (`| head`) must not crash the process with EPIPE mid-action; output is dropped.
for (const stream of [process.stdout, process.stderr])
  stream.on('error', error => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error;
  });
// Fail closed if a sync invocation loses its asynchronous completion. In
// particular an unfinished request must never leave an empty stdout and exit 0.
let syncPending = process.argv[2] === 'github-sync';
if (syncPending) {
  process.exitCode = 1;
  process.once('beforeExit', () => {
    if (syncPending)
      process.stdout.write(
        JSON.stringify({
          pushed: false,
          reason: 'GITHUB_SYNC_INCOMPLETE',
          error: {
            code: 'GITHUB_SYNC_INCOMPLETE',
            message: 'Sync ended without a result. Retry the original operation to reconcile.',
          },
        }) + '\n',
      );
  });
}
try {
  invariant(supportedNode(), 'UNSUPPORTED_NODE', nodeRequirement);
  const output = await main(process.argv.slice(2));
  if (syncPending) {
    invariant(
      output && typeof output === 'object' && 'pushed' in output,
      'GITHUB_SYNC_INCOMPLETE',
      'Sync did not return a publication result.',
    );
    // Pushed, a dry run and an up-to-date mirror are successful outcomes; every other no-push reason fails.
    const reason = (output as { reason?: unknown }).reason;
    process.exitCode = output.pushed === true || reason === 'dry-run' || reason === 'nothing-to-push' ? 0 : 1;
    syncPending = false;
  }
  if (output !== undefined) {
    if (process.stdout.isTTY && process.env.FORGE_LAND_CHILD !== '1')
      for (const line of (await import('./cli-reply-lines.js')).cliReplyLines(process.argv.slice(2), output))
        process.stderr.write(`${line}\n`);
    // Hosted agent receipts leave the process without the facts the agent already holds; --detail keeps all.
    const agentCommand = process.argv[2] === 'agent' || process.argv[2] === 'x';
    const receipt = printedReceipt(agentCommand ? withCliBuildProvenance(output) : output, {
      agent: process.argv[2] === 'agent',
      detail: process.argv.includes('--detail'),
      // The land submitter's stdout is parsed by its parent, which needs the full receipt.
      landChild: process.env.FORGE_LAND_CHILD === '1',
    });
    // A terminal error inside an agent receipt (a conflict, a failed check) names its help topic.
    const agentReply = agentCommand && process.env.FORGE_LAND_CHILD !== '1';
    const printed = agentReply ? teachReceipt(receipt, cliTeachContext(process.argv.slice(2))) : receipt;
    const deadEnd = agentReply ? agentDeadEnd(printed) : undefined;
    process.stdout.write(
      `${JSON.stringify(deadEnd ? { ...(printed as object), deadEnd } : printed, null, process.argv[2] === 'agent' || process.argv[2] === 'x' || (process.argv[2] === 'host' && process.argv.includes('--json')) ? undefined : 2)}\n`,
    );
    // The JSON receipt on stdout carries stackOffer too; the line keeps it from being missed in a log.
    const offer = (output as { stackOffer?: { mode: string; text: string; command: string } } | null)
      ?.stackOffer;
    if ((process.argv[2] === 'agent' || process.argv[2] === 'x') && offer)
      process.stderr.write(
        `Stack (${offer.mode}): ${offer.text}\n${offer.mode === 'offer' ? `  ${offer.command}\n` : ''}`,
      );
    const exact = (output as { conflictNotice?: ExactConflictNotice } | null)?.conflictNotice;
    if ((process.argv[2] === 'agent' || process.argv[2] === 'x') && exact)
      process.stderr.write((await import('./hosted-conflict-notice.js')).exactConflictBannerOnce(exact));
    if (
      process.argv[2] === 'agent' &&
      (process.argv[4] === 'finish' || (process.argv[4] === 'land' && process.argv[5] === '--save'))
    ) {
      const result = (output as { result?: { status?: string } }).result;
      if (result?.status === 'awaiting-review')
        process.stderr.write(
          `Next: review and accept the checked Candidate through the project's configured acceptance authority.\n`,
        );
    }
  }
} catch (error) {
  // The detached land parent has the original invocation. Let it render the retry after the reset.
  const forwardLimit =
    process.env.FORGE_LAND_CHILD === '1' &&
    error instanceof ForgeError &&
    error.code === 'RATE_LIMITED' &&
    typeof error.recovery?.retryAt === 'string';
  const teaching = forwardLimit ? undefined : cliTeachContext(process.argv.slice(2));
  // Known errors stay terse; system and unexpected errors also log the stack and name the log.
  const failure = reportFailure(error, teaching);
  const deadEnd =
    !forwardLimit &&
    ['agent', 'x', 'wait'].includes(process.argv[2] ?? '') &&
    process.env.FORGE_LAND_CHILD !== '1'
      ? agentDeadEnd({ error: failure })
      : undefined;
  if (forwardLimit) {
    process.stdout.write(`${JSON.stringify({ error: failure })}\n`);
  } else if (process.argv[2] === 'github-sync') {
    syncPending = false;
    process.stdout.write(`${JSON.stringify({ pushed: false, reason: failure.code, error: failure })}\n`);
  } else {
    process.stderr.write(`${JSON.stringify({ error: failure, ...(deadEnd ? { deadEnd } : {}) })}\n`);
  }
  process.exitCode = 1;
}
