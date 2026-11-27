// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';

// Keep the packer independent of the database handlers it calls by reference.
export const capsuleRunArgs = {
  projectId: v.id('hostedProjects'),
  submissionId: v.string(),
  dueAt: v.number(),
};
export const capsuleFinishKinds = [
  'projectHostedLandingRequests',
  'projectHostedFinishes',
  'projectHostedFinishOwners',
  'projectHostedLandingPeers',
  'projectHostedLandingDesired',
];
/** One capture, publish or removal call carries at most this many row bytes. */
export const capsulePageBytes = 128 * 1024;
export const capsulePageRows = 64;
export const capsuleRefsPage = 16;

export const landingCapsulePointer = v.object({
  protocol: v.literal(1),
  sha256: v.string(),
  size: v.number(),
  rawSize: v.number(),
  tablesDigest: v.optional(v.string()),
  version: v.number(),
  tables: v.string(),
  summary: v.optional(v.string()),
});
