// SPDX-License-Identifier: Apache-2.0
import { readLaneSubmissions } from './landing-submission-read.js';
import type { WorkStore } from './work-store.js';
import type { PeersDigest } from './agent-peers.js';

/** Shared by live peers and cached receipt advice. Reads indexed Work and retained
 * landing journals only; no source capture, network request or writer admission. */
export function withPeerLanding(store: WorkStore, digest: PeersDigest): PeersDigest {
  let submissions: ReturnType<typeof readLaneSubmissions> | undefined;
  const cache = new Map<string, unknown>();
  const describe = (id: string) => {
    if (cache.has(id)) return cache.get(id);
    const lane = store.select('lanes', id, 'id', true);
    if (!lane) return;
    submissions ??= readLaneSubmissions(store, undefined, undefined, false);
    const submission = submissions
      .filter(item => item.laneId === id && item.attemptHead === lane.head)
      .at(-1);
    const tx = store.readRecords();
    const views = (
      tx
        ? tx.all('views', lane.intentId, 'intentId')
        : store.load().views.filter(view => view.intentId === lane.intentId)
    ).filter(view => view.inputs.some(pin => pin.laneId === id && pin.head === lane.head));
    const positions = tx
      ? views.flatMap(view => tx.positions('runs', view.id, 'viewId')).sort((a, b) => a - b)
      : [];
    const runs = tx
      ? positions.map(position => tx.at('runs', position))
      : store.load().runs.filter(run => views.some(view => view.id === run.viewId));
    const run = runs
      .filter(run => views.some(view => view.id === run.viewId && view.head === run.head))
      .at(-1);
    const phase =
      submission?.state === 'landed'
        ? 'landed'
        : submission?.state === 'terminal-failed'
          ? 'failed'
          : submission && !submission.terminal
            ? submission.pendingReason === 'checking'
              ? 'in-batch'
              : 'queued'
            : run?.status === 'passed'
              ? 'checked-green'
              : run && !['queued', 'preparing', 'running'].includes(run.status)
                ? 'failed'
                : 'editing';
    const suggestedAction =
      phase === 'landed'
        ? 'Sync main to use its accepted interface.'
        : phase === 'failed'
          ? 'Read its check result and coordinate the repair.'
          : phase === 'queued' || phase === 'in-batch'
            ? run?.status === 'passed'
              ? 'Queued with a green run: build against its saved interface and sync after it lands.'
              : 'Build against its saved interface and sync after it lands.'
            : phase === 'checked-green'
              ? 'Stack on it, or coordinate landing order.'
              : 'Coordinate the saved interface or stack on it.';
    const value = {
      phase,
      head: lane.head,
      ...(submission
        ? {
            handle: submission.handle ?? {
              operationId: submission.operationId,
              entryIds: [submission.entryOperationId],
            },
            state: submission.state,
          }
        : {}),
      latestCheck: run
        ? {
            runId: run.id,
            status: run.status,
            head: run.head,
            laneHead: lane.head,
            endedAt: run.endedAt ?? null,
          }
        : null,
      suggestedAction,
    };
    cache.set(id, value);
    return value;
  };
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, key === 'landing' ? item : visit(item)]),
    );
    const id =
      typeof record.lane === 'string'
        ? record.lane
        : typeof record.laneId === 'string'
          ? record.laneId
          : undefined;
    if (id) result.landing = describe(id);
    return result;
  };
  return visit(digest) as PeersDigest;
}
