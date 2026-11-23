// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readFileSync } from 'node:fs';
import { makeFunctionReference } from 'convex/server';

/**
 * Cold read of a packed landing's history (Item b149b16b): the capsule-aware status and attempts
 * queries, then `projectLandingCapsuleRead:history` when the query returns a capsule marker. One
 * sample is the client wall time of both calls. Read-only: queries and the read-only history action
 * against the Lane checkout's own deployment. Landings that are not packed are counted, not timed.
 */
export async function capsuleColdReadSamples(laneRoot, submissionsFile, distDirectory = '../../dist') {
  const dist = new URL(`${distDirectory}/`, import.meta.url);
  const { hostedAgentAddress } = await import(new URL('hosted-agent-address.js', dist));
  const { ConvexExchange } = await import(new URL('exchange-client.js', dist));
  const address = hostedAgentAddress(laneRoot, {});
  if (!address) throw new Error('PERF_NO_HOSTED_ADDRESS');
  const client = new ConvexExchange(address.url, process.env.FORGE_AUTH_TOKEN, address.projectId, '', null)
    .client;
  const submissions = readFileSync(submissionsFile, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[0-9a-f-]{36}$/.test(line));
  const samples = [];
  let warm = 0;
  for (const submissionId of submissions)
    for (const [name, extra] of [
      ['projectHostedLanding:status', { priorityInfo: 1 }],
      ['projectHostedLanding:attempts', { cursor: null }],
    ]) {
      const args = { projectId: address.projectId, submissionId, capsuleProtocol: 1, ...extra };
      const started = performance.now();
      const first = await client.query(makeFunctionReference(name), args);
      const marker = JSON.parse(typeof first === 'string' ? first : JSON.stringify(first));
      if (!marker?.landingCapsule) {
        warm++;
        continue;
      }
      const { projectId: _project, ...request } = args;
      const reply = await client.action(makeFunctionReference('projectLandingCapsuleRead:history'), {
        projectId: address.projectId,
        query: name,
        request: JSON.stringify(request),
      });
      // A failed read throws (the action reports errors), so it is never a fast sample.
      if (reply === null) throw new Error('PERF_CAPSULE_READ_FAILED');
      samples.push({ durationMs: Math.round(performance.now() - started), query: name });
    }
  return { samples, notPacked: warm };
}
