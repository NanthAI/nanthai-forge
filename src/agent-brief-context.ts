// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { overlappingPaths } from './coordination-paths.js';
import type { BriefInput, BriefState, BriefRecords, BriefContext } from './agent-brief-types.js';

/** Instruction names only, from the exact relevant State; no repository bytes enter a prompt. */
export function instructionFiles(paths: string[]): string[] {
  return [
    ...new Set(
      paths.filter(path => {
        const name = path.toLowerCase();
        return (
          /(^|\/)(agents\.md|claude\.md|gemini\.md|\.windsurfrules)$/.test(name) ||
          /(^|\/)\.cursor\/rules\/[^/]+(?:\/[^/]+)*$/.test(name) ||
          /(^|\/)\.github\/copilot-instructions\.md$/.test(name)
        );
      }),
    ),
  ].sort();
}
export function changedPaths(a: BriefState, b: BriefState): string[] {
  const before = new Map(a.files.map(f => [f.path, `${f.blob}:${f.mode}`]));
  const after = new Map(b.files.map(f => [f.path, `${f.blob}:${f.mode}`]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(path => before.get(path) !== after.get(path))
    .sort();
}
export function selectBrief(input: BriefInput, records: BriefRecords) {
  const message = input.messageId ? records.events.find(e => e.id === input.messageId) : undefined;
  invariant(!input.messageId || message, 'NOT_FOUND', 'Message or handoff not found.');
  const run = input.runId ? records.runs.find(r => r.id === input.runId) : undefined;
  invariant(!input.runId || run, 'NOT_FOUND', 'Check run not found.');
  const viewId = input.viewId ?? run?.viewId;
  let view = viewId ? records.views.find(v => v.id === viewId) : undefined;
  invariant(!viewId || view, 'NOT_FOUND', 'Candidate not found.');
  invariant(!run || !view || run.viewId === view.id, 'BAD_ARGUMENT', 'Run and Candidate differ.');
  const laneId = input.laneId ?? message?.laneId ?? view?.inputs[0]?.laneId;
  const lane = laneId ? records.lanes.find(l => l.id === laneId) : undefined;
  invariant(!laneId || lane, 'NOT_FOUND', 'Lane not found.');
  if (!view && lane) view = [...records.views].reverse().find(v => v.inputs.some(i => i.laneId === lane.id));
  invariant(
    !lane || !view || view.inputs.some(i => i.laneId === lane.id),
    'BAD_ARGUMENT',
    'Lane and Candidate differ.',
  );
  const intentId = input.intentId ?? lane?.intentId ?? view?.intentId ?? message?.intentId;
  const intent = intentId ? records.intents.find(i => i.id === intentId) : undefined;
  invariant(!intentId || intent, 'NOT_FOUND', 'Intent not found.');
  invariant(
    [lane?.intentId, view?.intentId, message?.intentId].every(id => !id || id === intentId),
    'BAD_ARGUMENT',
    'Selected records belong to different Intents.',
  );
  invariant(!message?.laneId || message.laneId === laneId, 'BAD_ARGUMENT', 'Message and Lane differ.');
  if (['start-intent', 'add-lane', 'land-together'].includes(input.situation))
    invariant(intent, 'BAD_ARGUMENT', 'Choose an Intent.');
  if (
    ['continue-lane', 'resolve-conflict', 'fix-failed-check', 'review-and-accept'].includes(input.situation)
  )
    invariant(lane || view, 'BAD_ARGUMENT', 'Choose a Lane or Candidate.');
  if (input.situation === 'take-handoff' || input.situation === 'answer-message')
    invariant(
      message?.kind === (input.situation === 'take-handoff' ? 'handoff' : 'message'),
      'BAD_ARGUMENT',
      'Choose the matching message or handoff.',
    );
  const selectedRun = run ?? [...records.runs].reverse().find(r => r.viewId === view?.id);
  return { intent, lane, view, run: selectedRun, message };
}
export function briefingContext(
  input: BriefInput,
  records: BriefRecords,
  state: (head: string) => BriefState | undefined,
  guidance: BriefContext['guidance'],
  summary: (id: string) => string,
): BriefContext {
  const { intent, lane, view, run, message } = selectBrief(input, records);
  const head =
    (input.viewId || input.runId ? view?.head : undefined) ?? lane?.head ?? view?.head ?? intent?.base;
  const base = lane?.base ?? view?.base ?? intent?.base;
  const main = records.channels.find(c => c.name === 'main')?.head ?? null;
  const coverage: string[] = [];
  const read = (id: string | undefined | null) => {
    const found = id ? state(id) : undefined;
    if (id && !found)
      coverage.push(`Source paths unavailable for State ${id}; use local brief for source context.`);
    return found;
  };
  const selected = read(head),
    original = read(base),
    accepted = read(main);
  const paths = original && selected ? changedPaths(original, selected) : [];
  const sourcePaths = new Set(
    [
      ...(original?.files ?? []),
      ...(selected?.files ?? []),
      ...(view?.inputs.flatMap(pin => state(pin.head)?.files ?? []) ?? []),
    ].map(file => file.path),
  );
  const conflictPaths = [
    ...new Set([
      ...(lane?.pendingMerge?.conflicts.map(c => c.path) ?? []),
      ...(view?.status === 'conflict' &&
      view.details.startsWith('Conflicting native paths (both original States retained):\n')
        ? view.details
            .split('\n')
            .slice(1)
            .filter(path => sourcePaths.has(path))
        : view?.status === 'conflict'
          ? view.details
              .split('\n')
              .filter(line => /^\d{6} [0-9a-f]+ [123]\t/.test(line))
              .map(line => line.slice(line.indexOf('\t') + 1))
              .filter(path => sourcePaths.has(path))
          : []),
    ]),
  ].sort();
  // Exact manifest ancestry, never an absent graph edge, establishes merged state.
  const ancestors = new Set<string>();
  const pending = main ? [main] : [];
  let complete = true;
  while (pending.length) {
    const id = pending.pop()!;
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    const item = state(id);
    if (item) pending.push(...item.parents);
    else complete = false;
  }
  const scopes = [...new Set([...paths, ...conflictPaths, ...(message?.paths ?? [])])];
  const relevant = (item: { intentId?: string; laneId?: string; paths: string[] }) =>
    (!!intent && item.intentId === intent.id) ||
    (!!lane && item.laneId === lane.id) ||
    overlappingPaths(scopes, item.paths).length > 0;
  const siblings = records.lanes.filter(item => item.intentId === intent?.id && item.id !== lane?.id);
  return {
    ...(siblings.length
      ? {
          siblingLanes: siblings.map(item => ({
            laneId: item.id,
            name: item.name,
            head: item.head,
            base: item.base,
            state: item.state,
            ...(item.after ? { after: item.after } : {}),
          })),
        }
      : {}),
    ...(intent
      ? {
          intentId: intent.id,
          intent: {
            outcome: intent.outcome,
            constraints: intent.constraints,
            notes: intent.notes.map(n => ({ kind: n.kind, text: n.text, at: n.at })),
            status: intent.status,
          },
        }
      : {}),
    ...(lane
      ? {
          laneId: lane.id,
          lane: {
            name: lane.name,
            head: lane.head,
            base: lane.base,
            state: lane.state,
            ...(lane.after ? { after: lane.after } : {}),
          },
        }
      : {}),
    ...(view
      ? {
          viewId: view.id,
          view: {
            status: view.status,
            base: view.base,
            inputs: view.inputs,
            ...(view.head ? { head: view.head } : {}),
          },
        }
      : {}),
    ...(run
      ? {
          runId: run.id,
          run: {
            status: run.status,
            check: run.check.name,
            failureSummary: run.status === 'failed' ? summary(run.id) : '',
          },
        }
      : {}),
    ...(message ? { messageId: message.id } : {}),
    paths,
    conflictPaths,
    instructionFiles: instructionFiles(selected?.files.map(f => f.path) ?? []),
    main: {
      head: main,
      changedPaths: original && accepted ? changedPaths(original, accepted) : [],
      merged: lane
        ? lane.head !== lane.base && (ancestors.has(lane.head) ? true : complete ? false : null)
        : null,
    },
    claims: records.claims
      .filter(relevant)
      .map(c => ({ ...c, overlapping: overlappingPaths(scopes, c.paths) })),
    messages: records.events.filter(e => e.id === message?.id || relevant(e)),
    guidance,
    coverage,
  };
}
