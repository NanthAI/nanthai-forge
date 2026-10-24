import { briefInputSchema } from '../dist/agent-brief-types.js';
import { briefingContext } from '../dist/agent-brief-context.js';
import { renderBriefing } from '../dist/agent-brief-render.js';
export const ids = {
  intent: '11111111-1111-4111-8111-111111111111',
  lane: '22222222-2222-4222-8222-222222222222',
  view: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
  message: '55555555-5555-4555-8555-555555555555',
  handoff: '66666666-6666-4666-8666-666666666666',
};
export const base = 'a'.repeat(64),
  head = 'b'.repeat(64),
  main = 'c'.repeat(64);
const file = (path, blob = '0'.repeat(64)) => ({ path, blob, mode: 'file' });
export const states = new Map([
  [base, { parents: [], files: [file('AGENTS.md'), file('CLAUDE.md'), file('src/check.ts')] }],
  [
    head,
    {
      parents: [base],
      files: [
        file('AGENTS.md'),
        file('CLAUDE.md'),
        file('.cursor/rules/types.mdc'),
        file('src/check.ts', '1'.repeat(64)),
      ],
    },
  ],
  [
    main,
    {
      parents: [base],
      files: [
        file('AGENTS.md'),
        file('CLAUDE.md'),
        file('src/check.ts', '2'.repeat(64)),
        file('src/accepted.ts'),
      ],
    },
  ],
]);
export const records = {
  intents: [
    {
      id: ids.intent,
      outcome: 'Keep check evidence scoped to its View',
      constraints: 'Preserve accepted work.',
      base,
      status: 'active',
      createdAt: 'now',
      notes: [{ kind: 'comment', text: 'Check the failure path too.', at: 'now' }],
    },
  ],
  lanes: [
    {
      id: ids.lane,
      intentId: ids.intent,
      name: 'check-scope',
      head,
      base,
      state: 'active',
      assignment: '',
      target: '',
      checkpoints: [],
      pendingMerge: {
        parent: main,
        channel: 'main',
        operation: { id: ids.message, request: head },
        conflicts: [{ path: 'src/check.ts', kind: 'text' }],
      },
    },
  ],
  views: [
    {
      id: ids.view,
      intentId: ids.intent,
      base,
      head,
      inputs: [{ laneId: ids.lane, head }],
      status: 'conflict',
      details: '',
      at: 'now',
    },
  ],
  runs: [
    {
      id: ids.run,
      viewId: ids.view,
      head,
      base,
      status: 'failed',
      check: { name: 'verify' },
      failureSummary: 'not ok 3 - evidence follows the exact View',
    },
  ],
  channels: [{ name: 'main', head: main }],
  events: [
    {
      id: ids.message,
      actor: 'reviewer',
      kind: 'message',
      text: 'Please inspect check ownership.',
      intentId: ids.intent,
      laneId: ids.lane,
      paths: ['src/check.ts'],
    },
    {
      id: ids.handoff,
      actor: 'worker',
      kind: 'handoff',
      text: 'Continue from the failed check.',
      intentId: ids.intent,
      laneId: ids.lane,
      paths: [],
    },
  ],
  claims: [{ id: 'claim', actor: 'worker-2', paths: ['src/'], intentId: ids.intent }],
};
export const guidance = {
  project: 'Run the configured verify check.',
  personal: 'Explain the result briefly.',
};
export function fixtureBrief(situation, agent) {
  const input = briefInputSchema.parse({
    situation,
    agent,
    ...(['start-intent', 'add-lane', 'land-together'].includes(situation)
      ? { intentId: ids.intent }
      : situation === 'take-handoff'
        ? { messageId: ids.handoff }
        : situation === 'answer-message'
          ? { messageId: ids.message }
          : { laneId: ids.lane }),
  });
  const selectedRecords = ['add-lane', 'land-together'].includes(situation)
    ? {
        ...records,
        lanes: [
          ...records.lanes,
          { ...records.lanes[0], id: '77777777-7777-4777-8777-777777777777', name: 'check-ui' },
        ],
      }
    : records;
  const context = briefingContext(
    input,
    selectedRecords,
    id => states.get(id),
    guidance,
    () => records.runs[0].failureSummary,
  );
  return renderBriefing(input, context, '/forge/demo', '2026-10-14T10:00:00.000Z');
}
