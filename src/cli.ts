#!/usr/bin/env node
import { noticeViewAlias } from './candidate-names.js';
import { refreshOwnerRoot } from './owner-root.js';
import { recoveryCli } from './recovery-cli.js';
// SPDX-License-Identifier: Apache-2.0
import { ghCli, forgeVersion } from './gh-cli.js';
import { queueCli } from './queue-control.js';
import { githubSyncCli } from './github-sync-cli.js';
import { WorkStore } from './work-store.js';
import { requireHostedBinding } from './host-binding.js';
import { hostCli } from './host-cli.js';
import { localAgent } from './work-autonomy.js';
import { authCli } from './auth-cli.js';
import { importNativeGit, exportNativeGit } from './native-git.js';
import { restoreNativeWork } from './native-backup.js';
import { initNative } from './native-work.js';
import { restoreWork } from './work-backup.js';
import { WorkService } from './work.js';
import { indexRepository } from './index.js';
import { RepositoryQuery } from './query.js';
import { serveRepository } from './http.js';
import { startMcp } from './mcp.js';
import { startAgentMcp } from './agent-mcp.js';
import { doctor, mcpConfig } from './setup.js';
import { pluginConfig } from './plugin-config.js';
import { localChecksCli } from './local-checks-cli.js';
import { ForgeError, invariant } from './errors.js';
import { maintenanceCli } from './maintenance-cli.js';
import { hostedWorkCli } from './hosted-work-cli.js';
import { coordinationCli } from './coordination-cli.js';
import { startCoordinationMcp } from './coordination-mcp.js';
import { exchangeCli } from './exchange-cli.js';
import { resolve } from 'node:path';
import { docsCli } from './docs-cli.js';
import { describeFailure, recordFailure } from './system-errors.js';
import { landCli } from './land-cli.js';
import { agentCli } from './agent-cli.js';
import { readFileSync } from 'node:fs';
import { nativeOwner } from './native-source.js';
import { readPendingStatus } from './pending-status-read.js';
import { formatPendingStatus } from './pending-status-format.js';

const HELP = `Forge is a source host and workspace for humans and AI agents working on the same code.

Start here: nforge docs quickstart (offline Git adoption).
Browse packaged documentation: nforge docs

Usage:
  nforge land ROOT LANE… [--message MESSAGE] [--operation-id UUID]
  nforge docs [name]
  nforge --version
  nforge pr list|candidate|create|checks|merge|diff|checkout [LANE_ID] [--repo ROOT] [--json [fields]]
  nforge repo candidate [ROOT] [--json [fields]]
  nforge queue list|cancel OPERATION|prioritize OPERATION
  nforge github-sync ROOT [--repo OWNER/NAME] [--branch main] [--dry-run | --push] [--operation-id UUID] [--rebind]
  nforge host ROOT [--deployment URL] [--name NAME] [--visibility private|public] [--status | --new]
  nforge login [DEPLOYMENT_URL] [--name NAME] [--scope cli|coordination]
  nforge logout [DEPLOYMENT_URL]
  nforge auth status [DEPLOYMENT_URL]
  nforge maintenance r2-backfill <root> [--dry-run|--verify] [--resume] [--state FILE]
  nforge hosted-work <deployment-url> <project-id> JSON
  nforge coordination <deployment-url> <project-id> JSON
  nforge mcp-coordination <deployment-url> <project-id>
  nforge exchange ROOT push|pull [--target NEW_DIRECTORY]
  nforge exchange <root> push|pull|open|restore|receive-proposal|pull-proposal|reconcile|migrate-archive --command-file FILE
  nforge agent <root> <action> [json | --command-file FILE]
  nforge owner refresh <root>
  nforge recover NEW_OWNER [reconnect|client] --command-file REQUEST.json
  nforge policy <root>
  nforge set-policy <root> JSON
  nforge import-native-git <git-root> <exact-commit> <new-directory>
  nforge export-native-git <native-root> <exact-state> <new-directory> [--reuse <previous-export-dir>]
  nforge restore-native <backup-directory-or-archive> <new-directory> [--journal HOSTED_WORK.json]
  nforge init-native <directory>
  nforge work <git-worktree-root> [command-json expected-revision]
  nforge work <git-worktree-root> --command-file <json-file> <expected-revision>
  nforge restore-work <backup-directory-or-archive> <new-directory> [--journal HOSTED_WORK.json]
  nforge serve <root> [--port N]
  nforge mcp <root> [--work | --agent]
  nforge mcp-agent <forge-convex-deployment-url>
  nforge mcp-config <root> [--agent]
  nforge plugin-config <root> <new-directory>
  nforge local-checks ROOT DEPLOYMENT PROJECT_ID [--name NAME]
  nforge doctor <git-worktree-root>
  nforge index <git-worktree-root>
  nforge status ROOT [--pending] [--json]
  nforge status <git-worktree-root>   # existing graph JSON; --pending selects owner summary
  nforge context <git-worktree-root> [search] [--limit N]
  nforge inspect <git-worktree-root> <name-or-id> [--limit N]
  nforge refs <git-worktree-root> <name-or-id> [--limit N]
  nforge imports <git-worktree-root> <relative-file> [--limit N]
  nforge source <git-worktree-root> <relative-file> [start-line] [end-line]

Query results are JSON; serve runs a token-protected local Git smart-HTTP and Work API (no browser UI; use the hosted app) and mcp speaks stdio. Queries refuse stale source; run index again after edits.
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
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    process.stdout.write(HELP);
    return undefined;
  }
  if (args[0] === 'docs') return docsCli(args.slice(1));
  if (args[0] === '--version') {
    forgeVersion(args);
    return undefined;
  }
  if (args[0] === 'pr' || args[0] === 'repo') return ghCli(args);
  if (['login', 'logout', 'auth'].includes(args[0]!)) return authCli(args[0]!, args.slice(1));
  if (args[0] === 'queue') return queueCli(args.slice(1));
  if (args[0] === 'github-sync') return githubSyncCli(args.slice(1));
  if (args[0] === 'recover') return recoveryCli(args.slice(1));
  if (args[0] === 'owner') {
    invariant(
      args[1] === 'refresh' && args.length === 3 && args[2],
      'BAD_ARGUMENT',
      'Use owner refresh ROOT.',
    );
    return refreshOwnerRoot(new WorkStore(args[2]));
  }
  if (args[0] === 'host') return hostCli(args.slice(1));
  if (args[0] === 'policy' || args[0] === 'set-policy') {
    invariant(
      args[1] &&
        ((args[0] === 'policy' && args.length === 2) || (args[0] === 'set-policy' && args.length === 3)),
      'BAD_ARGUMENT',
      'Use policy ROOT or set-policy ROOT JSON.',
    );
    return agentCli([args[1], args[0], ...(args[2] ? [args[2]] : [])]);
  }
  if (args[0] === 'maintenance') return maintenanceCli(args.slice(1));
  if (args[0] === 'hosted-work') return hostedWorkCli(args.slice(1));
  if (args[0] === 'coordination') return coordinationCli(args.slice(1));
  if (args[0] === 'mcp-coordination') {
    invariant(
      (args.length === 2 || args.length === 3) && args[1],
      'BAD_ARGUMENT',
      'Use mcp-coordination ROOT or DEPLOYMENT PROJECT_ID.',
    );
    const binding = args.length === 2 ? requireHostedBinding(new WorkStore(args[1])) : null;
    await startCoordinationMcp(binding?.deployment ?? args[1], binding?.projectId ?? args[2]!);
    return undefined;
  }
  if (args[0] === 'exchange') return exchangeCli(args.slice(1));
  if (args[0] === 'land') return landCli(args.slice(1));
  if (args[0] === 'agent') return agentCli(args.slice(1));
  if (args[0] === 'local-checks') return localChecksCli(args.slice(1));
  if (args[0] === 'plugin-config') {
    invariant(
      args.length === 3 && args[1] && args[2],
      'BAD_ARGUMENT',
      'Use plugin-config <root> <new-directory>.',
    );
    return pluginConfig(args[1], args[2]);
  }
  if (args[0] === 'mcp-config' && args[2] === '--agent') {
    invariant(args.length === 3 && args[1], 'BAD_ARGUMENT', 'Use mcp-config <root> --agent.');
    return mcpConfig(args[1], { agent: true });
  }
  if (args[0] === 'mcp-agent') {
    invariant(args.length === 2 && args[1], 'BAD_ARGUMENT', 'Use mcp-agent <forge-convex-deployment-url>.');
    await startAgentMcp(args[1], process.env.FORGE_AGENT_TOKEN);
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
      ? importNativeGit(args[1], args[2], args[3])
      : exportNativeGit(args[1], args[2], args[3], args[5]);
  }
  if (args[0] === 'restore-native') {
    invariant(
      args[1] && args[2] && (args.length === 3 || (args.length === 5 && args[3] === '--journal' && args[4])),
      'BAD_ARGUMENT',
      'Use restore-native <backup> <new-directory> [--journal HOSTED_WORK.json].',
    );
    return restoreNativeWork(args[1], args[2], args[4]);
  }
  if (args[0] === 'init-native') {
    invariant(args.length === 2 && args[1], 'BAD_ARGUMENT', 'Use init-native <directory>.');
    return initNative(args[1]);
  }
  if (args[0] === 'restore-work') {
    invariant(
      args[1] && args[2] && (args.length === 3 || (args.length === 5 && args[3] === '--journal' && args[4])),
      'BAD_ARGUMENT',
      'Use restore-work <archive> <new-directory> [--journal HOSTED_WORK.json].',
    );
    return restoreWork(args[1], args[2], args[4]);
  }
  if (args[0] === 'work') {
    if (args[1] === '--help' || args[1] === 'help' || args[2] === '--help') {
      process.stdout.write(
        'nforge work ROOT [--compact | COMMAND_JSON EXPECTED_REVISION]\nnforge work ROOT --command-file FILE EXPECTED_REVISION\nLegacy complete Work interface: release, Playbooks, history, GitHub publication and other recorded actions. For concise task delivery use nforge agent ROOT ACTION --help.\n',
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
    const work = new WorkService(args[1], localAgent());
    if (args.length === 2 || compact) return work.status({ compact });
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
      noticeViewAlias(command.action);
    return work.dispatch(command, Number(args.at(-1)));
  }
  if (args[0] === 'serve') {
    invariant(
      args[1] && (args.length === 2 || (args.length === 4 && args[2] === '--port' && /^\d+$/.test(args[3]!))),
      'BAD_ARGUMENT',
      'Use serve <root> [--port N].',
    );
    const server = await serveRepository(args[1], args[3] === undefined ? 4173 : Number(args[3]));
    process.stdout.write(
      `N:Forge local server: ${server.url}\nGit (/api/git/) and Work (/api/work) accept Authorization: Bearer <token>. Keep it private. Stop with Ctrl+C.\n`,
    );
    const close = () => {
      void server.close();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return undefined;
  }
  if (args[0] === 'mcp') {
    invariant(
      args[1] &&
        !args[1].startsWith('--') &&
        (args.length === 2 || (args.length === 3 && ['--work', '--agent'].includes(args[2]!))),
      'BAD_ARGUMENT',
      'Use mcp <root> [--work | --agent].',
    );
    await startMcp(args[1], args[2] === '--work' || args[2] === '--agent', args[2] === '--agent');
    return undefined;
  }
  if (args[0] === 'status' && args[1] && (args.includes('--pending') || !!nativeOwner(resolve(args[1])))) {
    invariant(
      args.slice(2).every(arg => ['--pending', '--json'].includes(arg)),
      'BAD_ARGUMENT',
      'Use status ROOT [--pending] [--json].',
    );
    const status = readPendingStatus(new WorkStore(args[1]));
    if (args.includes('--json')) return status;
    process.stdout.write(formatPendingStatus(status) + '\n');
    return undefined;
  }
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
  invariant(root && !root.startsWith('--'), 'BAD_ARGUMENT', 'A Git worktree root is required. Use --help.');
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
  if (command === 'mcp-config') return mcpConfig(root);
  if (command === 'doctor') return doctor(root);
  if (command === 'index') {
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
  const query = new RepositoryQuery(root);
  switch (command) {
    case 'status':
      return query.status();
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
function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
try {
  const output = await main(process.argv.slice(2));
  if (output !== undefined) {
    process.stdout.write(
      `${JSON.stringify(output, null, process.argv[2] === 'agent' || (process.argv[2] === 'host' && process.argv.includes('--json')) ? undefined : 2)}\n`,
    );
    if (process.argv[2] === 'agent' && process.argv[4] === 'finish') {
      const result = (output as { result?: { status?: string } }).result;
      if (result?.status === 'awaiting-review')
        process.stderr.write(
          `Next: nforge serve ${shellQuote(process.argv[3]!)} — open Review and accept the checked Candidate as a person.\n`,
        );
    }
  }
} catch (error) {
  // Known errors stay terse; system and unexpected errors also log the stack and name the log.
  const known = error instanceof ForgeError;
  const root = process.argv[2] === 'agent' ? process.argv[3] : undefined;
  const failure = known ? describeFailure(error) : recordFailure(error, root ? resolve(root) : undefined);
  process.stderr.write(`${JSON.stringify({ error: failure })}\n`);
  process.exitCode = 1;
}
