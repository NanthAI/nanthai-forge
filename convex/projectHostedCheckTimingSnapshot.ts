// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { timingHistoryLimits } from '../scripts/test-shards.mjs';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { convexFetch, networkTimeout } from './networkFetch';
import { readExactObject } from './projectR2ExactRead';
import { presignGet, presignPut, r2Config } from './r2';
import { readR2Object } from './r2Operations';

type RunAddress = { projectId: string; runId: string };
type Pin = { sha256: string; size: number };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const timingSnapshotKey = ({ projectId, runId }: RunAddress) =>
  `v1/p/${projectId}/checks/${runId}/selection/timing-history.json`;
const messages = {
  failed: 'The original check timing history is unavailable.',
  exceeds: 'Check timing history exceeds its retained size.',
};

/** Bind the planner to the first timing session for this run. A lost response or
 * concurrent request gets the same bytes even if another run has since trained history. */
export async function retainCheckTimingSnapshot(input: RunAddress, timingHistory: string) {
  const config = r2Config(),
    key = timingSnapshotKey(input),
    proposed = encoder.encode(timingHistory);
  invariant(proposed.length <= timingHistoryLimits.bytes, 'R2_VERIFY_FAILED', messages.exceeds);
  const sha256 = digest(proposed);
  const target = await presignPut(config, key, { digest: sha256, size: proposed.length });
  const response = await convexFetch(target.url, {
    method: 'PUT',
    headers: target.headers,
    body: proposed,
    redirect: 'error',
    signal: networkTimeout(20_000),
  });
  await response.body?.cancel().catch(() => {});
  invariant(response.ok || response.status === 412, 'R2_UPLOAD_FAILED', messages.failed);
  const bytes =
    response.status === 412
      ? await readExactObject(
          { url: await presignGet(config, key), size: timingHistoryLimits.bytes },
          messages,
        )
      : proposed;
  return {
    timingHistory: response.status === 412 ? decoder.decode(bytes) : timingHistory,
    timingHistoryPin: { sha256: response.status === 412 ? digest(bytes) : sha256, size: bytes.length },
  };
}

export async function readCheckTimingSnapshot(input: RunAddress, pin: Pin) {
  invariant(pin.size <= timingHistoryLimits.bytes, 'EVIDENCE_CHANGED', messages.exceeds);
  const url = await presignGet(r2Config(), timingSnapshotKey(input));
  const bytes = await readExactObject({ url, size: pin.size }, messages, true);
  if (!bytes) return null;
  invariant(
    bytes.length === pin.size && digest(bytes) === pin.sha256,
    'EVIDENCE_CHANGED',
    'Check timing history differs from its retained pin.',
  );
  return decoder.decode(bytes);
}

/** Older runners cannot echo a digest. Their plan records the run's immutable
 * generation; retrieve it on demand, with no additional landing-path read. */
export async function findCheckTimingSnapshot(input: RunAddress) {
  const object = await readR2Object(r2Config(), timingSnapshotKey(input), timingHistoryLimits.bytes);
  return object
    ? {
        timingHistory: decoder.decode(object.bytes),
        timingHistoryPin: { sha256: digest(object.bytes), size: object.bytes.length },
      }
    : null;
}
