// SPDX-License-Identifier: Apache-2.0
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
      'Retry the original immutable check report upload.',
    );
  } else invariant(response.ok, 'SOURCE_UNAVAILABLE', 'The check report upload is unavailable.');
  return pin;
}
