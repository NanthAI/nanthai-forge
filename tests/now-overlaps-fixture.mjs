// SPDX-License-Identifier: Apache-2.0
/** B3.3 A-C: four open Lanes, two gone agents, files shared by several Lanes (no answers since Issue 853fcde3). */
export function overlapNowFixture(state = 'C') {
  const now = Date.parse('2026-10-14T10:20:00Z');
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const names = ['R2 browser bytes', 'Upload retry', 'Docs: llms.txt', 'Rate limit headers'];
  const agents = ['Codex', 'Claude', 'gpt-5-codex', 'gemini-cli'];
  const paths = [
    'src/r2/bytes.ts',
    'src/r2/range.ts',
    'docs/phase5-plan.md',
    'src/r2/upload.ts',
    'src/http/limits.ts',
    'docs/llms.txt',
  ];
  const notices = [
    [0, 1, 0],
    [0, 1, 1],
    [0, 2, 2],
    [0, 1, 3],
    [1, 3, 4],
    [2, 1, 5],
  ];
  const lanes = names.map((name, i) => ({
    id: id(i + 1),
    intentId: id(10 + i),
    name,
    head: 'b'.repeat(64),
    base: 'a'.repeat(64),
    state: 'active',
    assignment: agents[i],
    startedBy: { kind: 'agent', name: agents[i] },
    checkpoints: [],
    checkpointCount: 1,
  }));
  const sessions = agents.map((name, i) => ({
    sessionId: id(20 + i),
    actor: 'viewer',
    name,
    kind: 'agent',
    environment: 'Synthetic',
    status: i === 0 ? 'completed' : 'working',
    summary: i === 0 ? 'streaming range reads' : i === 1 ? 'backoff on 503' : 'writing changes',
    context: { laneId: lanes[i].id },
    lastSeen: now - [41, 1, 4, 120][i] * 60000,
    sequence: 1,
  }));
  if (state === 'B2') {
    sessions[0].status = 'working';
    sessions[0].lastSeen = now - 60000;
  }
  const edits = lanes.map((lane, i) => ({
    laneId: lane.id,
    head: lane.head,
    paths: [...new Set(notices.filter(([a, b]) => a === i || b === i).map(([, , path]) => paths[path]))],
  }));
  return {
    now,
    records: {
      intents: lanes.map((lane, i) => ({ id: lane.intentId, outcome: names[i], status: 'active' })),
      lanes,
      views: [],
      runs: [],
    },
    live: {
      sessions,
      events: [],
      unacked: [],
      unackedComplete: true,
      claims: [],
      sessionsLoading: false,
      eventsComplete: true,
      overlapsComplete: true,
      overlapSignals: { edits, behindMain: [], complete: true },
    },
    viewer: 'viewer',
  };
}
