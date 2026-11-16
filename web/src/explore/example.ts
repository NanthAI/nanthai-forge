// SPDX-License-Identifier: Apache-2.0
import type { WorkData } from '../../../src/work-types';
import type { BriefContext } from '../../../src/agent-brief-types';
import type { ActivityEvent, Session } from '../coordination-view';

/**
 * A deterministic, clearly-labelled example of people and agents working on a real repository,
 * built only from its file names and import relationships. Nothing here is real activity.
 */
export type ExampleInput = {
  repository: string;
  files: readonly string[];
  edges: readonly { from: string; to: string }[];
  instructionFiles: readonly string[];
  now: number;
};

const ids = {
  intents: [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
  ],
  lanes: [
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',
  ],
  views: ['30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003'],
  runs: ['40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003'],
  message: '50000000-0000-4000-8000-000000000001',
};
const oid = (seed: string) => seed.repeat(64).slice(0, 64);
const base = (path: string) => path.split('/').at(-1) ?? path;
const stem = (path: string) =>
  base(path)
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

/** Files ranked by how many others import them; the hubs are where real overlaps happen. */
export function hubs(files: readonly string[], edges: readonly { from: string; to: string }[]): string[] {
  const score = new Map(files.map(file => [file, 0]));
  for (const edge of edges) if (score.has(edge.to)) score.set(edge.to, score.get(edge.to)! + 1);
  const code = files.filter(
    file => !/(^|\/)(test|tests|__tests__|spec)\//i.test(file) && !/\.(md|json|ya?ml)$/i.test(file),
  );
  return [...(code.length ? code : files)].sort(
    (a, b) => score.get(b)! - score.get(a)! || a.localeCompare(b),
  );
}

export function exampleWork(input: ExampleInput) {
  const ranked = hubs(input.files, input.edges);
  const first = ranked[0] ?? 'src/index.ts',
    second = ranked[1] ?? first,
    third = ranked[2] ?? second;
  const name = input.repository.split('/').at(-1) ?? input.repository;
  const at = (minutes: number) => new Date(input.now - minutes * 60_000).toISOString();
  const intents = [
    `Simplify ${base(first)}`,
    `Add tests around ${base(second)}`,
    `Document how ${name} is organised`,
  ].map((outcome, index) => ({
    id: ids.intents[index]!,
    outcome,
    constraints: '',
    base: oid('0'),
    status: 'active' as const,
    notes: [],
    createdAt: at(180 - index * 30),
  }));
  const lane = (index: number, laneName: string, head: string, saveAgo: number, assignment = '') => ({
    id: ids.lanes[index]!,
    intentId: ids.intents[index]!,
    name: laneName,
    base: oid('0'),
    head: oid(head),
    assignment,
    target: '',
    state: 'active' as const,
    checkpoints: [{ head: oid(head), parent: oid('0'), message: 'save', at: at(saveAgo) }],
  });
  const lanes = [
    lane(0, `simplify-${stem(first)}`, '1', 6),
    lane(1, `tests-${stem(second)}`, '2', 25),
    lane(2, 'architecture-notes', '3', 40, 'You'),
  ];
  const view = (index: number, laneIndex: number, head: string, ago: number) => ({
    id: ids.views[index]!,
    intentId: ids.intents[laneIndex]!,
    base: oid('0'),
    inputs: [{ laneId: ids.lanes[laneIndex]!, head: oid(head) }],
    status: 'clean' as const,
    details: '',
    at: at(ago),
    head: oid(`${head}f`),
  });
  const views = [view(0, 1, '2', 22), view(1, 2, '3', 35)];
  const run = (index: number, viewIndex: number, status: 'failed' | 'passed', ago: number) =>
    ({
      id: ids.runs[index]!,
      viewId: ids.views[viewIndex]!,
      status,
      startedAt: at(ago + 4),
      endedAt: at(ago),
      exitCode: status === 'passed' ? 0 : 1,
      check: { name: 'test' },
    }) as unknown as WorkData['runs'][number];
  const runs = [run(0, 0, 'failed', 18), run(1, 1, 'passed', 31)];
  const session = (
    sessionId: string,
    sessionName: string,
    environment: string,
    laneIndex: number,
    summary: string,
    seen: number,
    status: Session['status'] = 'working',
  ) =>
    ({
      _id: sessionId,
      _creationTime: 0,
      projectId: 'example',
      sessionId,
      actor: 'example',
      sequence: 1,
      name: sessionName,
      environment,
      status,
      summary,
      context: { laneId: ids.lanes[laneIndex]! },
      lastSeen: input.now - seen * 1000,
      operationId: sessionId,
    }) as unknown as Session;
  const sessions = [
    session(
      '60000000-0000-4000-8000-000000000001',
      'claude-1',
      'Claude Code',
      0,
      `Splitting ${base(first)}`,
      35,
    ),
    session(
      '60000000-0000-4000-8000-000000000002',
      'codex-2',
      'Codex CLI',
      1,
      'Fixing a failing test',
      80,
      'waiting',
    ),
  ];
  const event = (operationId: string, ago: number, command: ActivityEvent['command'], extra: object = {}) =>
    ({
      _id: operationId,
      _creationTime: 0,
      projectId: 'example',
      operationId,
      actor: 'example',
      at: input.now - ago * 60_000,
      command,
      ...extra,
    }) as unknown as ActivityEvent;
  const question = event(
    ids.message,
    3,
    {
      kind: 'message',
      sessionId: sessions[1]!.sessionId,
      text: `claude-1 is also changing ${base(second)}. Should I wait for it to land, or rebase my tests on top?`,
      context: { laneId: ids.lanes[1]! },
    },
    { recipientActor: 'you' },
  );
  const claims = [
    { actor: 'example', sessionId: sessions[0]!.sessionId, paths: [first, second], laneId: ids.lanes[0]! },
    { actor: 'example', sessionId: sessions[1]!.sessionId, paths: [second, third], laneId: ids.lanes[1]! },
  ];
  const events = [
    question,
    event('70000000-0000-4000-8000-000000000001', 6, {
      kind: 'claim',
      sessionId: sessions[0]!.sessionId,
      paths: [first, second],
      laneId: ids.lanes[0]!,
      ttlSeconds: 3600,
    }),
    event('70000000-0000-4000-8000-000000000002', 18, {
      kind: 'change',
      source: 'work',
      action: 'check failed',
      laneId: ids.lanes[1]!,
      pathCount: 2,
    }),
    event('70000000-0000-4000-8000-000000000003', 31, {
      kind: 'change',
      source: 'work',
      action: 'check passed',
      laneId: ids.lanes[2]!,
      pathCount: 1,
    }),
  ];
  return {
    records: { intents, lanes, views, runs } as unknown as Pick<
      WorkData,
      'intents' | 'lanes' | 'views' | 'runs'
    >,
    sessions,
    events,
    unacked: [question],
    claims,
    files: { first, second, third },
  };
}

/** The briefing context an agent would receive for the example's failing-check Lane. */
export function exampleBriefContext(
  input: ExampleInput,
  example: ReturnType<typeof exampleWork>,
): BriefContext {
  const { first, second, third } = example.files;
  return {
    intentId: ids.intents[1],
    laneId: ids.lanes[1],
    runId: ids.runs[0],
    intent: { outcome: `Add tests around ${base(second)}`, constraints: '', notes: [], status: 'active' },
    lane: { name: `tests-${stem(second)}`, head: oid('2'), base: oid('0'), state: 'active' },
    run: {
      status: 'failed',
      check: 'test',
      failureSummary: `✖ ${base(second)} handles empty input\n  AssertionError: expected [] to equal undefined`,
    },
    paths: [second, third],
    conflictPaths: [],
    instructionFiles: [...input.instructionFiles],
    main: { head: oid('0'), changedPaths: [], merged: false },
    claims: [
      {
        id: 'c1',
        actor: 'claude-1',
        sessionId: 'example',
        paths: [first, second],
        laneId: ids.lanes[0],
        overlapping: [second],
      },
    ],
    messages: [],
    guidance: { project: '', personal: '' },
    coverage: ['Example only: built from file names and imports of the public repository.'],
  };
}
export const exampleIds = ids;
