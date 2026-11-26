// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { digest } from '../dist/hash.js';
import { lineBaseTag } from '../dist/hosted-overlap-evidence.js';
import { moduleSource, moduleUrl } from './convex-module.mjs';

const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));

export const hex = n => digest(`blob-${n}`);
/** A synthetic saved change; `links` adds cross-file symbol facts. */
export const entry = (path, n, links) => ({
  path,
  before: { blob: hex(n), mode: 'file' },
  after: { blob: hex(n + 1), mode: 'file' },
  evidence: {
    baseBlob: hex(n),
    ranges: [{ start: n % 7, end: (n % 7) + 2 }],
    symbols: [`name${n}`],
    ...(links ? { symbolLinks: links } : {}),
  },
  lines: [n % 9, n % 4, lineBaseTag(hex(n))],
});
export const delta = (path, n = 1) => entry(path, n);
export const trackChange = (s, who, paths, intent) =>
  s.transaction(
    'track-change',
    {
      _handler: async ctx => {
        const row = await records.readHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          kind: 'lane',
          key: who.id,
        });
        const current = JSON.parse(row.value);
        await records.writeHostedRecord(ctx, {
          projectId: s.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: current.version,
          record: {
            ...current,
            head: String(current.version + 1).padStart(64, 'e'),
            version: current.version + 1,
            sourceVersion: current.sourceVersion + 1,
          },
          overlap: { baseSequence: 0, intent, changes: paths },
        });
      },
    },
    {},
  );
export const read = async (s, laneId, args, api = overlaps.read) => {
  const wire = await s.transaction('projectHostedOverlaps:read', api, {
    projectId: s.projectId,
    laneId,
    ...args,
  });
  return { wire, reply: JSON.parse(wire), io: s.counts.at(-1) };
};
export const rowOf = (s, laneId) =>
  [...s.tables.projectHostedOverlapLanes.values()].find(row => row.laneId === laneId);
export const bucketRows = (s, laneId) =>
  [...s.tables.projectHostedOverlapChanges.values()].filter(row => row.laneId === laneId);
export const sweep = (count, tag = 'sweep') =>
  Array.from({ length: count }, (_, i) => delta(`${tag}/file-${i}.txt`, i));
export const readyLanding = s =>
  s.insert('projectHostedLandingRequests', {
    projectId: s.projectId,
    channel: 'main',
    submissionId: 'ready-peer',
    operationId: 'ready-peer',
    attemptId: 'ready-attempt',
    actor: 'owner',
    sequence: 1,
    runnable: true,
    phase: 'ready',
    runId: 'passed-run',
    value: '{}',
  });

// Reuse the wire handler, with the three original database selections restored. This oracle
// exercises the same saved records and indexes and also works against the already unpruned main.
export async function unprunedOverlapQuery() {
  let source = moduleSource('../convex/projectHostedOverlaps.ts');
  if (!source.includes('function dormantHeadsComplete(')) return overlaps.read;
  const replace = (pattern, original) => {
    assert.match(source, pattern, 'refresh the old-path oracle after moving a selection');
    source = source.replace(pattern, original);
  };
  replace(/const focusPath = [^;]+;/, 'const focusPath = undefined;');
  replace(
    /const complete = peers\.length <= 50[^;]+dormantHeadsComplete\(ctx, projectId, cutoff, unmatched, sawOtherOpen\)\);/,
    `const dormantLanes =
      cutoff !== null && unmatched.length ? await dormantHostedPresence(ctx, projectId, cutoff) : null;
    const complete = peers.length <= 50 && headers.length <= 50 &&
      unmatched.every(header => dormantLanes?.has(header.key));`,
  );
  replace(
    /const peerChanges = async \(peer\) => \{[\s\S]+?\n\s*\};/,
    `const peerChanges = async peer => {
      if (!peer.open || peer.laneId === laneId) return '[]';
      if (path) return overlapLaneEntries(ctx, peer, new Set([path]));
      if (detail || scope?.length || (mineFacts && peer.symbolFacts)) return overlapLaneChanges(ctx, peer);
      return overlapLaneEntries(ctx, peer, mineSaved);
    };`,
  );
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  return (await import(url)).read;
}
