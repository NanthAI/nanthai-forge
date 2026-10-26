// SPDX-License-Identifier: Apache-2.0
import type { ConflictEvidence, RepairResolution, SyncLineage } from './agent-repair-types.js';
import { digest } from './hash.js';
import { markNativeTextConflicts, attributionLines, attributionEdits } from './native-text-merge.js';
import { readHostState } from './host-binding.js';
import type { PeersSource } from './agent-peers-source.js';
import type { NativeFile } from './native-source.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';
import type { NativeMergeConflict } from './native-merge.js';

export const noticeChoices = ['accept-order', 'swap', 'split'] as const;
export type NoticeParticipant = {
  lane: string;
  workspace?: string;
  head: string;
  intentId: string;
  intent: string;
  owner: Lane['startedBy'] | null;
  sessions: string[];
  message: string;
  state: string;
  startedAt: string;
};
export type ConflictNotice = {
  evidence?: ConflictEvidence[];
  resolutions?: RepairResolution[];
  syncs?: SyncLineage[];
  repairIntentId?: string;
  applicability?: 'current' | 'historical';
  integration?: {
    applicability?: 'current' | 'historical';
    main: string;
    key: string;
    errors: string[];
    inputs?: { laneId: string; head: string }[];
  };
  noticeId: string;
  kind: 'conflict-notice';
  granularity: 'file' | 'symbol';
  participants: NoticeParticipant[];
  proposedOrder: string[];
  reason: string;
  choices: readonly string[];
  conflicts: {
    path: string;
    kind: 'text' | 'binary' | 'path';
    hunk?: string;
    base?: NativeFile;
    left?: NativeFile;
    right?: NativeFile;
    entries?: { left: NativeFile[]; right: NativeFile[] };
  }[];
  decisions?: { operationId: string; laneId: string; choice: string; text?: string }[];
  after?: string;
  detail?: string;
};
export function noticeParticipant(store: WorkStore, source: PeersSource, lane: Lane): NoticeParticipant {
  const tx = store.readRecords(),
    intent =
      tx?.fields('intents', lane.intentId)?.record ??
      (!tx ? store.load().intents.find(item => item.id === lane.intentId) : undefined);
  const host = readHostState(store);
  const sessions = [
    ...new Set([
      ...Object.values(host.presence ?? {})
        .filter(row => row.context.laneId === lane.id)
        .map(row => row.sessionId),
      ...Object.values(host.selfReports ?? {})
        .filter(row => row.laneId === lane.id)
        .flatMap(row => (row.sessionId ? [row.sessionId] : [])),
    ]),
  ].sort();
  const views = tx?.positions('views', lane.intentId, 'intentId') ?? [];
  const checking = views.some(position => {
    const view = tx!.at('views', position);
    return (
      view.inputs.some(input => input.laneId === lane.id && input.head === lane.head) &&
      tx!
        .positions('runs', view.id, 'viewId')
        .some(index => ['running', 'queued'].includes(tx!.fieldsAt('runs', index).record.status))
    );
  });
  return {
    lane: lane.id,
    workspace: store.path(lane.id),
    head: lane.head,
    intentId: lane.intentId,
    intent: intent?.outcome ?? '',
    owner: lane.owner ? { kind: 'agent', name: lane.owner.actor } : (lane.startedBy ?? null),
    sessions,
    message: source.state(lane.head).message,
    state: checking ? 'checking' : lane.state,
    startedAt: intent?.createdAt ?? '',
  };
}

/** An extensible file-classification envelope. No model invocation or resolution:
 * the receiving agent decides using exact source pins and unabridged hunks. */
export function conflictNotice(
  source: PeersSource,
  participants: NoticeParticipant[],
  left: string,
  right: string,
  conflicts: NativeMergeConflict[],
  pathConflicts: string[] = [],
): ConflictNotice | undefined {
  if (!conflicts.length && !pathConflicts.length) return;
  const pins = participants.map(p => [p.lane, p.head]);
  const amount = (side: 'left' | 'right') =>
    conflicts.reduce((sum, c) => {
      const base = c.base ? source.object(c.base.blob) : Buffer.alloc(0);
      const bytes = c[side] ? source.object(c[side]!.blob) : Buffer.alloc(0);
      const before = attributionLines(base),
        after = attributionLines(bytes);
      const edits = before && after ? attributionEdits(before, after) : null;
      return (
        sum +
        (edits ? edits.reduce((n, e) => n + e.end - e.start + e.lines.length, 0) : base.length + bytes.length)
      );
    }, 0);
  const sizes = [amount('left'), amount('right')];
  const rank = (p: NoticeParticipant) => (p.state === 'checking' ? 2 : p.state === 'ready' ? 1 : 0);
  const ordered = participants
    .map((p, i) => ({ p, size: sizes[i] ?? 0 }))
    .sort(
      (a, b) =>
        rank(b.p) - rank(a.p) ||
        a.size - b.size ||
        a.p.startedAt.localeCompare(b.p.startedAt) ||
        a.p.lane.localeCompare(b.p.lane),
    );
  return {
    noticeId: digest(JSON.stringify([pins, conflicts, pathConflicts])),
    kind: 'conflict-notice',
    evidence: [
      {
        kind: 'text',
        source: 'native-merge',
        inputs: participants.map(p => ({ laneId: p.lane, head: p.head })),
        errors: [...conflicts.map(c => c.path), ...pathConflicts],
      },
    ],
    granularity: 'file',
    participants,
    proposedOrder: ordered.map(item => item.p.lane),
    reason: 'Closer to landing, then smaller conflicting diff, then earlier start (Lane id breaks ties).',
    choices: noticeChoices,
    conflicts: [
      ...conflicts.map(c => {
        const marked =
          c.base && c.left && c.right
            ? markNativeTextConflicts(
                source.object(c.base.blob),
                source.object(c.left.blob),
                source.object(c.right.blob),
                [participants[0]!.lane, participants[1]!.lane],
              )
            : null;
        // Add/delete conflicts also expose all exact bytes when textual.
        const text = (file?: NativeFile) => (file ? source.object(file.blob) : Buffer.alloc(0));
        const bytes = [text(c.base), text(c.left), text(c.right)];
        const textual = bytes.every(b => !b.includes(0) && Buffer.from(b.toString('utf8')).equals(b));
        return {
          ...c,
          kind: marked || textual ? ('text' as const) : ('binary' as const),
          ...(marked
            ? { hunk: marked.bytes.toString('utf8') }
            : textual
              ? {
                  hunk: `<<<<<<< ${participants[0]!.lane}\n${bytes[1]!.toString('utf8')}||||||| base\n${bytes[0]!.toString('utf8')}=======\n${bytes[2]!.toString('utf8')}>>>>>>> ${participants[1]!.lane}\n`,
                }
              : {}),
        };
      }),
      ...pathConflicts.map(path => ({
        path,
        kind: 'path' as const,
        entries: {
          left: source
            .state(left)
            .files.filter(file => file.path === path || file.path.startsWith(path + '/')),
          right: source
            .state(right)
            .files.filter(file => file.path === path || file.path.startsWith(path + '/')),
        },
      })),
    ],
  };
}
