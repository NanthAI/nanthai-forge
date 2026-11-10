#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { printedReceipt } from './receipt-slim.js';
import { callerOverlaps, withCallerOverlaps } from './agent-caller-overlaps.js';
import { overlapBannerOnce, refusalOverlapBanner } from './hosted-overlap-notice.js';
import { supportedNode, nodeRequirement } from '../scripts/node-runtime.mjs';
import { ForgeError, invariant } from './errors.js';
import { resolve } from 'node:path';
import { describeFailure, recordFailure } from './system-errors.js';
import { cliTeachContext, teachReceipt } from './error-teaching.js';
import { readFileSync } from 'node:fs';

const HELP = `Forge is a source host and workspace for humans and AI agents working on the same code.

Start here: nforge docs quickstart (offline Git adoption).
Browse packaged documentation: nforge docs

Usage:
  nforge clone <project-url|project-id> DIR [--deployment URL]
  nforge import <github-url|OWNER/NAME> [--ref REF] [--name NAME] [--deployment URL] [--operation-id UUID] [--no-wait]
  nforge import --resume OPERATION_UUID   # resume a pinned GitHub source import; reports project and readiness
  nforge pull [ROOT]           # refresh a clean clone to accepted main (ROOT: cwd clone)
  nforge update [FORGE_CHECKOUT] [--directory DIR] [--state STATE]
  nforge cli rollback [--directory DIR]   # switch to the one retained previous CLI build
  nforge cli release-sign --key FILE [--state STATE --release N]   # owner: sign released main for the CLI updater
  nforge cli release-verify [--state STATE]...   # re-check stored release signatures with this build's keys
  nforge worker DEPLOYMENT_URL PROJECT_ID MACHINE_UUID
  nforge metrics ROOT [--from DATE] [--to DATE] [--json] [--report FILE.md] [--compare FROM..TO]
  nforge metrics record-bill ROOT --provider P --from DATE --to DATE --billed-usd N [--list-usd N] [--usage unit=qty,...] [--rate unit=usd,...] [--basis TEXT]
  nforge improve ROOT [--json]
  nforge release ROOT --command-file FILE | --resume UUID | --status UUID
  nforge land ROOT LANE… [--message MESSAGE] [--operation-id UUID] [--wait]
  nforge wait ID [--budget SECONDS]   # resume this agent session's own unfinished landing or run
  nforge docs [name]
  nforge --version
  nforge pr list|candidate|create|checks|merge|diff|checkout [LANE_ID] [--repo ROOT] [--json [fields]]
  nforge repo candidate [ROOT] [--json [fields]]
  nforge queue list|cancel OPERATION|prioritize OPERATION
  nforge github connect|status|disconnect|resume PROJECT [--url DEPLOYMENT] [--repo OWNER/NAME] [--operation-id UUID] [--no-mirror]
  nforge github-sync ROOT [--repo OWNER/NAME] [--branch main] [--dry-run | --push] [--operation-id UUID] [--rebind] [--wait-audit] [--audit-timeout-ms MS]
  nforge host ROOT [--deployment URL] [--name NAME] [--visibility private|public] [--status | --new]
  nforge login [DEPLOYMENT_URL] [--name NAME] [--scope cli|coordination]
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
  nforge agent <root> start|save|land [--mode] [json | --command-file FILE|-] [--message-file FILE|-] [--no-wait]   # nforge agent --help
  nforge heavy CMD [ARGS...]   # run a heavy local command under the machine-wide slot limit
  nforge prune [--apply] [--scan DIRECTORY]   # remove local roots of landed/abandoned Lanes
  nforge settings [KEY [VALUE | --reset]]   # client parallel-work defaults (docs/parallel-work-defaults.md)
  nforge agent <root> <read> [json | --command-file FILE]
  nforge x <root> <operator-action> [json | --command-file FILE]
  nforge owner refresh <root>
  nforge recover NEW_RUNNER --command-file REQUEST.json
  nforge policy <root>
  nforge set-policy <root> JSON
  nforge import-native-git <git-root> <exact-commit> <new-directory>
  nforge export-native-git <native-root> <exact-state> <new-directory> [--reuse <previous-export-dir>]
  nforge restore-native <backup-directory-or-archive> <new-directory> [--journal HOSTED_WORK.json]
  nforge init-native <directory>
  nforge work <git-worktree-root> [command-json expected-revision]
  nforge work <git-worktree-root> --command-file <json-file> <expected-revision>
  nforge restore-work <backup-directory-or-archive> <new-directory> [--journal HOSTED_WORK.json]
  nforge mcp <root> [--work | --agent]
  nforge mcp-agent <forge-convex-deployment-url>
  nforge mcp-config <root> [--agent]
  nforge plugin-config <root> <new-directory>
  nforge local-checks ROOT DEPLOYMENT PROJECT_ID [--name NAME]
  nforge doctor <git-worktree-root | forge-clone-or-lane-root>
  nforge index <git-worktree-root>
  nforge status ROOT [--pending] [--detail] [--ignored] [--offset N] [--limit N] [--json]
  nforge status <git-worktree-root>   # existing graph JSON; --pending selects owner summary
  nforge context <git-worktree-root> [search] [--limit N]
  nforge inspect <git-worktree-root> <name-or-id> [--limit N]
  nforge refs <git-worktree-root> <name-or-id> [--limit N]
  nforge imports <git-worktree-root> <relative-file> [--limit N]
  nforge source <git-worktree-root> <relative-file> [start-line] [end-line]

Query results are JSON; mcp speaks stdio. Queries refuse stale source; run index again after edits.
Artifacts stay in <root>/.forge/index.json. Optional work publication/PR import/check uses GitHub through local gh credentials.
MCP defaults to source tools. --work explicitly adds local work commands and GitHub import/publish/check. --agent exposes concise recorded workflow and selected source tools; login or configured FORGE_AUTH_TOKEN also enables native exchange and scoped hosted Work reads. Use mcp-coordination for hosted activity/messages and scoped Work reads.
MCP-agent uses FORGE_AGENT_TOKEN from the process environment for explicitly delegated hosted source reads only.
Source/context commands do not use the network or execute target source. No inference.
Explicit work run-check/run-playbook and selected events under enabled automations execute configured commands under your OS account; worktrees are not sandboxes.
Work read-history/export-history reads original local commit ancestry for exact clean Candidates without fetching.
Work compare-candidates observes advisory committed-path overlap between two exact clean Candidates against their own bases.
Work import-discussion records a mapped PR's provider page; read-discussion/export-discussion use its private receipt.
Work import-native-git-contribution validates an exact native base, original Git commit/ref/full-bundle digest and creates a separate native Lane; authored identity remains an unverified claim, original Work/Channels are preserved, and retries retain the original operationId/pins.
Work import-native-contribution validates a full native archive/digest/base/candidate and creates a separate Lane, preserving current Work/Channels. Offline claim metadata remains unverified; retries retain operationId and semantic pins.
Work import-bundle validates a selected local full Git bundle/ref/digest/head and imports original commits into an isolated Lane, without verified contributor identity.
Work export-work creates a private committed-source/history + Work/evidence directory; restore-work materializes a new local copy without starting recorded commands. Uncommitted edits/credentials/hosted grants are excluded.
Work accept-channel explicitly advances a local accepted pointer; export-channel creates a full pinned Git bundle.
Work define-check may select exact artifactPaths to retain build outputs before cleanup. Export-check returns original run/log/selected-output integrity; create-release may explicitly retain exact-Candidate buildRunIds. No command is repeated by export.
Work define-check may optionally declare source/tool/environment/external inputs; assess-check-inputs compares a retained run with a selected Candidate without executing or reusing it. External claims and undeclared coverage stay unknown.
Work define-invariant/assess-invariant retain optional named exact-Candidate check and policy-bound review evidence; optional githubReview selects a mapped PR and immutable GitHub account IDs for current source approvals. Accept-channel may explicitly select a policy version.
Work put-planning-item/comment-planning-item/export-planning retain private local Issues, Initiatives, Intent links and discussion without changing source or acceptance.
Work create-release pins a named original Channel acceptance; enabled release automations execute their selected local checks. Export-release returns the original Git bundle/digest manifest.
Semantic coverage is partial. Global/package/tsconfig path resolution is not supported.
`;

async function main(args: string[]): Promise<unknown> {
  const runtimeCallbacks = (await import('./cli-command-ready.js')).cliRuntimeCallbacks(args);
  const { beforeDispatch, beforeLocal } = runtimeCallbacks;
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    process.stdout.write(HELP);
    return undefined;
  }
  if (args[0] === 'worker') return (await import('./worker-cli.js')).workerCli(args.slice(1));
  if (args[0] === 'metrics') return (await import('./metrics-cli.js')).metricsCli(args.slice(1));
  if (args[0] === 'improve') return (await import('./improve-cli.js')).improveCli(args.slice(1));
  if (args[0] === 'docs') return (await import('./docs-cli.js')).docsCli(args.slice(1));
  if (args[0] === '--version') {
    (await import('./gh-cli.js')).forgeVersion(args);
    return undefined;
  }
  if (args[0] === 'pr' || args[0] === 'repo') return (await import('./gh-cli.js')).ghCli(args);
  if (['login', 'logout', 'auth'].includes(args[0]!))
    return (await import('./auth-cli.js')).authCli(args[0]!, args.slice(1));
  if (args[0] === 'queue') return (await import('./queue-control.js')).queueCli(args.slice(1));
  if (args[0] === 'github') return (await import('./github-connect-cli.js')).githubConnectCli(args.slice(1));
  if (args[0] === 'github-sync') return (await import('./github-sync-cli.js')).githubSyncCli(args.slice(1));
  if (args[0] === 'recover') return (await import('./recovery-cli.js')).recoveryCli(args.slice(1));
  if (args[0] === 'owner') {
    invariant(
      args[1] === 'refresh' && args.length === 3 && args[2],
      'BAD_ARGUMENT',
      'Use owner refresh ROOT.',
    );
    return (await import('./owner-root.js')).refreshOwnerRoot(
      new (await import('./work-store.js')).WorkStore(args[2]),
    );
  }
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
    const binding =
      args.length === 2
        ? (await import('./host-binding.js')).requireHostedBinding(
            new (await import('./work-store.js')).WorkStore(args[1]),
          )
        : null;
    await (
      await import('./coordination-mcp.js')
    ).startCoordinationMcp(binding?.deployment ?? args[1], binding?.projectId ?? args[2]!);
    return undefined;
  }
  if (args[0] === 'exchange') return (await import('./exchange-cli.js')).exchangeCli(args.slice(1));
  if (args[0] === 'land') return (await import('./land-cli.js')).landCli(args.slice(1));
  if (args[0] === 'release')
    return (await import('./maintainer-release-cli.js')).maintainerReleaseCli(args.slice(1));
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
  if (args[0] === 'settings') return (await import('./client-settings.js')).clientSettingsCli(args.slice(1));
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
  if (args[0] === 'local-checks')
    return (await import('./local-checks-cli.js')).localChecksCli(args.slice(1));
  if (args[0] === 'plugin-config') {
    invariant(
      args.length === 3 && args[1] && args[2],
      'BAD_ARGUMENT',
      'Use plugin-config <root> <new-directory>.',
    );
    return (await import('./plugin-config.js')).pluginConfig(args[1], args[2]);
  }
  if (args[0] === 'mcp-config' && args[2] === '--agent') {
    invariant(args.length === 3 && args[1], 'BAD_ARGUMENT', 'Use mcp-config <root> --agent.');
    return (await import('./setup.js')).mcpConfig(args[1], { agent: true });
  }
  if (args[0] === 'mcp-agent') {
    invariant(args.length === 2 && args[1], 'BAD_ARGUMENT', 'Use mcp-agent <forge-convex-deployment-url>.');
    await (await import('./agent-mcp.js')).startAgentMcp(args[1], process.env.FORGE_AGENT_TOKEN);
    return undefined;
  }
  if (args[0] === 'import-native-git' || args[0] === 'export-native-git') {
    invariant(
      (args.length === 4 ||
        (args[0] === 'export-native-git' && args.length === 6 && args[4] === '--reuse' && args[5])) &&
        args[1] &&
        args[2] &&
        args[3],
      'BAD_ARGUMENT',
      'Use import-native-git <git-root> <exact-commit> <new-directory> or export-native-git <native-root> <exact-state> <new-directory> [--reuse <previous-export-dir>].',
    );
    return args[0] === 'import-native-git'
      ? (await import('./native-git.js')).importNativeGit(args[1], args[2], args[3])
      : (await import('./native-git.js')).exportNativeGit(args[1], args[2], args[3], args[5]);
  }
  if (args[0] === 'restore-native') {
    invariant(
      args[1] && args[2] && (args.length === 3 || (args.length === 5 && args[3] === '--journal' && args[4])),
      'BAD_ARGUMENT',
      'Use restore-native <backup> <new-directory> [--journal HOSTED_WORK.json].',
    );
    return (await import('./native-backup.js')).restoreNativeWork(args[1], args[2], args[4]);
  }
  if (args[0] === 'init-native') {
    invariant(args.length === 2 && args[1], 'BAD_ARGUMENT', 'Use init-native <directory>.');
    return (await import('./native-work.js')).initNative(args[1]);
  }
  if (args[0] === 'restore-work') {
    invariant(
      args[1] && args[2] && (args.length === 3 || (args.length === 5 && args[3] === '--journal' && args[4])),
      'BAD_ARGUMENT',
      'Use restore-work <archive> <new-directory> [--journal HOSTED_WORK.json].',
    );
    return (await import('./work-backup.js')).restoreWork(args[1], args[2], args[4]);
  }
  if (args[0] === 'work') {
    if (args[1] === '--help' || args[1] === 'help' || args[2] === '--help') {
      process.stdout.write(
        'nforge work ROOT [--compact | COMMAND_JSON EXPECTED_REVISION]\nnforge work ROOT --command-file FILE EXPECTED_REVISION\nWithout a command, prints revision, head and collection counts. --compact returns Work attributes with deferred diff details. Recorded actions include release, Playbooks, history and GitHub publication. For concise task delivery use nforge agent ROOT ACTION --help.\n',
      );
      return undefined;
    }
    const compact = args.length === 3 && args[2] === '--compact';
    const fromFile = args.length === 5 && args[2] === '--command-file';
    invariant(
      args[1] && (args.length === 2 || args.length === 4 || fromFile || compact),
      'BAD_ARGUMENT',
      'Use work <root> [--compact | command-json expected-revision] or work <root> --command-file <json-file> <expected-revision>.',
    );
    if (args.length === 2) return (await import('./work-cli-summary.js')).workCliSummary(args[1]);
    const work = new (await import('./work.js')).WorkService(
      args[1],
      (await import('./work-autonomy.js')).localAgent(),
    );
    if (compact) return work.status({ compact });
    let input = args[2]!;
    if (fromFile) {
      try {
        input = readFileSync(args[3]!, 'utf8');
      } catch {
        throw new ForgeError('BAD_ARGUMENT', 'Work command file could not be read.');
      }
    }
    let command: unknown;
    try {
      command = JSON.parse(input);
    } catch {
      throw new ForgeError('BAD_ARGUMENT', 'Work command must be JSON.');
    }
    if (command && typeof command === 'object' && 'action' in command && typeof command.action === 'string')
      (await import('./candidate-names.js')).noticeViewAlias(command.action);
    return work.dispatch(command, Number(args.at(-1)));
  }
  if (args[0] === 'mcp') {
    const explicitHosted =
      args.length === 7 && args[2] === '--agent' && args[3] === '--url' && args[5] === '--project-id';
    invariant(
      args[1] &&
        !args[1].startsWith('--') &&
        (args.length === 2 ||
          (args.length === 3 && ['--work', '--agent'].includes(args[2]!)) ||
          explicitHosted),
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
    );
    return undefined;
  }
  if (
    args[0] === 'status' &&
    args[1] &&
    !(await import('./native-source.js')).nativeOwner(resolve(args[1]))
  ) {
    const hosted = await (await import('./hosted-cli-status.js')).readHostedCliStatus(args[1]);
    if (hosted) {
      if (args.includes('--json')) return hosted.value;
      process.stdout.write(hosted.text + '\n');
      return undefined;
    }
  }
  if (
    args[0] === 'status' &&
    args[1] &&
    (args.includes('--pending') || !!(await import('./native-source.js')).nativeOwner(resolve(args[1])))
  ) {
    const options: { detail?: boolean; ignored?: boolean; offset?: number; limit?: number } = {};
    for (let index = 2; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--detail') options.detail = true;
      else if (arg === '--ignored') options.ignored = true;
      else if (arg === '--offset' || arg === '--limit') {
        invariant(/^\d+$/.test(args[index + 1] ?? ''), 'BAD_ARGUMENT', `${arg} requires an integer.`);
        options[arg === '--offset' ? 'offset' : 'limit'] = Number(args[++index]);
      } else
        invariant(
          ['--pending', '--json'].includes(arg!),
          'BAD_ARGUMENT',
          'Use status ROOT [--pending] [--detail] [--ignored] [--offset N] [--limit N] [--json].',
        );
    }
    const store = new (await import('./work-store.js')).WorkStore(args[1]);
    const pendingFixes = await (await import('./hosted-agent-cache.js')).hostedFixStatus(store);
    const status = {
      ...(await import('./pending-status-read.js')).readPendingStatus(store, undefined, undefined, options),
      ...(pendingFixes ?? {}),
    };
    const metrics = await (await import('./self-metrics-source.js')).hostedStatusMetrics(args[1]);
    if (metrics) status.metrics = metrics;
    if (args.includes('--json')) return status;
    process.stdout.write((await import('./pending-status-format.js')).formatPendingStatus(status) + '\n');
    return undefined;
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
  invariant(
    root && !root.startsWith('--'),
    'BAD_ARGUMENT',
    'A ROOT is required: a Forge clone, a Lane checkout or a Git worktree ("." for the current folder). Use --help.',
  );
  invariant(!args.some(a => a.startsWith('--')), 'BAD_ARGUMENT', 'Unknown option. Use --help.');
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
  const output = withCallerOverlaps(process.argv[3] ?? process.cwd(), await main(process.argv.slice(2)));
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
  if (Array.isArray(output)) {
    const overlaps = callerOverlaps(process.argv[3] ?? process.cwd());
    if (overlaps) process.stderr.write(JSON.stringify({ unacknowledgedOverlaps: overlaps }) + '\n');
  }
  if (output !== undefined) {
    // Hosted agent receipts leave the process without the facts the agent already holds; --detail keeps all.
    const receipt = printedReceipt(output, {
      agent: process.argv[2] === 'agent',
      detail: process.argv.includes('--detail'),
      // The land submitter's stdout is parsed by its parent, which needs the full receipt.
      landChild: process.env.FORGE_LAND_CHILD === '1',
    });
    // A terminal error inside an agent receipt (a conflict, a failed check) names its help topic.
    const printed =
      (process.argv[2] === 'agent' || process.argv[2] === 'x') && process.env.FORGE_LAND_CHILD !== '1'
        ? teachReceipt(receipt, cliTeachContext(process.argv.slice(2)))
        : receipt;
    process.stdout.write(
      `${JSON.stringify(printed, null, process.argv[2] === 'agent' || process.argv[2] === 'x' || (process.argv[2] === 'host' && process.argv.includes('--json')) ? undefined : 2)}\n`,
    );
    // The JSON receipt on stdout carries overlapNotice too; the banner keeps it from being missed in a log.
    const notice = (output as { overlapNotice?: Parameters<typeof overlapBannerOnce>[0] } | null)
      ?.overlapNotice;
    if ((process.argv[2] === 'agent' || process.argv[2] === 'x') && notice)
      process.stderr.write(overlapBannerOnce(notice));
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
  // Known errors stay terse; system and unexpected errors also log the stack and name the log.
  const known = error instanceof ForgeError;
  const teaching = cliTeachContext(process.argv.slice(2));
  const failure = known ? describeFailure(error, teaching) : recordFailure(error, teaching);
  if (process.argv[2] === 'github-sync') {
    syncPending = false;
    process.stdout.write(`${JSON.stringify({ pushed: false, reason: failure.code, error: failure })}\n`);
  } else {
    process.stderr.write(
      `${JSON.stringify(withCallerOverlaps(process.argv[3] ?? process.cwd(), { error: failure }))}\n`,
    );
    // A gate refusal names the blocking notices it judged and their exact answer (c8b842a9).
    if (process.argv[2] === 'agent' || process.argv[2] === 'x')
      process.stderr.write(refusalOverlapBanner(failure.recovery));
  }
  process.exitCode = 1;
}
