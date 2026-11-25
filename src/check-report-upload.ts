// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './state/hash.js';
import { invariant } from './errors.js';
import type { HostedCheckRun } from './hosted-check.js';
export type ReportUploadTarget = { put: { url: string; headers: Record<string, string> }; get: string };
/** A reply already needed by the runner carries this fenced, immutable upload target. */
export async function uploadCheckReports(
  target: ReportUploadTarget,
  reports: NonNullable<HostedCheckRun['contractReports']>,
  request: typeof fetch,
) {
  const bytes = new TextEncoder().encode(canonicalPayload(reports));
  return uploadCheckBytes(target, bytes, request);
}
export async function uploadCheckBytes(
  target: ReportUploadTarget,
  bytes: Uint8Array<ArrayBuffer>,
  request: typeof fetch,
) {
  const pin = digest(bytes);
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await request(target.put.url, { method: 'PUT', headers: target.put.headers, body: bytes });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
  if (response.status === 412) {
    const original = await request(target.get);
    invariant(
      original.ok && digest(new Uint8Array(await original.arrayBuffer())) === pin,
      'EVIDENCE_CHANGED',
      'Retry the original immutable check evidence upload.',
    );
  } else invariant(response.ok, 'SOURCE_UNAVAILABLE', 'The check evidence upload is unavailable.');
  return pin;
}
