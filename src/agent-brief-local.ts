// SPDX-License-Identifier: Apache-2.0
import { stackStatus } from './agent-stack.js';
import { agentPeers } from './agent-peers.js';
import { currentPlanning } from './work-planning-state.js';
import { planningBriefIntent } from './work-planning-lifecycle.js';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { laneOwnership } from './agent-ownership.js';
import { localAgentSetup } from './agent-setup.js';
import { effectivePolicy } from './autonomy-policy.js';
import { briefInputSchema, type BriefRecords, type BriefState } from './agent-brief-types.js';
import { briefingContext } from './agent-brief-context.js';
import { renderBriefing } from './agent-brief-render.js';
import { localGuidance } from './agent-guidance.js';
import { NativeSource } from './native-source.js';
import { channelHeads } from './agent-lifecycle.js';
import { workGit, gitIsAncestor } from './work-git.js';
import { failureSummary } from './agent-run-failure.js';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
export function localBrief(store: WorkStore, input: unknown, liveMcp = false) {
  const parsed = briefInputSchema.safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Choose a briefing situation, linked records and agent variant.');
  const data = store.load();
  const coordination = new CoordinationJournal(store).context(parsed.data.laneId);
  const records: BriefRecords = {
    ...(data.decisions ? { decisions: data.decisions } : {}),
    intents: [
      ...data.intents,
      ...currentPlanning(data)
        .filter(item => !data.intents.some(intent => intent.id === item.id))
        .flatMap(item => planningBriefIntent(item) ?? []),
    ],
    lanes: data.lanes,
    views: data.views,
    runs: data.runs,
    channels: channelHeads(store, data),
    events: coordination.messages,
    claims: [],
  };
  const states = new Map<string, BriefState>();
  const source = store.native ? new NativeSource(store.root) : undefined;
  const state = (id: string): BriefState | undefined => {
    let result = states.get(id);
    if (result) return result;
    if (source) {
      const item = source.state(id);
      result = { files: item.files, parents: item.parents };
    } else {
      const files = workGit(store.root, ['ls-tree', '-r', '-z', id])
        .split('\0')
        .filter(Boolean)
        .map(row => {
          const split = row.indexOf('\t'),
            metadata = row.slice(0, split),
            path = row.slice(split + 1);
          const [mode, , blob] = metadata!.split(' ');
          return { path: path!, mode: mode!, blob: blob! };
        });
      result = { files, parents: [] };
    }
    states.set(id, result);
    return result;
  };
  const context = briefingContext(parsed.data, records, state, localGuidance(store), id => {
    const run = data.runs.find(r => r.id === id)!;
    return run.failureSummary ?? failureSummary(store, run);
  });
  context.autonomyPolicy = effectivePolicy(data);
  const selectedLane = data.lanes.find(lane => lane.id === context.laneId);
  if (selectedLane?.stack) context.stack = stackStatus(store, selectedLane)!.summary;
  if (selectedLane) context.ownership = laneOwnership(store, selectedLane);
  if (coordination.handovers.some(row => row.operationId === context.messageId)) context.handoverTaken = true;
  if (context.lane && context.laneId) context.lane.path = store.path(context.laneId);
  if (!store.native && context.lane) {
    context.main.merged =
      context.lane.head !== context.lane.base &&
      records.channels.some(c => !!c.head && gitIsAncestor(store.root, context.lane!.head, c.head));
  }
  context.coverage.push(
    'Local handovers and conflict negotiation are included; hosted messages and claims require a hosted coordination binding.',
  );
  const briefing = renderBriefing(
    parsed.data,
    context,
    store.root,
    new Date().toISOString(),
    undefined,
    localAgentSetup(store.root, liveMcp),
  );
  return Object.assign(
    briefing,
    context.laneId ? { peers: agentPeers(store, { laneId: context.laneId }) } : {},
  );
}
