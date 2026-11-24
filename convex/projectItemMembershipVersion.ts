// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi

/** The earlier boolean and its partial frontiers predate stamp-preserving purge and lifecycle writers. */
import type { Doc, Id } from './_generated/dataModel';

export const verifiedItemMembership = 'verified-v2';

/** Membership proves head bindings; only a finished mark pass proves the running-work tally. */
export const verifiedRollupMembership = (
  project: Doc<'hostedProjects'>,
  generationId: Id<'projectWorkGenerations'>,
) =>
  project.itemLaneMembership === verifiedItemMembership &&
  project.planLaneMarkCoverage?.generationId === generationId &&
  project.planLaneMarkCoverage.cursor === null;
const repairPrefix = 'repair-v2:';
export const itemMembershipFrontier = (stored: string | true | undefined) =>
  typeof stored === 'string' && stored.startsWith(repairPrefix) ? stored : null;
export const encodeItemMembershipFrontier = (frontier: object) => repairPrefix + JSON.stringify(frontier);
export const decodeItemMembershipFrontier = (frontier: string) =>
  JSON.parse(frontier.slice(repairPrefix.length));
