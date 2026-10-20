import { noticeViewAlias, canonicalCandidateAction } from './candidate-names.js';
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { AgentWorkflow } from './agent-workflow.js';
import { invariant } from './errors.js';
import { mergeLane } from './gh-cli-merge.js';
import { ghFields, parseGhOptions, projectGh } from './gh-cli-options.js';
import { currentLane, laneChecks, laneRow, repoRow } from './gh-cli-reads.js';
import { ensureLaneDirectory } from './agent-lane-directory.js';
import { readAgentReview } from './agent-review.js';

const help = `nforge --version
nforge auth status [DEPLOYMENT_URL] [--hostname HOST] [--json [fields]]
nforge repo candidate [ROOT] [--repo ROOT] [--json [fields]]
nforge pr list|candidate|create|checks|merge|diff|checkout [LANE_ID] [--repo ROOT] [--json [fields]]
create: --title TEXT [--body TEXT | --body-file FILE] [--base CHANNEL] [--operation-id UUID]
list: [--state open|closed|merged|all]
merge: [--subject TEXT] [--operation-id UUID] [--match-head-commit HEAD]
diff: [--offset N] [--limit N] (structured live review with contextual hunks)
checkout returns the existing isolated Lane path; it does not change your shell directory.
view is a deprecated alias for candidate (one stderr notice per invocation).
Lane UUIDs are stable PR selectors. merge calls agent finish with normal checks and policy.
--json without fields returns all fields. --jq and unlisted gh flags are unsupported.
`;
export async function ghCli(args: string[]): Promise<unknown> {
  const [family, requestedVerb, ...rest] = args;
  if (requestedVerb) noticeViewAlias(requestedVerb);
  const verb = requestedVerb ? canonicalCandidateAction(requestedVerb) : undefined;
  invariant(family === 'pr' || family === 'repo', 'BAD_ARGUMENT', help);
  if (verb === '--help' || (rest.length === 1 && rest[0] === '--help')) {
    process.stdout.write(help);
    return undefined;
  }
  invariant(
    verb &&
      (family === 'repo'
        ? verb === 'view'
        : ['list', 'view', 'create', 'checks', 'merge', 'diff', 'checkout'].includes(verb)),
    'BAD_ARGUMENT',
    help,
  );
  const kind =
    family === 'repo'
      ? 'repo'
      : verb === 'merge' || verb === 'checks' || verb === 'diff' || verb === 'checkout'
        ? verb
        : 'pr';
  const flags = [
    '--repo',
    ...(verb === 'create' ? ['--title', '--body', '--body-file', '--base', '--operation-id'] : []),
    ...(verb === 'merge' ? ['--subject', '--operation-id', '--match-head-commit'] : []),
    ...(verb === 'list' ? ['--state'] : []),
    ...(verb === 'diff' ? ['--offset', '--limit'] : []),
  ];
  const options = parseGhOptions(rest, kind, flags),
    { values, positional } = options;
  invariant(positional.length <= (verb === 'create' || verb === 'list' ? 0 : 1), 'BAD_ARGUMENT', help);
  if (verb === 'create') {
    invariant(values['--title']?.trim(), 'BAD_ARGUMENT', 'Provide --title for the Intent outcome.');
    invariant(
      !(values['--body'] !== undefined && values['--body-file'] !== undefined),
      'BAD_ARGUMENT',
      'Choose --body or --body-file.',
    );
  }
  if (verb === 'list')
    invariant(
      ['open', 'closed', 'merged', 'all'].includes(values['--state'] ?? 'open'),
      'BAD_ARGUMENT',
      'Use --state open|closed|merged|all.',
    );
  invariant(
    !(family === 'repo' && positional.length && values['--repo']),
    'BAD_ARGUMENT',
    'Select ROOT or --repo ROOT, not both.',
  );
  const root = values['--repo'] ?? (family === 'repo' ? positional[0] : undefined) ?? process.cwd(),
    agent = new AgentWorkflow(root),
    store = agent.work.store;
  let output: unknown;
  if (family === 'repo') output = repoRow(store, store.load());
  else if (verb === 'create') {
    const response = await agent.dispatch({
      action: 'start',
      outcome: values['--title'],
      constraints:
        values['--body-file'] === undefined ? values['--body'] : readFileSync(values['--body-file'], 'utf8'),
      ...(values['--base'] ? { channel: values['--base'] } : {}),
      ...(values['--operation-id'] ? { operationId: values['--operation-id'] } : {}),
    });
    const id = (response.result as { laneId: string }).laneId;
    output = {
      ...laneRow(store, store.load(), store.select('lanes', id)!),
      operationId: (response.result as { operationId: string }).operationId,
    };
  } else if (verb === 'list') {
    const data = store.load(),
      state = values['--state'] ?? 'open';
    output = data.lanes
      .map(lane => laneRow(store, data, lane))
      .filter(row => state === 'all' || row.state.toLowerCase() === state);
  } else {
    const lane = currentLane(store, positional[0]);
    if (verb === 'merge') {
      output = await mergeLane(agent, lane, values);
    } else if (verb === 'checkout') {
      ensureLaneDirectory(store, lane.id);
      const path = store.path(lane.id);
      invariant(
        existsSync(path) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
        'LANE_UNAVAILABLE',
        'The Lane directory is unavailable.',
      );
      output = { laneId: lane.id, head: lane.head, path };
    } else if (verb === 'checks') {
      const rows = laneChecks(store.load(), lane);
      output = rows;
      process.exitCode = rows.some(row => ['fail', 'cancel'].includes(row.bucket))
        ? 1
        : !rows.length || rows.some(row => row.bucket === 'pending')
          ? 8
          : 0;
    } else if (verb === 'diff') {
      const offset = Number(values['--offset'] ?? 0),
        limit = Number(values['--limit'] ?? 20);
      invariant(
        Number.isSafeInteger(offset) &&
          offset >= 0 &&
          Number.isSafeInteger(limit) &&
          limit >= 1 &&
          limit <= 100,
        'BAD_ARGUMENT',
        'Use --offset >= 0 and --limit 1..100 (existing review page size).',
      );
      const input = {
        kind: 'lane' as const,
        id: lane.id,
        expectedHead: lane.head,
        offset,
        limit,
        maxBytes: 48000,
      };
      const summary = readAgentReview(store, input).result;
      invariant('more' in summary, 'SOURCE_UNAVAILABLE', 'Lane review is unavailable.');
      const changes = summary.changes as { path: string }[];
      const detailed = readAgentReview(store, {
        ...input,
        offset: 0,
        paths: changes.map(change => change.path),
        expectedReviewTree: 'reviewTree' in summary ? summary.reviewTree : undefined,
      }).result;
      invariant('more' in detailed, 'SOURCE_UNAVAILABLE', 'Lane review is unavailable.');
      output = {
        ...detailed,
        offset,
        more: detailed.more || summary.more,
        nextOffset: detailed.more ? offset + detailed.changes.length : summary.nextOffset,
      };
    } else output = laneRow(store, store.load(), lane);
  }
  // All unsupported flags/fields were validated before a mutation.
  return projectGh(output, options.fields);
}
export function forgeVersion(args: string[]) {
  invariant(args.length === 1, 'UNSUPPORTED_FLAG', `Unsupported flag: ${args[1]}`);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  process.stdout.write(`nforge version ${pkg.version}\n`);
}
export { ghFields };
