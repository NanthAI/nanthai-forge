// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { composePageSchema } from './hosted-compose.js';
import { invariant } from './errors.js';
import type { MetricInput, MetricRecords } from './self-metrics-types.js';
export type MetricPin = { sha256: string; size: number };
export type MetricObjects = (pins: MetricPin[]) => Promise<Uint8Array[]>;
export type MetricAttempt = {
  id: string;
  submissionId: string;
  at: string;
  parentAttemptId: string | null;
  mainHead: string | null;
  inputPin?: MetricPin | null | undefined;
  runId: string | null;
};
export type MetricLane = { id: string; version: number; intentId: string; revert: boolean };
export type MetricSave = { id: string; laneId: string; head: string; at: string };

/** Read only compose metadata, in byte-bounded batches. Never hydrate source trees. */
export async function hydrateMetricInputs(
  records: MetricRecords,
  pins: Map<string, MetricPin>,
  lanes: MetricLane[],
  saves: MetricSave[],
  objects?: MetricObjects,
) {
  const pages = new Map<string, ReturnType<typeof composePageSchema.parse>>();
  const pending = new Map([...pins.values()].map(pin => [pin.sha256, pin]));
  if (objects)
    while (pending.size) {
      const batch = [...pending.values()].slice(0, 8);
      for (const pin of batch) {
        invariant(
          pin.size <= 128 * 1024,
          'EVIDENCE_CHANGED',
          'Metric input page exceeds compose metadata size.',
        );
        pending.delete(pin.sha256);
      }
      const bytes = await objects(batch);
      invariant(bytes.length === batch.length, 'EVIDENCE_CHANGED', 'Metric input batch is incomplete.');
      batch.forEach((pin, i) => {
        const data = bytes[i]!;
        invariant(
          !!data && data.length === pin.size && digest(data) === pin.sha256,
          'EVIDENCE_CHANGED',
          'Metric input page differs from its pin.',
        );
        const page = composePageSchema.parse(JSON.parse(Buffer.from(data).toString('utf8')));
        pages.set(pin.sha256, page);
        if (page.next && !pages.has(page.next.sha256)) pending.set(page.next.sha256, page.next);
      });
      for (const pin of batch) pending.delete(pin.sha256);
    }
  const laneIndex = new Map(lanes.map(lane => [`${lane.id}:${lane.version}`, lane]));
  const saved = new Map<string, string>();
  for (const save of saves) {
    const key = `${save.laneId}:${save.head}`;
    if (!saved.has(key) || save.at < saved.get(key)!) saved.set(key, save.at);
  }
  const resolved = new Map<string, MetricInput[]>();
  for (const pin of pins.values()) {
    if (resolved.has(pin.sha256)) continue;
    const selected: MetricInput[] = [],
      seen = new Set<string>();
    let incomplete = false;
    let next: MetricPin | null = pin;
    while (next) {
      invariant(!seen.has(next.sha256), 'EVIDENCE_CHANGED', 'Metric input pages contain a cycle.');
      seen.add(next.sha256);
      const page = pages.get(next.sha256);
      if (!page) {
        incomplete = true;
        break;
      }
      for (const entry of page.entries)
        if ('laneId' in entry) {
          const lane = laneIndex.get(`${entry.laneId}:${entry.version}`);
          if (!lane) {
            incomplete = true;
            continue;
          }
          selected.push({
            laneId: lane.id,
            intentId: lane.intentId,
            head: entry.head,
            savedAt: saved.get(`${lane.id}:${entry.head}`),
            ...(lane.revert ? { compensating: true } : {}),
          });
        }
      next = page.next;
    }
    resolved.set(pin.sha256, incomplete ? [] : selected);
  }
  const rowIndex = new Map<string, { inputs: MetricInput[] }>([
    ...records.moves.map(row => [`move:${row.id}`, row] as const),
    ...records.runs.map(row => [`run:${row.id}`, row] as const),
    ...records.submissions.map(row => [`submission:${row.id}`, row] as const),
  ]);
  for (const [key, pin] of pins) {
    const row = rowIndex.get(key);
    if (row) row.inputs = resolved.get(pin.sha256) ?? [];
  }
}

export function joinMetricAttempts(
  records: MetricRecords,
  attempts: MetricAttempt[],
  pins: Map<string, MetricPin>,
) {
  const requests = new Map(records.submissions.map(row => [row.entryId, row]));
  const children = new Map(
    attempts.filter(row => row.parentAttemptId).map(row => [row.parentAttemptId!, row]),
  );
  const attemptIndex = new Map(attempts.map(row => [row.id, row]));
  const runs = new Map(records.runs.map(row => [row.id, row]));
  // Requests without attempts (for example a failed composition) still contribute
  // progress, interventions and explicit outcomes, but cannot invent Lane inputs.
  const replaced = new Set(attempts.map(row => row.submissionId));
  records.submissions = records.submissions.filter(row => !replaced.has(row.entryId));
  for (const attempt of attempts) {
    const request = requests.get(attempt.submissionId),
      child = children.get(attempt.id);
    const run = attempt.runId ? runs.get(attempt.runId) : undefined;
    const parent = attempt.parentAttemptId ? attemptIndex.get(attempt.parentAttemptId) : undefined;
    const row = {
      ...request,
      id: attempt.id,
      entryId: attempt.submissionId,
      submissionId: attempt.submissionId,
      attemptId: attempt.id,
      parentAttemptId: attempt.parentAttemptId,
      at: attempt.at,
      inputs: [],
      status: child ? 'superseded' : (request?.status ?? 'unknown'),
      mainRace:
        !!child &&
        child.mainHead !== null &&
        attempt.mainHead !== null &&
        child.mainHead !== attempt.mainHead,
      recheck:
        !!parent &&
        parent.mainHead !== null &&
        attempt.mainHead !== null &&
        parent.mainHead !== attempt.mainHead,
      endedAt: child?.at ?? request?.endedAt ?? run?.endedAt,
      progressAt: request?.progressAt ?? [],
      runIds: attempt.runId ? [attempt.runId] : [],
    };
    records.submissions.push(row);
    if (attempt.inputPin) pins.set(`submission:${attempt.id}`, attempt.inputPin);
  }
}
